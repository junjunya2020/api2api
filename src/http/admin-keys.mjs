/**
 * 管理 API · Key 相关。
 *
 *   POST   /api/keys              加 Key（渠道 + key + uuid + 名称可空 + owner 可空）
 *   POST   /api/keys/bulk         批量加
 *   GET    /api/keys              列 Key（可按 channel / owner 过滤；永不返回明文）
 *   GET    /api/keys/:uuid        单个
 *   PATCH  /api/keys/:uuid        改名称/优先级/权重/启停
 *   DELETE /api/keys/:uuid        删 Key
 *   POST   /api/keys/:uuid/reset  重置调度状态
 *   POST   /api/keys/check        测活（scope=channel | model）
 *   POST   /api/keys/check-all    便捷：测指定渠道全部 Key
 *   POST   /api/keys/verify       验活一把还没入库的 Key（「发 hi 等首字」）
 *   POST   /api/keys/:uuid/verify 验活一把已入库的 Key
 *   GET    /api/keys/health       按 owner 汇总「调用过但零成功」的 Key（桥用）
 *   GET    /api/keys/owners       列出所有绑过 Key 的 owner（桥的后台巡检用）
 *
 * owner 语义（用户要求：桥做代理层，用户只接触桥）：
 *   所有 owner 相关的端点在**服务端**校验 —— 调用方必须通过 `owner` 参数声明身份，
 *   接口只暴露该 owner 名下的 Key。**系统 Key（owner='')对 owner 接口不可见、不可删**。
 */
import * as keys from '../db/keys.mjs';
import { runProbe } from '../adapters/probe.mjs';
import { verifyKeyFirstByte, pickProbeModel } from '../adapters/firstbyte.mjs';
import { resetKeyState, keyHealthMap, keysWithNoSuccess, dailySummaryByKey } from '../db/state.mjs';
import * as rate from '../scheduler/rate.mjs';
import { getKey } from '../db/keys.mjs';
import { readJson, sendJson, matchPath, HttpError } from './util.mjs';
import config from '../config.mjs';

/**
 * 去掉敏感字段，转 camelCase 给前端。
 * @param k  channel_key 行
 * @param health  keyHealthMap 给出的运行时状态（可选）
 * @param daily   该 Key 最近 N 天的调用汇总（可选，用于"零成功"标识）
 */
