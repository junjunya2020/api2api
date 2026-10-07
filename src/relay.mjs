/**
 * 转发核心 —— 也是整个服务的心脏。
 *
 * 语义（用户要求）：
 *   「在所有渠道路由成功马上返回」
 *   → 按 (渠道优先级 × Key 权重) 依次尝试，**首个成功立即返回**；
 *     失败不是"整个请求失败"，而是"换下一个候选继续"；
 *     全部耗尽才返回错误。
 *
 * 关键约束：**不做协议转换**。
 *   请求体除 model 字段外**字节级原样透传**；成功响应（含流式）也原样 pipe。
 *   适配器只在非 2xx 时读一次 body 用于错误分类。
 */
import { Readable } from 'node:stream';
import { getAdapter } from './adapters/index.mjs';
import { resolveCandidates } from './db/aliases.mjs';
import { getKeySecret, availableKeyCount, enabledKeyCount } from './db/keys.mjs';
import {
  pickKey, applyFailure, applySuccess,
  channelBudget, modelGate, applyModelSuccess, applyModelFailure, ModelState,
} from './scheduler/index.mjs';
import * as rate from './scheduler/rate.mjs';
import { ErrClass, ApiError, classifyByStatus } from './util/errors.mjs';
import { logRequest } from './db/logs.mjs';
import { fastModelsOnly } from './db/settings.mjs';
import { isFastOnlyChannel, isFastModel } from './db/fast-models.mjs';
import config from './config.mjs';
import log from './util/log.mjs';

