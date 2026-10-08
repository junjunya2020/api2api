/**
 * 测模型可用性（用户 2026-10-08）。
 *
 * 需求原话：
 *   「测试模型可用性会自动黑名单渠道的所有key 打模型 超时 默认10秒可以设置
 *     可以挂后台」「测试模型可用性会自动黑名单」「模型黑名单也有测试模型可用性」
 *   「从来没成功过 每次调用都失败 不在模型列表出现」
 *
 * 做法：对给定 (渠道, 模型)，取该渠道**所有启用的 Key**，逐个发一条
 * `max_tokens=1` 的最小 chat 请求，记录每个 Key 的状态/HTTP/延迟。
 *
 * ⚠️ 三条铁律（沿用项目既有约定）：
 *   ① **必须留间隔**：连续打同一模型会把自己打成 429，污染结论（gapMs 默认 1200）。
 *   ② **记录真实结果，不写 key_state / model_health** —— 这是"探测"，
 *      不该把一个好好的 Key 打进冷却。只有**自动拉黑**是副作用（且有明确阈值）。
 *   ③ 上游 Key 永不出网关；全程用网关内部调用。
 */
import config from '../config.mjs';
import log from '../util/log.mjs';
import { getChannel } from '../db/channels.mjs';
import { listKeys, getKeySecret } from '../db/keys.mjs';
import { getAdapter } from '../adapters/index.mjs';
import { ErrClass } from '../util/errors.mjs';
import * as blacklist from '../db/channel-ban.mjs';

/** 懒加载 settings（它 import db，避免顶层循环） */
async function settingsMod() { return import('../db/settings.mjs'); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 打一次最小 chat 请求（非流式，max_tokens=1）。
 * 返回 { state, httpStatus, ms, errClass, message, sample }
 */
export async function probeOnce(channel, key, model, { timeoutMs = config.probeModelTimeoutMs } = {}) {
  const adapter = getAdapter(channel.adapter);
  const secret = getKeySecret(key.uuid);
  const url = adapter.chatUrl(channel.base_url);
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(1000, timeoutMs));
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: adapter.headers(secret),
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1, stream: false }),
      signal: ctrl.signal,
    });
    const text = await resp.text();
    const ms = Date.now() - t0;
    if (resp.status >= 200 && resp.status < 300) {
      let sample = '';
      try { sample = JSON.parse(text)?.choices?.[0]?.message?.content ?? ''; } catch { /* ignore */ }
      return { state: 'ok', httpStatus: resp.status, ms, errClass: ErrClass.OK, message: '', sample: String(sample).slice(0, 60) };
    }
    const verdict = adapter.classify(resp.status, resp.headers, text);
    return {
      state: 'fail', httpStatus: resp.status, ms,
      errClass: verdict.errClass, message: (verdict.message || `HTTP ${resp.status}`).slice(0, 200),
      code: verdict.code ?? null,
    };
  } catch (e) {
    const ms = Date.now() - t0;
    const timedOut = e.name === 'AbortError' || /abort/i.test(e.message || '');
    return {
      state: 'fail', httpStatus: null, ms,
      errClass: timedOut ? ErrClass.TRANSIENT : ErrClass.TRANSIENT,
      message: timedOut ? `超时（>${Math.round(timeoutMs / 1000)}s）` : (e.message || '连接失败').slice(0, 200),
      timeout: timedOut,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * ⭐ 测一个 (渠道, 模型) 的可用性 —— 把该渠道**所有启用 Key** 都打一遍。
 *
 * @param {object} p
 * @param {string} p.channel            渠道名
 * @param {string} p.model              原始上游模型名
 * @param {number} [p.timeoutMs]        每个 Key 的超时（默认取 config 10s）
 * @param {number} [p.gapMs]            每个 Key 之间的间隔（默认 1200ms，防自激）
 * @param {Function} [p.onKey]          (info) => void 每打完一个 Key 回调
 * @param {Function} [p.cancel]         () => boolean 返回 true 则中止
 * @param {boolean} [p.autoBan]         是否在"全部失败且从未成功"时自动拉黑
 * @returns {Promise<object>}
 */
export async function probeModelAvailability({
  channel: channelRef, model, timeoutMs = config.probeModelTimeoutMs,
  gapMs = 1200, onKey = null, cancel = null, autoBan = null,
}) {
  const ch = getChannel(channelRef);
  if (!ch) throw Object.assign(new Error(`渠道不存在: ${channelRef}`), { status: 404 });
  const m = String(model ?? '').trim();
  if (!m) throw Object.assign(new Error('model 必填'), { status: 400 });

  const keys = listKeys({ channel: ch.id, enabledOnly: true });
  if (!keys.length) throw Object.assign(new Error(`渠道 ${ch.name} 下没有启用的 Key`), { status: 400 });

  const results = [];
  let ok = 0;
  let fail = 0;

  for (let i = 0; i < keys.length; i++) {
    if (cancel && cancel()) {
      results.push({ key: keys[i].uuid, state: 'skip', message: '已取消' });
      continue;
    }
    const k = keys[i];
    const r = await probeOnce(ch, k, m, { timeoutMs });
    results.push({ key: k.uuid, keyName: k.name || '', ...r });
    if (r.state === 'ok') ok++; else fail++;
    if (onKey) onKey({ index: i, total: keys.length, key: k.uuid, keyName: k.name || '', ...r, ok, fail });
    if (i < keys.length - 1 && gapMs > 0) await sleep(gapMs);
  }

  const anyOk = ok > 0;
  let banned = null;
  // ⭐ 自动拉黑：全部 Key 都失败（从未成功）→ 加入黑名单
  const wantBan = autoBan === null ? (config.probeAutoBan !== 0) : !!autoBan;
  if (wantBan && !anyOk && fail > 0) {
    const sm = await settingsMod();
    if (sm.blacklistEnabled()) {
      const errs = [...new Set(results.filter((r) => r.state === 'fail').map((r) => r.message))].slice(0, 3);
      banned = blacklist.ban({
        channel: ch.name,
        model: m,
        reason: `可用性测试：该渠道全部 ${keys.length} 个 Key 均失败、从未成功 —— `
          + `${errs.join('；') || '无成功响应'}。自动加入黑名单（可在本页解禁）。`,
        source: blacklist.BanSource.AUTO,
        failCount: fail,
        okCount: ok,
      });
      log.warn(`[probe] ${ch.name}/${m} 全部 ${keys.length} 个 Key 失败 → 自动拉黑`);
    }
  }

  return {
    channel: ch.name,
    channelDisplay: ch.display_name,
    model: m,
    total: keys.length,
    okCount: ok,
    failCount: fail,
    /** 全部 Key 都没成功 */
    allFailed: !anyOk,
    results,
    banned,
  };
}

export default { probeOnce, probeModelAvailability };
