/**
 * 测活探针。
 *
 * 两种模式（用户要求）：
 *   - scope=channel → 测整个渠道：该渠道下所有 Key，打上游 GET /v1/models（廉价、不耗对话额度）
 *   - scope=model   → 测指定模型：该模型在所有渠道（或指定渠道）上是否可用
 *                     发一条最小 chat 请求（max_tokens=1），验证真实可用性
 */
import { getAdapter } from '../adapters/index.mjs';
import { listKeys, getKeySecret, markChecked } from '../db/keys.mjs';
import { listChannels, getChannel } from '../db/channels.mjs';
import { resolveCandidates } from '../db/aliases.mjs';
import { ErrClass } from '../util/errors.mjs';
import { recordSuccess, recordFailure } from '../db/state.mjs';
import config from '../config.mjs';
import log from '../util/log.mjs';

/** 带超时的 fetch 包装 */
async function timedFetch(url, opts, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    const text = await res.text();
    return { res, text, latencyMs: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 模式 A：测整个渠道的所有 Key。
 * 打 GET /v1/models —— 实测两家上游该端点都要求认证，是零成本验活手段。
 */
export async function checkChannel(channelRef) {
  const ch = getChannel(channelRef);
  if (!ch) return { ok: false, error: `渠道不存在: ${channelRef}` };

  const adapter = getAdapter(ch.adapter);
  const keys = listKeys({ channel: ch.id, enabledOnly: false });
  const results = [];

  for (const k of keys) {
    const secret = getKeySecret(k.uuid);
    const t0 = Date.now();
    let entry;
    try {
      const { res, text, latencyMs } = await timedFetch(
        adapter.modelsUrl(ch.base_url),
        { method: 'GET', headers: adapter.headers(secret) },
        config.upstreamConnectTimeoutMs,
      );
      const verdict = adapter.classify(res.status, res.headers, text);
      const ok = verdict.errClass === ErrClass.OK;

      entry = {
        uuid: k.uuid, channel: ch.name, keyName: k.name,
        ok, httpStatus: res.status, latencyMs,
        errClass: verdict.errClass, error: ok ? null : verdict.message,
      };
      markChecked(k.uuid, ok, ok ? null : verdict.message);
      if (ok) recordSuccess(k.uuid, '__probe__');
      else recordFailure(k.uuid, '__probe__', {
        action: verdict.errClass === ErrClass.AUTH ? 'disable' : 'none',
        error: verdict.message,
      });
    } catch (e) {
      const latencyMs = Date.now() - t0;
      entry = {
        uuid: k.uuid, channel: ch.name, keyName: k.name,
        ok: false, httpStatus: null, latencyMs,
        errClass: ErrClass.TRANSIENT, error: `探针失败: ${e.message}`,
      };
      markChecked(k.uuid, false, e.message);
    }
    results.push(entry);
  }

  return {
    scope: 'channel',
    channel: { id: ch.id, name: ch.name, displayName: ch.display_name },
    probe: 'GET /models',
    total: results.length,
    okCount: results.filter((r) => r.ok).length,
    failCount: results.filter((r) => !r.ok).length,
    results,
  };
}

/**
 * 模式 B：测指定模型。
 * 在所有渠道（或指定渠道）上发最小 chat 请求验证。
 */
export async function checkModel(publicModel, { channel = null } = {}) {
  const all = resolveCandidates(publicModel);
  const candidates = channel
    ? all.filter((c) => c.channelName === channel || c.channelId === channel)
    : all;

  if (!candidates.length) {
    return { scope: 'model', model: publicModel, total: 0, okCount: 0, failCount: 0, results: [], error: '没有可用候选渠道' };
  }

  const results = [];
  for (const cand of candidates) {
    const adapter = getAdapter(cand.adapter);
    const keys = listKeys({ channel: cand.channelId, enabledOnly: true });
    if (!keys.length) {
      results.push({
        channel: cand.channelName, channelDisplay: cand.channelDisplay,
        uuid: null, ok: false, httpStatus: null, errClass: ErrClass.NO_KEY,
        error: '该渠道下没有启用的 Key', upstreamModel: cand.upstreamName,
      });
      continue;
    }

    // 每个渠道只探第一把启用的 Key（省钱省时间）
    const k = keys[0];
    const secret = getKeySecret(k.uuid);
    const t0 = Date.now();
    try {
      const body = JSON.stringify({
        model: cand.upstreamName,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        stream: false,
      });
      const { res, text, latencyMs } = await timedFetch(
        adapter.chatUrl(cand.baseUrl),
        { method: 'POST', headers: adapter.headers(secret), body },
        config.upstreamTimeoutMs,
      );
      const verdict = adapter.classify(res.status, res.headers, text);
      const ok = verdict.errClass === ErrClass.OK;
      results.push({
        channel: cand.channelName, channelDisplay: cand.channelDisplay,
        uuid: k.uuid, keyName: k.name, upstreamModel: cand.upstreamName,
        ok, httpStatus: res.status, latencyMs,
        errClass: verdict.errClass, error: ok ? null : verdict.message,
      });
      if (ok) recordSuccess(k.uuid, cand.upstreamName);
      else recordFailure(k.uuid, cand.upstreamName, { action: 'none', error: verdict.message });
    } catch (e) {
      results.push({
        channel: cand.channelName, channelDisplay: cand.channelDisplay,
        uuid: k.uuid, upstreamModel: cand.upstreamName,
        ok: false, httpStatus: null, latencyMs: Date.now() - t0,
        errClass: ErrClass.TRANSIENT, error: `探针失败: ${e.message}`,
      });
    }
  }

  return {
    scope: 'model',
    model: publicModel,
    probe: 'POST /chat/completions (max_tokens=1)',
    total: results.length,
    okCount: results.filter((r) => r.ok).length,
    failCount: results.filter((r) => !r.ok).length,
    results,
  };
}

/** 统一入口 */
export async function runProbe({ scope, channel = null, model = null }) {
  if (scope === 'channel') {
    if (!channel) throw Object.assign(new Error('scope=channel 需要 channel 参数'), { status: 400 });
    return checkChannel(channel);
  }
  if (scope === 'model') {
    if (!model) throw Object.assign(new Error('scope=model 需要 model 参数'), { status: 400 });
    return checkModel(model, { channel });
  }
  throw Object.assign(new Error(`未知 scope: ${scope}（支持 channel | model）`), { status: 400 });
}

export default { runProbe, checkChannel, checkModel };