/** 读取完整请求体（只在入口读一次，之后复用） */
export async function readBody(req, limit = config.maxBodyBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new ApiError(413, `请求体超过上限 ${limit} 字节`, { type: 'invalid_request_error' });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * 主转发流程。
 *
 * @param {object} p
 * @param {string} p.publicModel  下游请求的 model（对外名）
 * @param {Buffer} p.rawBody      原始请求体
 * @param {string} p.pathTail     上游路径尾部（默认 'chat/completions'）
 * @param {(env)=>void} p.onStream 可选：流式已建立时的回调
 * @returns {Promise<{response:Response, meta:object}>} 首个成功的上游响应
 */
export async function relay({ publicModel, rawBody, pathTail = 'chat/completions', tried = new Set() }) {
  const candidates = resolveCandidates(publicModel);
  if (!candidates.length) {
    throw new ApiError(404, `没有可用的渠道来服务模型 "${publicModel}"`, {
      code: 'model_not_found', type: 'invalid_request_error', errClass: ErrClass.CONFIG_FAULT,
    });
  }

  // 解析请求体（为了改 model 字段；其余原样保留）
  const bodyObj = safeParseJson(rawBody);
  const chain = [];
  let attempts = 0;
  let lastVerdict = null;
  let lastChannel = null;
  let lastKey = null;

  // 渠道严格按优先级（sort_order）分层遍历 —— 用户明确要求的语义：
  //   商汤 > 书生 > OpenRouter。
  //   同一个渠道内**先把所有可用 Key 试完**（都死了）才降级到下一渠道。
  //   只有某模型只在低优先级渠道有时，才会去那个池子。
  //
  // resolveCandidates 已按 rank 排序（映射命中 > 目录命中 > 其他），
  // 这里再按渠道优先级稳定分组，保证同渠道的候选聚在一起、按渠道顺序推进。
  const sorted = orderByChannelPriority(candidates);

  // ⭐ 预先剔掉**一把启用 Key 都没有**的渠道（2026-10-08）。
  //
  // 为什么必须在最前：一个从未配置 Key 的渠道（比如刚内置、还没绑 Key 的 modelscope）
  // 会以 rank 3/catalogKnown=false（= "未知 ≠ 没有"）的身份**赖在候选里**，
  // 从而让下面「目录全都确认没有 → 回退全试」的兜底判定失效 ——
  // 因为它让 filtered 非空，ordered0 不再回退，请求被凭空 503。
  // 而它实际上一把 Key 都没有，根本不可能服务这个请求，留着只会占位。
  //
  // ⚠️ 必须用 `enabledKeyCount > 0` 而不是 `availableKeyCount > 0`：
  //    Key 全在冷却/禁用（但池子非空）的渠道要保留 —— 那种情况该返回 429/503，
  //    而不是被当成"不存在"而跳过（那会误报 404）。
  const withKeys = sorted.filter((c) => c.channelId && enabledKeyCount(c.channelId) > 0);
  const noKeyChannels = sorted.length - withKeys.length;
  if (noKeyChannels > 0) {
    log.debug(`[relay] 跳过 ${noKeyChannels} 个未配置任何 Key 的渠道`);
  }
  const candidates0 = withKeys.length ? withKeys : sorted;

  // ⭐「只接快速模型」运行时闸门（用户 2026-10-07）—— **必须先于目录"确定没有"判定**。
  //   拉目录时已过滤，这里再兜一层：若目录还是老的（残留慢模型），也**不能把请求
  //   打到"永不返回"的模型上**（NVIDIA 目录 80 个里多数是挂死的）。
  //   只影响「快速渠道」（目前 nvidia）；商汤/书生/OpenRouter 原样放行。
  //
  //   ⚠️ 顺序很重要：如果放在下面那步**之后**，会把"目录全确认没有 → 回退全试"
  //      的兜底挡掉，导致本该真打一次上游的请求被凭空 404。
  let pre = candidates0;
  if (fastModelsOnly()) {
    pre = candidates0.filter(
      (c) => !(isFastOnlyChannel(c.channelName) && !isFastModel(c.channelName, c.upstreamName)),
    );
    // 全部候选都被"快速白名单"挡掉 → 明确拒绝，而不是退回去打挂死模型
    if (!pre.length && candidates0.length) {
      logRequest({
        model: null, publicModel, channelId: null, keyUuid: null,
        status: 404, errClass: ErrClass.CONFIG_FAULT, upstreamTrace: null,
        latencyMs: null, attempts: 0, chain: null,
      });
      throw new ApiError(404, `模型 "${publicModel}" 不在「快速模型」白名单内（可在设置页关闭该开关）`, {
        code: 'model_not_found', type: 'invalid_request_error',
        errClass: ErrClass.CONFIG_FAULT, logged: true,
      });
    }
  }

  // 目录信息可用时，**明确"拉过目录且没有这个模型"的渠道（rank 3 且 catalogKnown）不必真去打上游** ——
  // 铁定 404，只是白耗一次真实请求 + 一轮超时。
  //
  // 关键区分（不能搞混，否则会误杀）：
  //   · rank 3 + catalogKnown=true  → 拉过目录，名单里确实没有 → 跳过，省一次请求
  //   · rank 3 + catalogKnown=false → **从没拉过目录**，属于"未知" → 必须照试！
  //     否则新加的渠道（还没拉目录）会被永久跳过，明明能用却调不通。
  //
  // 实例（真 Key 实测）：`gemma-4-31b-it` 只在 OpenRouter，商汤/书生目录里都没有
  //   → 跳过这两家，直接打 OpenRouter，省掉两次必败的上游请求。
  const isDefinitelyAbsent = (c) => (c.rank ?? 3) === 3 && c.catalogKnown === true;
  const filtered = pre.filter((c) => !isDefinitelyAbsent(c));
  // 兜底：全都"确定没有"时不能直接放弃 —— 目录可能过期（上游刚上新模型），
  // 宁可多打一次上游拿真实 404，也不要凭空报"没有渠道可用"。
  const ordered0 = filtered.length ? filtered : pre;
  const skippedByCatalog = pre.length - ordered0.length;
  if (skippedByCatalog > 0) {
    log.debug(`[relay] 按上游目录跳过 ${skippedByCatalog} 个确认没有该模型的渠道`);
  }

  // ⭐ 模型级闸门（2026-10-07）—— **只改"试几次"，不改"先试谁"**。
  //
  //   ⚠️ 关键设计约束：**渠道优先级（sort_order）是主序，绝不能被模型健康度打乱**。
  //      这是用户反复强调的铁律（「商汤 > 书生 > OpenRouter」）。
  //      所以这里**保持 ordered0 的渠道顺序**，模型健康度只决定该渠道允许试几次：
  //
  //   NORMAL      → 用渠道熔断预算（可用 Key 数的 1/4，上限 maxAttemptsPerChannel）
  //   DEGRADED    → 只试 **1 次**（快速证伪；不占熔断预算，烧不到池子）
  //   UNAVAILABLE → **跳过**该渠道；仅当**所有**候选都被熔断时才兜底试 1 次
  //
  //   效果：坏模型在商汤只花 1 次尝试就落到书生，书生的池子完全不受影响。
  const gated = ordered0.map((c) => ({
    cand: c,
    gate: c.channelId
      ? modelGate(c.channelId, c.upstreamName, { channelName: c.channelName })
      : { allow: true, attempts: 0, state: ModelState.NORMAL, reason: null, fromRule: false },
  }));

  // 只剔掉"确定不可用"的，其余**原样保持渠道优先级顺序**
  let ordered = gated.filter((g) => g.gate.allow);

  if (!ordered.length) {
    if (gated.length) {
      // 全都被熔断 → 兜底：给**优先级最高**的那个一次机会（attempts=1），
      // 否则一个刚被熔断的模型会让整个请求立刻失败。
      log.warn(`[relay] 模型 ${publicModel} 在所有候选渠道均被熔断，兜底试一次`);
      const first = gated[0];
      ordered = [{ ...first, gate: { ...first.gate, allow: true, attempts: 1 } }];
    } else {
      logRequest({
        model: null, publicModel, channelId: null, keyUuid: null,
        status: 503, errClass: ErrClass.NO_KEY, upstreamTrace: null,
        latencyMs: null, attempts: 0, chain: null,
      });
      throw new ApiError(503, `模型 "${publicModel}" 的候选渠道均不可用（全部被熔断或没有可用 Key）`, {
        code: 'no_available_channel', type: 'insufficient_quota',
        errClass: ErrClass.NO_KEY, retryAfterMs: config.downstreamRetryAfterMs, logged: true,
      });
    }
  }

  for (const { cand, gate } of ordered) {
    if (attempts >= config.maxAttempts) {
      log.warn(`[relay] 达到全局最大尝试次数 ${config.maxAttempts}，停止`);
      break;
    }
    if (!cand.channelId) continue;

    const adapter = getAdapter(cand.adapter);
    const url = `${cand.baseUrl.replace(/\/+$/, '')}/${pathTail}`;

    // ⭐ 熔断预算：本次在该渠道最多试几把 Key。
    //    分母用「该渠道 + 该模型下**当前可用**的 Key 数」——
    //    池子被打掉一批时分母跟着变小，才不会把剩下那几把也烧掉。
    //    用户要求：「最多尝试四分之一的号，不然一直切换 key 重试全死了」。
    const available = availableKeyCount(cand.channelId, cand.upstreamName);
    const budget = channelBudget(available || enabledKeyCount(cand.channelId) || 1);
    // 模型降级 / 兜底场景只允许试 1 次（快速证伪，别占用预算）
    const perChannelLimit = gate.attempts > 0
      ? Math.min(gate.attempts, budget)
      : budget;

    if (gate.state !== ModelState.NORMAL) {
      log.debug(`[relay] ${cand.channelName}/${cand.upstreamName} 模型健康度=${gate.state}（${gate.reason}），限试 ${perChannelLimit} 次`);
    }

    let channelTries = 0;
    let skipChannel = false;

    for (;;) {
      if (attempts >= config.maxAttempts) break;
      if (channelTries >= perChannelLimit) {
        log.debug(`[relay] 渠道 ${cand.channelName} 已达熔断预算 ${perChannelLimit}（可用 ${available} 把），降级下一渠道`);
        chain.push({
          channel: cand.channelName, channelDisplay: cand.channelDisplay,
          key: null, upstreamModel: cand.upstreamName,
          note: `本渠道熔断预算 ${perChannelLimit} 已用尽（可用 ${available} 把 Key）`,
        });
        break;
      }

      const key = pickKey(cand.channelId, cand.upstreamName, tried);
      if (!key) {
        chain.push({
          channel: cand.channelName, channelDisplay: cand.channelDisplay,
          key: null, upstreamModel: cand.upstreamName,
          note: '渠道内无可选 Key',
        });
        break; // 该渠道耗尽 → 落到下一个渠道
      }

      const secret = getKeySecret(key.uuid);
      if (!secret) {
        chain.push({
          channel: cand.channelName, channelDisplay: cand.channelDisplay,
          key: key.uuid, upstreamModel: cand.upstreamName, note: '密钥解密失败',
        });
        tried.add(key.uuid);
        continue;
      }

      attempts++;
      channelTries++;
      tried.add(key.uuid);

      // 记一次 RPM 命中 —— 只有**真的要发上游请求**才算，
      // 管理操作/打包复制等不计入每 Key 每分钟配额。
      rate.recordHit(key.uuid);

      // 构造上游请求体：**只改 model 字段**
      const upstreamBody = bodyObj
        ? JSON.stringify({ ...bodyObj, model: cand.upstreamName })
        : rawBody;

      const upstreamHeaders = adapter.headers(secret);
      // 透传下游的部分语义头（如果有）
      const t0 = Date.now();

      let res;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: upstreamHeaders,
          body: upstreamBody,
          signal: AbortSignal.timeout(config.upstreamTimeoutMs),
        });
      } catch (e) {
        // 连接层失败 → transient，换下一个
        const rec = {
          channel: cand.channelName, channelDisplay: cand.channelDisplay,
          key: key.uuid, upstreamModel: cand.upstreamName,
          status: null, errClass: ErrClass.TRANSIENT, latencyMs: Date.now() - t0,
          error: `连接失败: ${e.message}`,
        };
        chain.push(rec);
        applyFailure(key.uuid, cand.upstreamName, ErrClass.TRANSIENT, e.message);
        // ⭐ 连接失败也计入模型健康度（连续抖动说明这个模型不稳）
        applyModelFailure(cand.channelId, cand.upstreamName, ErrClass.TRANSIENT, e.message, cand.channelName);
        lastVerdict = { errClass: ErrClass.TRANSIENT, message: e.message, traceId: null };
        lastChannel = cand; lastKey = key.uuid;
        continue;
      }

      const latencyMs = Date.now() - t0;

      // ✅ 成功：立即返回，交给上层 pipe（流式也不缓冲）
      if (res.status >= 200 && res.status < 300) {
        chain.push({
          channel: cand.channelName, channelDisplay: cand.channelDisplay,
          key: key.uuid, upstreamModel: cand.upstreamName,
          status: res.status, errClass: ErrClass.OK, latencyMs,
        });
        applySuccess(key.uuid, cand.upstreamName);
        // ⭐ 模型健康度立刻回 NORMAL —— 成功即恢复健康
        applyModelSuccess(cand.channelId, cand.upstreamName, cand.channelName);

        return {
          response: res,
          meta: {
            channel: cand, keyUuid: key.uuid, status: res.status,
            latencyMs, attempts, chain,
            errClass: ErrClass.OK,
            modelState: gate.state,
          },
        };
      }

      // ❌ 非 2xx：读 body 做错误分类（这是唯一需要读 body 的场景）
      let text = '';
      try { text = await res.text(); } catch { /* ignore */ }
      const verdict = adapter.classify(res.status, res.headers, text);

      chain.push({
        channel: cand.channelName, channelDisplay: cand.channelDisplay,
        key: key.uuid, upstreamModel: cand.upstreamName,
        status: res.status, errClass: verdict.errClass, latencyMs,
        code: verdict.code ?? null, upstreamTrace: verdict.traceId ?? null,
        error: verdict.message?.slice(0, 300),
      });
      lastVerdict = verdict;
      lastChannel = cand;
      lastKey = key.uuid;

      // ⭐ 模型健康度归因（与 Key 动作**分开**）：
      //   只有"这个模型不行"类错误才计入 —— REQUEST_FAULT 是请求体问题，不算。
      //   注意计量在**失败时也要更新 last_used_at**，Key 列表才能显示"最后调用的模型"。
      const mh = applyModelFailure(cand.channelId, cand.upstreamName, verdict.errClass, verdict.message, cand.channelName);

      // 分类驱动动作（Key 侧）
      const act = applyFailure(key.uuid, cand.upstreamName, verdict.errClass, verdict.message);

      // ① 请求本身的问题：换谁都白搭 → 立即把上游错误还给客户端
      if (!act.retry) {
        log.info(`[relay] 不可重试错误 ${verdict.errClass} (${res.status})，直接返回`);
        logRequest({
          model: cand.upstreamName, publicModel, channelId: cand.channelId, keyUuid: key.uuid,
          status: res.status, errClass: verdict.errClass, upstreamTrace: verdict.traceId,
          latencyMs, attempts, chain,
        });
        throw new ApiError(
          normalizeHttpStatus(res.status, verdict.errClass),
          verdict.message || `上游返回 ${res.status}`,
          {
            code: verdict.code, type: typeForClass(verdict.errClass),
            traceId: verdict.traceId, errClass: verdict.errClass, logged: true,
          },
        );
      }

      // ② 「该渠道没有这个模型」—— 渠道内换 Key 结果一样，直接落下一渠道。
      //    这是跨渠道能力的核心：glm-5.3 只在书生有，商汤 404 时必须继续往下走。
      //
      //    ⚠️ CONFIG_FAULT **不计入**模型健康度（上游事实，不是"模型坏了"），
      //       所以这里不能因为 mh 降级就提前放弃 —— 换渠道才是正解。
      if (act.action === 'skip_channel') {
        log.debug(`[relay] ${cand.channelName} 整体跳过（${verdict.errClass}：${verdict.message}），换下一渠道`);
        skipChannel = true;
        break;
      }

      log.debug(`[relay] ${cand.channelName}/${key.uuid} 失败(${verdict.errClass})${mh ? ` 模型健康度→${mh.state}` : ''}，换下一个候选`);
      // ③ 继续内层循环：换 Key
    }
    if (skipChannel) continue;
  }

  // 全部耗尽：状态码要看**整条链**，而不是只看最后一个错误。
  //
  // 实例（真 Key 实测）：kimi-k3 在商汤是 429 限流（可恢复），在书生是
  // "不支持该模型"。若只取最后一条 → 404，客户端会以为模型永久不存在而放弃；
  // 但真相是"稍后重试可能成功"。因此只要链上出现过可恢复错误，就按可恢复返回。
  //
  // ⚠️ 消息必须与状态码**同源**：曾经出现"429 + 不支持该模型"这种自相矛盾的提示，
  //    因为状态码取自主导错误、消息却取了最后一条错误。现在两者都来自主导错误。
  const dominant = pickDominantError(chain);
  const errClass = dominant?.errClass ?? lastVerdict?.errClass ?? ErrClass.NO_KEY;
  const status = statusForExhausted(errClass);
  const retryAfterMs = retryForExhausted(errClass);

  // 该分类的第一条记录，携带与之匹配的消息 / code / traceId
  const dominantRec = chain.find((c) => c.errClass === errClass) ?? null;
  const message = dominantRec?.error
    || lastVerdict?.message
    || `所有候选渠道均已耗尽（尝试 ${attempts} 次）`;
  // code 也必须与状态码同源，否则会出现"429 + model_not_available"这种错配
  const code = dominantRec?.code ?? lastVerdict?.code ?? 'all_exhausted';
  const traceId = dominantRec?.upstreamTrace ?? lastVerdict?.traceId ?? null;

  logRequest({
    model: null, publicModel,
    channelId: lastChannel?.channelId ?? null, keyUuid: lastKey,
    status, errClass, upstreamTrace: traceId,
    latencyMs: null, attempts, chain,
  });

  throw new ApiError(status, message, {
    code,
    type: typeForClass(errClass),
    traceId,
    errClass,
    retryAfterMs,
    logged: true,
  });
}