function shape(k, health = null, daily = null) {
  if (!k) return null;
  const now = Date.now();
  const h = health ?? {
    state: 'READY', untilAt: null, failStreak: 0, lastError: null, models: 0, cooldownModels: 0,
  };

  // 每 Key RPM 限速状态（进程内滑动窗口）
  const used = rate.usage(k.uuid, now);
  const lim = rate.limit();
  const rpmLimited = lim > 0 && used >= lim;

  const d = daily ?? null;
  // 「调用过但一次都没成功」—— 桥要据此提醒用户换 Key。
  // 严格按用户定义：**没被调用过不算**（fail=0 时不判失败）。
  const calledRecently = !!d && (d.ok > 0 || d.fail > 0);
  const noSuccess = !!d && d.fail > 0 && d.ok === 0;

  // ⭐ 「最后一次调用的是什么模型」（用户要求）：
  //    冷却中只显示"剩余 17 分 51 秒"是不够的 —— 还得知道是**被哪个模型打挂的**。
  //    从 key_state（key×model 粒度、带 last_used_at）取最近那条即可。
  const lastModel = h.lastModel ?? null;
  const lastModelAt = h.lastModelAt ?? null;
  // 该模型是否正处于异常（冷却/禁用）—— 让 UI 能说"就是它把 Key 打挂的"
  const lastModelBad = lastModel ? h.lastModelState && h.lastModelState !== 'READY' : false;

  return {
    uuid: k.uuid,
    channel: k.channel_name,
    channelDisplay: k.channel_display,
    owner: k.owner ?? '',
    name: k.name,
    priority: k.priority,
    weight: k.weight,
    enabled: !!k.enabled,
    lastChecked: k.last_checked,
    lastOk: k.last_ok === null ? null : !!k.last_ok,
    lastError: k.last_error,
    createdAt: k.created_at,
    updatedAt: k.updated_at,

    // ---- 运行时调度状态（供列表直接显示"正常 / 冷却中 剩余多久 / 已禁用"）----
    /** READY | COOLDOWN | DISABLED */
    state: h.state,
    /** 冷却 / 禁用到期的绝对时间戳；READY 时为 null */
    untilAt: h.untilAt,
    /** 还要等多少毫秒 —— 前端直接渲染成"剩余 8 分钟" */
    remainingMs: h.untilAt ? Math.max(0, h.untilAt - now) : 0,
    /** 连续失败次数（成功一次立刻归零） */
    failStreak: h.failStreak,
    /** 该 Key 上有多少模型处于异常状态 / 共记录了多少模型 */
    stateModels: h.models,
    cooldownModels: h.cooldownModels,
    /** 人工停用 / 自动禁用 的区分，便于 UI 给不同文案 */
    reason: !k.enabled ? 'disabled_manual' : (h.state === 'DISABLED' ? 'disabled_auto' : null),

    // ---- ⭐ 最后调用的模型（用户要求：冷却中要显示出来）----
    /** 最后一次真实上游请求打的模型名（探针也算）；从未调用过则为 null */
    lastModel,
    /** 那次调用的时间戳 */
    lastModelAt,
    /** 那个模型当前是否处于冷却/禁用（= "就是它把这把 Key 打挂的"）*/
    lastModelBad,
    /** 距上次调用多久（毫秒），前端渲染"3 分钟前" */
    lastModelAgoMs: lastModelAt ? Math.max(0, now - lastModelAt) : null,

    // ---- 每 Key RPM 限速 ----
    rpmUsed: used,
    rpmLimit: lim,
    rpmLimited,
    rpmRemainingMs: rpmLimited ? rate.retryAfterMs(k.uuid, now) : 0,

    // ---- 最近调用表现（桥用来提示"这个 Key 该换了"）----
    /** 窗口内成功次数 */
    recentOk: d?.ok ?? 0,
    /** 窗口内失败次数 */
    recentFail: d?.fail ?? 0,
    /** 窗口内是否真的被调用过 */
    calledRecently,
    /** 调用过、但**一次都没成功** → true。这是桥要提醒用户的标志 */
    noSuccess,
    /**
     * 复核续期的豁免到期时间（0 = 无豁免）。
     * 在 `graceUntil > now` 期间，该 Key **不参与**零成功判定 ——
     * 只要复核能出字就不断续期，形成滑动窗口。
     */
    graceUntil: Number(k.grace_until ?? 0),
    lastUsedOkAt: d?.lastOkAt ?? null,
    lastUsedFailAt: d?.lastFailAt ?? null,
  };
}

/** 给整个列表一次性附上健康状态与近期调用汇总，避免每行各查一次 */
function shapeList(rows, days = config.keyNoSuccessDays) {
  const health = keyHealthMap();
  const daily = dailySummaryByKey(days);
  return rows.map((k) => shape(k, health.get(k.uuid) ?? null, daily.get(k.uuid) ?? null));
}

