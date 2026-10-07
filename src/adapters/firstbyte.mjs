/**
 * Key 验活 —— 「发 hi，**收到首字**就算通过」。
 *
 * 与原 probe.mjs 的区别（用户明确要求）：
 *   - probe.checkChannel 打 `GET /models`：只证明"认证能过"，**不证明这个模型真能出字**。
 *     有的上游 /models 不鉴权、或鉴权通过但模型被 token plan 挡住。
 *   - 本模块打 `POST /chat/completions` 且 `stream:true`，
 *     **拿到第一个 SSE data 帧就判定成功**，然后立刻断开 —— 不等整段生成完。
 *
 * 为什么用「首字」而不是等完整响应：
 *   1. 快 —— 长回答可能要几十秒，首字通常 1~3 秒
 *   2. 省 —— 断开连接后上游不再继续生成，少扣额度
 *   3. 准 —— "能出字"才是真的能用；只回 200 但内容为空的不算
 *
 * ⭐ 为什么要遍历全部模型（2026-10-07 用户明确要求）：
 *   只试一个模型会误判。实测商汤新 Key 第一个模型回
 *   `inference exceeds tpm/rpm limit`（QUOTA）—— 但**限流常是模型/端点级**的，
 *   换下一个模型往往就能出字。只试一个 = 好 Key 被误判成坏的，用户根本绑不上。
 *
 *   规则（用户原话「必须一个一个来 不能同时打」）：
 *     - **严格串行**，绝不并发
 *     - 从上游模型清单**第一个**开始，不行就下一个，**任一成功即成功**
 *     - `QUOTA`（限流）→ **继续试下一个模型**（限流可能是模型级的）
 *     - `AUTH`（认证失败）→ **立刻终止**（Key 本身就是坏的，换模型不会有不同结果）
 *     - `CONFIG_FAULT`（该模型不存在）→ 继续下一个
 */
import { getAdapter } from './index.mjs';
import { getChannel } from '../db/channels.mjs';
import { listChannelModels } from '../db/catalog.mjs';
import { ErrClass } from '../util/errors.mjs';
import config from '../config.mjs';
import log from '../util/log.mjs';

/** 明显不是 chat 的模型（生图 / 音频 / 向量化），验活时排除 —— 发 chat 必失败，白耗预算 */
const NON_CHAT = /(image|draw|lyria|tts|audio|speech|embed|rerank)/i;

/**
 * 候选模型列表 —— **严格按上游声明的顺序**（`/models` 返回的次序）。
 *
 * 用户明确要求（2026-10-07 原话）：
 *   「先验证模型列表**第一个**，看看能不能成功，不行顺序下一个，
 *     任意一个成功就成功。必须一个一个来，不能同时打。」
 *
 * 所以**不做任何重排**（之前按 flash/lite 之类的名字特征打分排序，是错的）——
 * 上游声明的顺序才是用户要的顺序。只滤掉明显不是 chat 的模型。
 *
 * @param {string} channelRef 渠道 id 或 name
 * @param {number} [limit] 最多返回几个（0 = 全部）
 * @returns {string[]}
 */
export function listProbeCandidates(channelRef, limit = 0) {
  const ch = getChannel(channelRef);
  if (!ch) return [];

  // listChannelModels 已按上游 seq 排序
  const rows = listChannelModels(ch.id);
  let ids = rows.map((m) => m.model_id);
  if (!ids.length) {
    // 目录还没拉过 —— 回落默认模型（可能为空，由调用方处理）
    return ch.default_model ? [ch.default_model] : [];
  }

  const chatLike = ids.filter((id) => !NON_CHAT.test(String(id)));
  // 若过滤后啥都不剩（渠道全是生图之类），退回原清单 —— 总得试点什么
  const pool = chatLike.length ? chatLike : ids;

  return limit > 0 ? pool.slice(0, limit) : pool;
}

/** 兼容���接口：只取最优的第一个模型 */
export function pickProbeModel(channelRef) {
  return listProbeCandidates(channelRef, 1)[0] ?? null;
}