/**
 * 候选排序 —— 决定"先试哪个渠道的哪把 Key"。
 *
 * 用户要求的语义（2026-10-06）：
 *   「商汤 > 书生 > OpenRouter。一个模型商汤书生都有，
 *     就先把商汤的所有 Key 都试死了，再开始遍历书生 / OpenRouter。
 *     只有书生有的时候，那没办法，只能去书生池搞。」
 *
 * 即：**渠道优先级（sort_order 小者优先）是主序**，分层推进。
 *
 * 但有两个例外必须打破主序，否则会白跑（每一次白跑都是一个真实的上游请求）：
 *
 *   ① rank 0（该渠道有**专属映射**）= 用户明确指定了"这个名字在这个渠道上对应谁"，
 *      是精准配置，必须优先于"渠道顺序"。
 *      实例：`Deepseek-V4-Pro` 商汤映射 → `deepseek-v4-pro`，书生映射 → `deepseek-v4-pro-0813`。
 *      两者都是 rank 0，此时按渠道优先级排（商汤在前）—— 正确。
 *
 *   ② rank 3（该渠道既无映射、**目录里也确认没有**这个模型）→ 铁定 404，
 *      排到最后。这是"目录里有的渠道优先"的落地。
 *
 * 综合排序键：[rank 分层, 渠道 sort_order]。
 * rank 0/1 的候选天然在层内按渠道优先级排 —— 与用户要求一致。
 */