export async function handleKeys(req, res, url) {
  const { pathname } = url;
  const method = req.method;

  // --- 集合端点 ---
  if (pathname === '/api/keys') {
    if (method === 'GET') {
      const channel = url.searchParams.get('channel');
      const enabledOnly = url.searchParams.get('enabled') === '1';
      // owner 三态：不传 = 不过滤（管理后台看全部）；传了（哪怕是空串）= 只看该 owner
      const ownerParam = url.searchParams.get('owner');
      const owner = ownerParam === null ? undefined : ownerParam;
      return sendJson(res, 200, {
        keys: shapeList(keys.listKeys({ channel, enabledOnly, owner })),
        /** 当前调度策略与限速配置，供前端显示"填满优先 / 每 Key 2 RPM" */
        scheduler: {
          policy: config.schedulerPolicy,
          keyRpmLimit: rate.limit(),
          cooldownStepMs: config.cooldownStepMs,
          disableAfterFails: config.disableAfterFails,
          disabledRecoverMs: config.disabledRecoverMs,
          noSuccessDays: config.keyNoSuccessDays,
        },
      });
    }
    if (method === 'POST') {
      const body = await readJson(req);
      const rec = keys.addKey(body);          // DupKeyError / BadRequestError 由上层捕获
      return sendJson(res, 201, { ok: true, key: shape(rec) });
    }
  }

  if (pathname === '/api/keys/bulk' && method === 'POST') {
    const body = await readJson(req);
    const { channel, keys: items, owner } = body ?? {};
    if (!Array.isArray(items)) throw new HttpError(400, '需要 keys 数组');
    // owner 在 body 顶层给，逐条注入（单条也可自带 owner 覆盖）
    const withOwner = owner === undefined
      ? items
      : items.map((it) => ({ owner, ...it }));
    return sendJson(res, 200, keys.addKeysBulk(channel, withOwner));
  }

  // --- 按 owner 汇总「调用过但零成功」的 Key（桥用来提醒用户）---
  if (pathname === '/api/keys/health' && method === 'GET') {
    const owner = url.searchParams.get('owner');
    const days = Number(url.searchParams.get('days')) || config.keyNoSuccessDays;
    // 新绑定的 Key 给宽限期 —— 否则刚绑上、还没被路由选中就报失败
    const minAgeMs = config.keyNoSuccessGraceMs;
    const now = Date.now();
    const bad = keysWithNoSuccess(days, { minAgeMs, now });
    const ownerUuids = owner === null ? null : keys.ownerKeyUuids(owner);
    const rows = keys.listKeys({ owner: owner === null ? undefined : owner });
    const daily = dailySummaryByKey(days);
    const byUuid = new Map(rows.map((r) => [r.uuid, r]));

    const flagged = bad
      .filter((x) => (ownerUuids ? ownerUuids.has(x.uuid) : true))
      .map((x) => {
        const k = byUuid.get(x.uuid) ?? getKey(x.uuid);
        return {
          uuid: x.uuid,
          channel: k?.channel_name ?? null,
          channelDisplay: k?.channel_display ?? null,
          name: k?.name ?? null,
          owner: k?.owner ?? '',
          recentOk: x.ok,
          recentFail: x.fail,
          lastFailAt: x.lastFailAt,
        };
      });

    // 该 owner 名下所有 Key 的调用概览（让桥能显示"5 把里 2 把失效"）
    //
    // ⚠️ noSuccess 分两个口径，**别混用**：
    //    noSuccess           —— 原始事实：近期调用过但零成功（**不含年龄宽限**）
    //    noSuccessEffective  —— 加上宽限期后的可执行判定（够老才算数）
    //
    // 桥的「自动踢分组」必须用 **noSuccessEffective**。
    // 曾用无宽限的字段算 allFailed → 新绑的 Key 一失败就 allFailed=true，
    // 接上自动踢人后会**刚绑上就被踢**，宽限期形同虚设。
    const effectiveUuids = new Set(bad.map((x) => x.uuid));
    const overview = rows.map((r) => {
      const d = daily.get(r.uuid) ?? { ok: 0, fail: 0 };
      const raw = d.fail > 0 && d.ok === 0;
      const graceUntil = Number(r.grace_until ?? 0);
      return {
        uuid: r.uuid, channel: r.channel_name, name: r.name,
        recentOk: d.ok, recentFail: d.fail,
        called: d.ok > 0 || d.fail > 0,
        noSuccess: raw,
        noSuccessEffective: raw && effectiveUuids.has(r.uuid),
        /** 复核续期豁免到期时间（0 = 无）；> now 表示当前处于续期内 */
        graceUntil,
        /** 是否正处于「复核续期」豁免中（桥可据此跳过重复判定） */
        graceActive: graceUntil > now,
      };
    });

    // ⚠️ 只有"存在 Key 且**每一把都够老且零成功**"才算 allFailed。
    //    没有任何 Key 时返回 false —— 否则"没绑 Key ≠ 全部失效"会被弄反，
    //    导致刚解绑完就被踢（解绑本身已有自己的回退逻辑）。
    const allFailedEffective = overview.length > 0 && overview.every((x) => x.noSuccessEffective);

    return sendJson(res, 200, {
      days,
      graceMs: minAgeMs,
      /** 判为失效的（调用过但零成功，**已含宽限期**） */
      failed: flagged,
      /** 该 owner 名下全部 Key 的概览 */
      keys: overview,
      /** 是否存在"全部 Key 都失效" —— 桥据此决定要不要把用户移出 api2api 分组。
       *  已计入宽限期：新绑的 Key 在宽限期内不会被算作失效。 */
      allFailed: allFailedEffective,
      /** 上一行的原始口径（不含宽限），仅用于排查/展示 */
      allFailedRaw: overview.length > 0 && overview.every((x) => x.noSuccess),
    });
  }

  // --- 验活：给一把**还没入库**的 Key（「发 hi 等首字」）---
  if (pathname === '/api/keys/verify' && method === 'POST') {
    const body = await readJson(req);
    const { channel, key, model } = body ?? {};
    if (!channel) throw new HttpError(400, '需要 channel 参数');
    if (!key || !String(key).trim()) throw new HttpError(400, '需要 key 参数');
    const r = await verifyKeyFirstByte(String(key).trim(), channel, { model: model ?? null });
    return sendJson(res, 200, {
      ok: r.ok,
      channel,
      model: r.model,
      firstByteMs: r.firstByteMs,
      httpStatus: r.httpStatus,
      errClass: r.errClass,
      error: r.error,
      /** 试了几个模型（顺序试，首个成功即停） */
      attempted: r.attempted,
      /** 每个模型的逐个结果 —— 用户能看到"第1个限流、第2个成功"这种过程 */
      tried: r.tried,
    });
  }

  // --- 测活 ---
  if (pathname === '/api/keys/check' && method === 'POST') {
    const body = await readJson(req);
    const result = await runProbe({
      scope: body?.scope,
      channel: body?.channel ?? null,
      model: body?.model ?? null,
    });
    return sendJson(res, 200, result);
  }

  if (pathname === '/api/keys/check-all' && method === 'POST') {
    const body = await readJson(req);
    if (!body?.channel) throw new HttpError(400, '需要 channel 参数');
    const result = await runProbe({ scope: 'channel', channel: body.channel });
    return sendJson(res, 200, result);
  }

  // --- 列出所有绑过 Key 的 owner（桥的后台巡检遍历用）---
  // ⚠️ 必须放在 matchPath('/api/keys/:uuid') **之前** ——
  //    否则 "owners" 会被当成 uuid 吃掉，返回 404。
  // 只给"有哪些 owner、各几把 Key"，不含任何密钥信息。
  // 系统 Key（owner='')不出现 —— 桥不管系统 Key。
  if (pathname === '/api/keys/owners' && method === 'GET') {
    return sendJson(res, 200, { owners: keys.listOwners() });
  }

  // --- 单资源端点 ---
  const p1 = matchPath('/api/keys/:uuid', pathname);
  if (p1) {
    const { uuid } = p1;
    // 归属校验：调用方声明了 owner 时，只能操作自己名下的 Key。
    // 系统 Key（owner='')永远不会被带 owner 的请求碰到 —— 这是桥做代理隔离的关键。
    const ownerParam = url.searchParams.get('owner');
    const assertOwn = () => {
      if (ownerParam === null) return;                 // 未声明 owner = 管理后台，放行
      const k = getKey(uuid);
      if (!k) throw new HttpError(404, `Key 不存在: ${uuid}`);
      if (String(k.owner ?? '') !== String(ownerParam)) {
        throw new HttpError(403, '该 Key 不属于你，无权操作');
      }
    };

    if (method === 'GET') {
      assertOwn();
      const k = getKey(uuid);
      if (!k) throw new HttpError(404, `Key 不存在: ${uuid}`);
      return sendJson(res, 200, { key: shape(k, keyHealthMap().get(uuid) ?? null, dailySummaryByKey(config.keyNoSuccessDays).get(uuid) ?? null) });
    }
    if (method === 'PATCH' || method === 'PUT') {
      assertOwn();
      const body = await readJson(req);
      const k = keys.patchKey(uuid, body);
      if (!k) throw new HttpError(404, `Key 不存在: ${uuid}`);
      return sendJson(res, 200, { ok: true, key: shape(k, keyHealthMap().get(uuid) ?? null) });
    }
    if (method === 'DELETE') {
      assertOwn();
      const ok = keys.deleteKey(uuid);
      if (!ok) throw new HttpError(404, `Key 不存在: ${uuid}`);
      return sendJson(res, 200, { ok: true, deleted: true, uuid });
    }
  }

  const p2 = matchPath('/api/keys/:uuid/reset', pathname);
  if (p2 && method === 'POST') {
    const body = await readJson(req).catch(() => ({}));
    const n = resetKeyState(p2.uuid, body?.model ?? null);
    rate.clear(p2.uuid);   // 限速窗口一并清掉，重置后立刻可用
    return sendJson(res, 200, { ok: true, resetRows: n });
  }

  // --- 验活：已入库的 Key（用存着的明文，用户不用再贴一遍）---
  const p3 = matchPath('/api/keys/:uuid/verify', pathname);
  if (p3 && method === 'POST') {
    const ownerParam = url.searchParams.get('owner');
    const k = getKey(p3.uuid);
    if (!k) throw new HttpError(404, `Key 不存在: ${p3.uuid}`);
    if (ownerParam !== null && String(k.owner ?? '') !== String(ownerParam)) {
      throw new HttpError(403, '该 Key 不属于你，无权操作');
    }
    const secret = keys.getKeySecret(p3.uuid);
    if (!secret) throw new HttpError(500, '密钥解密失败');
    const body = await readJson(req).catch(() => ({}));
    // 不指定 model → 顺序试该渠道**所有**模型，任一能出字即算活。
    // 这正是用户要的语义：「有些 key 可能只有 ds 用不了，其他能用但也可以要」。
    const r = await verifyKeyFirstByte(secret, k.channel_id, { model: body?.model ?? null });
    // 回写测活结果，顺手刷新列表里那一行
    keys.markChecked(p3.uuid, r.ok, r.ok ? null : r.error);

    // ⭐ 复核通过 → 续期（滑动窗口）
    // 只要每轮复核能出字，就再保 `keyGraceRenewMs`（默认 3 天），可无限续。
    // 只在**成功**时续 —— 失败不清零已有豁免（瞬时抖动不该惩罚用户），
    // 清零靠下一轮巡检判定自然达成。
    let graceUntil = keys.graceUntilOf(p3.uuid);
    if (r.ok && config.keyGraceRenewMs > 0) {
      graceUntil = keys.renewGrace(p3.uuid, config.keyGraceRenewMs);
    }
    return sendJson(res, 200, {
      ok: r.ok, uuid: p3.uuid, channel: k.channel_name, model: r.model,
      firstByteMs: r.firstByteMs, httpStatus: r.httpStatus,
      errClass: r.errClass, error: r.error,
      attempted: r.attempted, tried: r.tried,
      /** 续期后的豁免到期时间（0 = 无豁免） */
      graceUntil,
      graceRenewMs: config.keyGraceRenewMs,
    });
  }

  return false; // 未匹配
}

export { shape };
export default { handleKeys };
