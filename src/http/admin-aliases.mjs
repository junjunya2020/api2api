/**
 * 管理 API · 模型映射 + 上游模型目录。
 *
 *   GET    /api/aliases            列映射（可按 channel / publicName 过滤）
 *   POST   /api/aliases            建映射（public_name → upstream_name）
 *   PATCH  /api/aliases/:id        改
 *   DELETE /api/aliases/:id        删
 *   GET    /api/models             下游可见模型清单（= 上游目录 + 映射叠加）
 *   GET    /api/models/upstream    上游目录明细（按渠道分组 + 拉取时间）
 *   POST   /api/models/fetch       拉上游真实模型清单，**并落库** → 下游立即可见
 *   DELETE /api/models/upstream    清空目录（channel=xxx / all=true）
 */
import * as aliases from '../db/aliases.mjs';
import * as catalog from '../db/catalog.mjs';
import { getChannel, listChannels } from '../db/channels.mjs';
import { listKeys, getKeySecret } from '../db/keys.mjs';
import { getAdapter } from '../adapters/index.mjs';
import { ErrClass } from '../util/errors.mjs';
import { readJson, sendJson, matchPath, HttpError } from './util.mjs';
import config from '../config.mjs';
import log from '../util/log.mjs';

function shape(a) {
  if (!a) return null;
  return {
    id: a.id,
    publicName: a.public_name,
    upstreamName: a.upstream_name,
    channel: a.channel_name ?? null,
    channelDisplay: a.channel_display ?? null,
    scope: a.channel_id ? 'channel' : 'global',
    priority: a.priority,
    weight: a.weight,
    enabled: !!a.enabled,
    createdAt: a.created_at,
  };
}

export async function handleAliases(req, res, url) {
  const { pathname } = url;
  const method = req.method;

  if (pathname === '/api/aliases') {
    if (method === 'GET') {
      const list = aliases.listAliases({
        channel: url.searchParams.get('channel'),
        publicName: url.searchParams.get('publicName'),
      });
      return sendJson(res, 200, { aliases: list.map(shape) });
    }
    if (method === 'POST') {
      const body = await readJson(req);
      const rec = aliases.addAlias(body);
      return sendJson(res, 201, { ok: true, alias: shape(rec) });
    }
  }

  const p = matchPath('/api/aliases/:id', pathname);
  if (p) {
    const id = Number(p.id);
    if (!Number.isFinite(id)) throw new HttpError(400, 'id 必须是数字');
    if (method === 'PATCH' || method === 'PUT') {
      const body = await readJson(req);
      const rec = aliases.patchAlias(id, body);
      if (!rec) throw new HttpError(404, `映射不存在: ${id}`);
      return sendJson(res, 200, { ok: true, alias: shape(rec) });
    }
    if (method === 'DELETE') {
      const ok = aliases.deleteAlias(id);
      if (!ok) throw new HttpError(404, `映射不存在: ${id}`);
      return sendJson(res, 200, { ok: true, deleted: true, id });
    }
  }

  if (pathname === '/api/models' && method === 'GET') {
    return sendJson(res, 200, {
      object: 'list',
      models: aliases.publicModelList(),
      upstream: catalog.catalogStats(),
    });
  }

  // 上游目录明细（按渠道分组）
  if (pathname === '/api/models/upstream' && method === 'GET') {
    const stats = catalog.catalogStats();
    const statByCh = new Map(stats.map((s) => [s.channel, s]));
    const groups = listChannels().map((c) => ({
      channel: c.name,
      channelDisplay: c.display_name,
      enabled: !!c.enabled,
      models: catalog.listChannelModels(c.id).map((m) => m.model_id),
      fetchedAt: statByCh.get(c.name)?.fetchedAt ?? null,
    }));
    return sendJson(res, 200, { groups, stats });
  }

  // 清空目录
  if (pathname === '/api/models/upstream' && method === 'DELETE') {
    const all = url.searchParams.get('all') === 'true';
    if (all) {
      let n = 0;
      for (const c of listChannels()) n += catalog.clearChannelModels(c.id);
      return sendJson(res, 200, { ok: true, cleared: n });
    }
    const chRef = url.searchParams.get('channel');
    if (!chRef) throw new HttpError(400, '需要 channel 或 all=true');
    const n = catalog.clearChannelModels(chRef);
    return sendJson(res, 200, { ok: true, cleared: n });
  }

  // 去上游拉真实模型清单，**并落库**
  if (pathname === '/api/models/fetch' && method === 'POST') {
    const body = await readJson(req);
    const chRef = body?.channel;
    if (!chRef) throw new HttpError(400, '需要 channel 参数');
    const ch = getChannel(chRef);
    if (!ch) throw new HttpError(404, `渠道不存在: ${chRef}`);

    const k = listKeys({ channel: ch.id, enabledOnly: true })[0];
    if (!k) throw new HttpError(400, `渠道 ${ch.name} 下没有启用的 Key，无法拉取`);

    const adapter = getAdapter(ch.adapter);
    const secret = getKeySecret(k.uuid);
    try {
      const res2 = await fetch(adapter.modelsUrl(ch.base_url), {
        method: 'GET',
        headers: adapter.headers(secret),
        signal: AbortSignal.timeout(config.upstreamConnectTimeoutMs),
      });
      const text = await res2.text();
      const verdict = adapter.classify(res2.status, res2.headers, text);
      if (verdict.errClass !== ErrClass.OK) {
        return sendJson(res, 502, {
          ok: false, httpStatus: res2.status,
          error: verdict.message || `上游返回 ${res2.status}`,
        });
      }
      let json = null;
      try { json = JSON.parse(text); } catch { /* ignore */ }

      // 混合渠道（如 OpenRouter：465 个里只有 16 个免费）默认只收免费模型。
      // 付费模型放进目录会让下游清单被淹没，且误调用会真实扣费。
      const upstreamTotal = Array.isArray(json?.data) ? json.data.length : 0;
      const ids = adapter.parseModels(json);
      const freeFiltered = upstreamTotal > ids.length;

      // 落库：上游有什么，下游就能看到什么
      const saved = catalog.replaceChannelModels(ch.id, ids);

      // 自动生成友好别名：`deepseek.ai/deepseek-v4.1-flash:free`
      //   → `deepseek-v4.1-flash` / `Deepseek-V4.1-Flash`（都挂在本渠道）
      // 原名照样能用（同名直通），友好名只是额外入口。
      const auto = catalog.seedFriendlyAliases(ch.id, ids);

      log.info(`[models/fetch] ${ch.name} 上游 ${upstreamTotal} 个 → 收录 ${ids.length} 个，`
        + `自动生成 ${auto.created} 条友好别名`);

      return sendJson(res, 200, {
        ok: true, channel: ch.name, channelDisplay: ch.display_name,
        count: ids.length, saved, upstreamTotal, freeFiltered,
        autoAliases: auto.created,
        models: ids,
        downstreamTotal: aliases.publicModelList().length,
      });
    } catch (e) {
      log.warn(`[models/fetch] ${ch.name} 失败: ${e.message}`);
      return sendJson(res, 502, { ok: false, error: `拉取失败: ${e.message}` });
    }
  }

  return false;
}

export { shape };
export default { handleAliases };