function orderByChannelPriority(candidates) {
  return [...candidates].sort((a, b) => {
    // 先按"是否确定能服务这个模型"分层：
    //   rank 0/1（有映射，确定对口）→ 第 0 层
    //   rank 2  （目录命中，大概率对口）→ 第 1 层
    //   rank 3  （目录确认没有，铁定失败）→ 第 2 层
    const layer = (c) => (c.rank <= 1 ? 0 : c.rank === 2 ? 1 : 2);
    const la = layer(a);
    const lb = layer(b);
    if (la !== lb) return la - lb;
    // 同层内严格按渠道优先级（sort_order 小 → 先试）
    const sa = a.sortOrder ?? 0;
    const sb = b.sortOrder ?? 0;
    if (sa !== sb) return sa - sb;
    // 同渠道内按映射 priority 降序（高优先级的映射先试）
    return (b.priority ?? 0) - (a.priority ?? 0);
  });
}

/**
 * 从整条链的错误记录里挑出"最该告诉客户端"的那条。
 * 优先级：可恢复（限流/瞬时）> 认证 > 模型不存在 > 其他。
 * 理由：可恢复错误意味着"稍后重试可能成功"，优先级必须高于"永久失败"类，
 *       否则客户端会对一个其实还能救的模型彻底放弃。
 *
 * @param {Array<{errClass?:string, error?:string}>} chain
 * @returns {{errClass:string, error?:string}|null} 主导错误对应的链记录
 */