/**
 * 用「发 hi 等首字」的方式验证一把 Key。
 *
 * **严格串行**遍历该渠道的候选模型（按上游声明顺序），**任一成功即立刻返回**。
 *
 * 语义（用户 2026-10-07 明确要求）：
 *   - 从上游模型清单**第一个**开始试，不行就下一个
 *   - **任意一个成功 → 立刻成功并返回**（不再试后面的）
 *   - **一个一个来，绝不并发**
 *   - 任何失败都继续试下一个 —— 包括：
 *       · QUOTA（`inference exceeds tpm/rpm limit`，**限流常是模型级**的，换一个就能过）
 *       · AUTH（商汤 `PERMISSION_DENIED` 可能只是这个模型没权限，别的模型能用）
 *       · CONFIG_FAULT（这个模型不在 token plan 里）
 *       · TRANSIENT（抖动）
 *     只有「总时间预算耗尽」才提前收工，避免把用户卡死。
 *
 * @param {string} secret  Key 明文
 * @param {string} channelRef 渠道（id 或 name）
 * @param {object} [opts]
 * @param {string} [opts.model] 指定模型 → **只试它**（保持旧行为，用于"验证某个具体模型"）
 * @param {number} [opts.perModelTimeoutMs] 单个模型的等待首字超时
 * @param {number} [opts.totalBudgetMs] 整轮验活的总时间预算（防止几十个模型把用户卡死）
 * @param {number} [opts.maxModels] 最多试几个模型（0 = 不限）
 * @returns {Promise<{ok:boolean, model:string|null, firstByteMs:number|null,
 *                    httpStatus:number|null, errClass:string, error:string|null,
 *                    attempted:number, tried:Array}>}
 */
export async function verifyKeyFirstByte(secret, channelRef, opts = {}) {
  const ch = getChannel(channelRef);
  if (!ch) {
    return {
      ok: false, model: null, firstByteMs: null, httpStatus: null,
      errClass: ErrClass.CONFIG_FAULT, error: `渠道不存在: ${channelRef}`,
      attempted: 0, tried: [],
    };
  }

  // 指定了 model → 只试它（调用方明确要求验证某个模型时的语义）
  const candidates = opts.model
    ? [opts.model]
    : listProbeCandidates(ch.id, opts.maxModels > 0 ? opts.maxModels : 0);

  if (!candidates.length) {
    return {
      ok: false, model: null, firstByteMs: null, httpStatus: null,
      errClass: ErrClass.CONFIG_FAULT,
      error: '无法确定用于验证的模型：上游目录为空且渠道没有默认模型。请先在该渠道拉取一次模型清单。',
      attempted: 0, tried: [],
    };
  }

  // ⚠️ 这两个值**必须来自 config 且非 undefined** ——
  //    曾经 verifyTotalBudgetMs 不存在，导致 deadline=NaN → setTimeout(abort,NaN)
  //    → 每个模型被瞬间中断，任何 Key 都验不过去。
  const perModelMs = opts.perModelTimeoutMs ?? config.verifyPerModelTimeoutMs;
  const budgetMs = opts.totalBudgetMs ?? config.verifyTotalBudgetMs;
  const deadline = Date.now() + budgetMs;

  const tried = [];
  let last = null;
  let firstAuth = null;

  for (const model of candidates) {
    const remain = deadline - Date.now();
    if (remain < 1500) {
      tried.push({ model, ok: false, errClass: 'skipped', error: '总时间预算用尽，未再尝试' });
      break;
    }

    const r = await tryModelOnce(secret, ch, model, Math.min(perModelMs, remain));
    tried.push({
      model, ok: r.ok, errClass: r.errClass,
      httpStatus: r.httpStatus, firstByteMs: r.firstByteMs, error: r.error,
    });

    // ⭐ 任一成功 → **立刻返回**，后面的模型一个都不再试
    if (r.ok) {
      log.info(`[verify] ${ch.name} 验活成功：model=${model} 首字 ${r.firstByteMs}ms（试了 ${tried.length} 个模型）`);
      return { ...r, attempted: tried.length, tried };
    }

    // 记下第一次认证失败，作为"所有模型都失败"时的主导错误
    if (!firstAuth && r.errClass === ErrClass.AUTH) firstAuth = r;
    last = r;
    // 其余任何失败（限流 / 模型无权限 / 模型不存在 / 抖动）→ 继续试下一个
  }

  // 全失败：优先报认证错误（信息最明确），否则报最后一个
  const final = firstAuth ?? last ?? {
    ok: false, model: null, firstByteMs: null, httpStatus: null,
    errClass: ErrClass.TRANSIENT, error: '没有任何候选模型可试',
  };

  log.info(`[verify] ${ch.name} 验活失败：已试 ${tried.length} 个模型，均未收到首字`);
  return { ...final, ok: false, attempted: tried.length, tried };
}

/**
 * 试**一个**模型：发 hi、等首字。
 * 内部函数，被 verifyKeyFirstByte 串行调用 —— 不做任何并发。
 */
