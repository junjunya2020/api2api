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
 *
 * 注：模型黑名单 / 归并 在 `admin-blacklist.mjs`。
 */
import * as aliases from '../db/aliases.mjs';
import * as catalog from '../db/catalog.mjs';
import { getChannel, listChannels } from '../db/channels.mjs';
import { fetchChannelModels } from './models-fetch.mjs';
import { readJson, sendJson, matchPath, HttpError } from './util.mjs';
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
    // ⭐ `?channel=` → 只看该渠道的模型（用户 2026-10-08：按渠道 / 指纹页选渠道后
    //    模型下拉框只列该渠道的模型）。用的是与"渠道作用域 token"同一套逻辑。
    const only = url.searchParams.get('channel');
    return sendJson(res, 200, {
      object: 'list',
      models: only ? aliases.scopedModelList(only) : aliases.publicModelList(),
      channel: only || null,
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
  //
  // 实现抽到 `models-fetch.mjs`（`fetchChannelModels`）—— 因为「只接快速模型」
  // 开关变更时也要走同一条路径（见 admin-meta 的 PATCH /api/settings），
  // 两处各写一份必然漂移，而漂移的后果是"被快速白名单挡下的模型漏进黑名单"。
  if (pathname === '/api/models/fetch' && method === 'POST') {
    const body = await readJson(req);
    const chRef = body?.channel;
    if (!chRef) throw new HttpError(400, '需要 channel 参数');
    const ch = getChannel(chRef);
    if (!ch) throw new HttpError(404, `渠道不存在: ${chRef}`);
    try {
      const out = await fetchChannelModels(chRef);
      return sendJson(res, 200, { ...out, downstreamTotal: aliases.publicModelList().length });
    } catch (e) {
      log.warn(`[models/fetch] ${ch.name} 失败: ${e.message}`);
      return sendJson(res, e.status === 400 ? 400 : 502, {
        ok: false, httpStatus: e.httpStatus ?? null,
        error: e.status === 400 ? e.message : `拉取失败: ${e.message}`,
      });
    }
  }

  return false;
}

export { shape };
export default { handleAliases };