function pickDominantError(chain) {
  const rank = [
    ErrClass.QUOTA,        // 429：配额/限流，稍后必可重试
    ErrClass.TRANSIENT,    // 5xx：上游抽风，稍后可重试
    ErrClass.AUTH,         // 401：Key 全废
    ErrClass.MODEL_UNAVAILABLE, // 被我们主动熔断的模型（可手动重置恢复）
    ErrClass.CONFIG_FAULT, // 404：模型确实哪都没有
    ErrClass.NO_KEY,       // 无 Key 可用
    ErrClass.REQUEST_FAULT,
  ];
  for (const cls of rank) {
    const rec = chain.find((c) => c.errClass === cls);
    if (rec) return rec;
  }
  return null;
}

/** 全部候选耗尽时的 HTTP 状态：把最后一个错误如实反映给客户端 */
function statusForExhausted(errClass) {
  switch (errClass) {
    case ErrClass.QUOTA: return 429;
    case ErrClass.AUTH: return 401;        // 所有 Key 都无效 —— 重试没用，别给 503 骗客户端重试
    case ErrClass.CONFIG_FAULT: return 404; // 映射配错
    case ErrClass.REQUEST_FAULT: return 400;
    case ErrClass.NO_KEY: return 503;
    // 被熔断的模型：对下游语义就是"暂时不可用，稍后可能恢复"（24h 后自动观察）
    case ErrClass.MODEL_UNAVAILABLE: return 503;
    default: return 503;                    // TRANSIENT：确实是可恢复的服务不可用
  }
}

