/**
 * 「拉上游目录」的共享实现 —— 被 `POST /api/models/fetch`（管理 API）
 * 与「只接快速模型」开关变更时的自动重拉逻辑复用。
 *
 * 抽出来是为了避免两处各写一份（一旦漂移，"被快速白名单挡下的模型落黑名单"
 * 这条路径就会只在其中一个入口生效）。
 */
import * as catalog from '../db/catalog.mjs';
import { getChannel, listChannels } from '../db/channels.mjs';
import { listKeys, getKeySecret } from '../db/keys.mjs';
import { getAdapter } from '../adapters/index.mjs';
import { ErrClass } from '../util/errors.mjs';
import { fastModelsOnly } from '../db/settings.mjs';
import { isFastOnlyChannel, isFastModel, fastModelsOf } from '../db/fast-models.mjs';
import * as blacklist from '../db/channel-ban.mjs';
import config from '../config.mjs';
import log from '../util/log.mjs';

/**
 * 拉某渠道的上游模型清单并落库（含免费过滤 / 快速模式过滤 / 快速模式拉黑）。
 * @param {string} chRef 渠道名或 id
 * @returns {Promise<object>} 与旧 `/api/models/fetch` 响应体一致的对象
 * @throws {{status:number, message:string}} 形如 HttpError 的错误
 */
export async function fetchChannelModels(chRef) {
  const ch = getChannel(chRef);
  if (!ch) { const e = new Error(`渠道不存在: ${chRef}`); e.status = 404; throw e; }

  const k = listKeys({ channel: ch.id, enabledOnly: true })[0];
  if (!k) { const e = new Error(`渠道 ${ch.name} 下没有启用的 Key，无法拉取`); e.status = 400; throw e; }

  const adapter = getAdapter(ch.adapter);
  const secret = getKeySecret(k.uuid);

  const res2 = await fetch(adapter.modelsUrl(ch.base_url), {
    method: 'GET',
    headers: adapter.headers(secret),
    signal: AbortSignal.timeout(config.upstreamConnectTimeoutMs),
  });
  const text = await res2.text();
  const verdict = adapter.classify(res2.status, res2.headers, text);
  if (verdict.errClass !== ErrClass.OK) {
    const e = new Error(verdict.message || `上游返回 ${res2.status}`);
    e.status = 502;
    e.httpStatus = res2.status;
    throw e;
  }
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }

  // 混合渠道（如 OpenRouter：465 个里只有 16 个免费）默认只收免费模型。
  // 付费模型放进目录会让下游清单被淹没，且误调用会真实扣费。
  const upstreamTotal = Array.isArray(json?.data) ? json.data.length : 0;
  let ids = adapter.parseModels(json);
  const freeFiltered = upstreamTotal > ids.length;

  // ⭐「只接快速模型」—— 对目录严重虚胖的渠道（NVIDIA：80 个里真能用个位数），
  //   默认只收录**实测可用且快**的那几个。开关默认打开，可在设置页关闭。
  let fastFiltered = false;
  let fastBanned = 0;
  if (fastModelsOnly() && isFastOnlyChannel(ch.name)) {
    const before = ids.length;
    const allowed = ids.filter((id) => isFastModel(ch.name, id));
    const dropped = ids.filter((id) => !isFastModel(ch.name, id));
    ids = allowed;
    fastFiltered = before !== ids.length;
    log.info(`[models/fetch] ${ch.name} 只接快速模型：${before} → ${ids.length}`
      + `（白名单 ${fastModelsOf(ch.name).length} 个）`);
    // ⭐ 被挡掉的模型**也**进黑名单（用户要求「nvidia 那些模型开启了快速模式后
    //   就默认拉黑」）。否则它们只会"不在目录里"而**不在黑名单里**，
    //   用户完全看不到"为什么没有它"。
    //   ⚠️ 这一步必须在这里做：这些模型**不会进入 upstream_model 表**，
    //      任何"事后扫目录"的同步都扫不到它们。
    fastBanned = blacklist.banMany({
      channel: ch.name,
      models: dropped,
      reason: '快速模式未收录：该渠道目录虚胖（多数模型 404/410 或挂死），'
        + '只保留实测可用的快速模型。可在设置页关闭「只接快速模型」或手动解禁。',
      source: blacklist.BanSource.FAST_MODE,
    }).added;
  }

  // 落库：上游有什么，下游就能看到什么
  const saved = catalog.replaceChannelModels(ch.id, ids);
  // 自动生成友好别名（原名照样能用，友好名只是额外入口）
  const auto = catalog.seedFriendlyAliases(ch.id, ids);

  log.info(`[models/fetch] ${ch.name} 上游 ${upstreamTotal} 个 → 收录 ${ids.length} 个，`
    + `自动生成 ${auto.created} 条友好别名`);

  return {
    ok: true, channel: ch.name, channelDisplay: ch.display_name,
    count: ids.length, saved, upstreamTotal, freeFiltered, fastFiltered,
    fastBanned, autoAliases: auto.created, models: ids,
  };
}

/**
 * 重拉**所有快速渠道**的目录（开关从关→开时用）。
 *
 * ⭐ 为什么必须重拉：拉目录时被白名单挡下的模型不进 `upstream_model` 表，
 *    所以"扫目录"恢复不了它们；只有重拉一次，`fetch` 的过滤分支才会重新落黑名单。
 *
 * 单个渠道失败**不阻断**别的渠道（记进 errors）。
 * @returns {Promise<{channels:string[], added:number, errors:string[]}>}
 */
export async function refetchFastChannels() {
  const names = listChannels().filter((c) => c.enabled && isFastOnlyChannel(c.name)).map((c) => c.name);
  const out = { channels: names, added: 0, errors: [] };
  for (const name of names) {
    try {
      const r = await fetchChannelModels(name);
      out.added += r.fastBanned ?? 0;
    } catch (e) {
      out.errors.push(`${name}: ${e.message}`);
      log.warn(`[settings] 重拉 ${name} 目录失败: ${e.message}`);
    }
  }
  return out;
}

export default { fetchChannelModels, refetchFastChannels };