async function tryModelOnce(secret, ch, model, timeoutMs) {
  const adapter = getAdapter(ch.adapter);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = Date.now();

  try {
    const res = await fetch(adapter.chatUrl(ch.base_url), {
      method: 'POST',
      headers: { ...adapter.headers(secret), Accept: 'text/event-stream' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 16,
        stream: true,
      }),
      signal: ctrl.signal,
    });

    // ---- 非 2xx：直接按错误壳分类，不用读流 ----
    if (!(res.status >= 200 && res.status < 300)) {
      const text = await res.text().catch(() => '');
      const verdict = adapter.classify(res.status, res.headers, text);
      return {
        ok: false, model, firstByteMs: Date.now() - t0, httpStatus: res.status,
        errClass: verdict.errClass,
        error: verdict.message || `HTTP ${res.status}`,
      };
    }

    // ---- 2xx 但没有 body：当作失败（拿不到流） ----
    if (!res.body) {
      return {
        ok: false, model, firstByteMs: null, httpStatus: res.status,
        errClass: ErrClass.TRANSIENT, error: '上游返回 2xx 但没有响应体',
      };
    }

    // ---- 读流，等第一个"有内容"的帧 ----
    const got = await waitFirstContent(res.body, timeoutMs - (Date.now() - t0));

    // 立刻断开 —— 别让上游继续生成（省额度）
    ctrl.abort();

    if (got.ok) {
      return {
        ok: true, model, firstByteMs: Date.now() - t0, httpStatus: res.status,
        errClass: ErrClass.OK, error: null,
      };
    }
    return {
      ok: false, model, firstByteMs: null, httpStatus: res.status,
      errClass: ErrClass.TRANSIENT,
      error: got.reason || '未在超时内收到内容',
    };
  } catch (e) {
    const aborted = e?.name === 'AbortError';
    return {
      ok: false, model, firstByteMs: aborted ? null : Date.now() - t0,
      httpStatus: null,
      errClass: ErrClass.TRANSIENT,
      error: aborted ? `等待首字超时（${timeoutMs}ms）` : `验证失败: ${e.message}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 从 SSE 流里等第一个「有内容」的帧。
 *
 * 判定"有内容"的规则：
 *   - `data: [DONE]`            → 不算（空转结束，说明模型没吐字）
 *   - choices[0].delta.content 非空 → 算 ✅
 *   - choices[0].delta.reasoning_content 非空 → 也算 ✅
 *     （推理模型会先吐思维链；能吐思维链就证明这条链路是通的）
 *   - 其他（role 帧、usage 帧、空 delta）→ 继续等
 */
async function waitFirstContent(body, budgetMs) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const deadline = Date.now() + Math.max(1000, budgetMs);

  try {
    for (;;) {
      if (Date.now() > deadline) return { ok: false, reason: '等待首字超时' };
      const { value, done } = await reader.read();
      if (done) {
        // 流结束了还没等到内容
        const tail = checkChunk(buf);
        return tail.ok ? tail : { ok: false, reason: '流已结束但未收到内容（模型返回空）' };
      }
      buf += decoder.decode(value, { stream: true });

      // 逐行消费完整的 SSE 行
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line || !line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        const r = checkChunk(payload);
        if (r.ok) return r;
      }
      // 兜底：上游可能不发换行（极少数）—— 直接整体探一次
      if (buf.length > 4096) {
        const r = checkChunk(buf);
        if (r.ok) return r;
        buf = '';
      }
    }
  } catch (e) {
    return { ok: false, reason: `读取流失败: ${e.message}` };
  } finally {
    try { reader.cancel(); } catch { /* ignore */ }
  }
}

/** 判断一个 SSE 帧里是否已经有实际内容 */
function checkChunk(raw) {
  const text = String(raw).trim();
  if (!text || text === '[DONE]') return { ok: false };
  // 可能粘连多个 data: 行，逐个试
  const parts = text.includes('data:') ? text.split('data:') : [text];
  for (const p of parts) {
    const s = p.trim();
    if (!s || s === '[DONE]') continue;
    let json;
    try { json = JSON.parse(s); } catch { continue; }
    const choice = json?.choices?.[0];
    if (!choice) continue;
    const d = choice.delta ?? choice.message ?? {};
    const content = d.content;
    const reasoning = d.reasoning_content ?? d.reasoning;
    if ((typeof content === 'string' && content.length > 0)
      || (typeof reasoning === 'string' && reasoning.length > 0)) {
      return { ok: true };
    }
  }
  return { ok: false };
}

export default { verifyKeyFirstByte, pickProbeModel, listProbeCandidates };