/** 是否值得告诉客户端"稍后重试"
 *  注意用 downstreamRetryAfterMs（20 秒级）而非 cooldownBaseMs（1 秒级）：
 *  1 秒会让客户端立刻重试、立刻再被限流，反而加重上游压力。 */
function retryForExhausted(errClass) {
  if (errClass === ErrClass.QUOTA || errClass === ErrClass.TRANSIENT
    || errClass === ErrClass.NO_KEY || errClass === ErrClass.MODEL_UNAVAILABLE) {
    return config.downstreamRetryAfterMs;
  }
  return null;
}

/** 把上游流式响应 pipe 给下游。返回首字节耗时 */
export async function pipeResponse(res, nodeRes) {
  nodeRes.writeHead(res.status, headersToObject(res.headers));

  if (!res.body) {
    nodeRes.end();
    return { ttfbMs: 0 };
  }

  const t0 = Date.now();
  let ttfb = null;
  const src = Readable.fromWeb(res.body);
  src.on('data', () => {
    if (ttfb === null) ttfb = Date.now() - t0;
  });

  await new Promise((resolve, reject) => {
    src.on('error', reject);
    nodeRes.on('error', reject);
    nodeRes.on('close', resolve);
    src.pipe(nodeRes);
    src.on('end', resolve);
  });

  return { ttfbMs: ttfb ?? Date.now() - t0 };
}

/** 非流式：把上游 JSON 原样回给下游 */
export async function passJson(res, nodeRes) {
  const text = await res.text();
  const headers = headersToObject(res.headers);
  nodeRes.writeHead(res.status, headers);
  nodeRes.end(text);
  return { ttfbMs: null };
}

function headersToObject(h) {
  const out = {};
  for (const [k, v] of h.entries()) {
    const lk = k.toLowerCase();
    // 这些头由我们的 http server 自己管理，不要透传
    if (lk === 'content-length' || lk === 'content-encoding' || lk === 'transfer-encoding') continue;
    out[k] = v;
  }
  return out;
}

function safeParseJson(buf) {
  try {
    const s = buf.toString('utf8');
    if (!s || !s.trim()) return null;
    const o = JSON.parse(s);
    return (o && typeof o === 'object' && !Array.isArray(o)) ? o : null;
  } catch {
    return null;
  }
}

/** 上游 HTTP 状态 + 归类 → 给下游的状态码 */
function normalizeHttpStatus(upstreamStatus, errClass) {
  switch (errClass) {
    case ErrClass.AUTH: return upstreamStatus === 403 ? 403 : 401;
    case ErrClass.QUOTA: return 429;
    case ErrClass.REQUEST_FAULT: return upstreamStatus >= 400 && upstreamStatus < 500 ? upstreamStatus : 400;
    case ErrClass.CONFIG_FAULT: return upstreamStatus === 404 ? 404 : 400;
    case ErrClass.TRANSIENT: return 502;
    default: return upstreamStatus >= 400 ? upstreamStatus : 500;
  }
}

function typeForClass(errClass) {
  switch (errClass) {
    case ErrClass.AUTH: return 'authentication_error';
    case ErrClass.QUOTA: return 'rate_limit_error';
    case ErrClass.REQUEST_FAULT: return 'invalid_request_error';
    case ErrClass.CONFIG_FAULT: return 'invalid_request_error';
    case ErrClass.TRANSIENT: return 'api_error';
    case ErrClass.NO_KEY: return 'insufficient_quota';
    case ErrClass.MODEL_UNAVAILABLE: return 'insufficient_quota';
    default: return 'api_error';
  }
}

export { classifyByStatus, typeForClass, normalizeHttpStatus };
export default { relay, readBody, pipeResponse, passJson };
