/**
 * 管理 API · 模型黑名单 + 模型归并（同义名）。
 *
 * ⭐ 用户要求（2026-10-08）：
 *   「连续失败过多的模型+渠道自动禁用 …… 不在在模型列表出现」
 *   「加入的是原始渠道名称+原始上游模型名称 不是转换后的名称」
 *   「之前确定用不了的模型就直接拉黑了 让用户能看到 为什么拉黑」
 *   「nvdia那些模型开启了快速模式后就默认拉黑」
 *
 *   GET    /api/blacklist               列黑名单（可按 channel / source 过滤）
 *   POST   /api/blacklist               手动加入（body: {channel, model, reason}）
 *   POST   /api/blacklist/unban         解禁（body: {channel, model}）
 *   POST   /api/blacklist/sync-fast     按当前快速模式开关重算 fast-mode 拉黑
 *   GET    /api/synonyms                列模型归并（别名 → 规范名）
 *   POST   /api/synonyms                新增归并
 *   DELETE /api/synonyms/:name          删除一条归并
 */
import * as ban from '../db/channel-ban.mjs';
import * as syn from '../db/synonyms.mjs';
import { fastModelsOnly } from '../db/settings.mjs';
import { readJson, sendJson, matchPath, HttpError } from './util.mjs';

export async function handleBlacklist(req, res, url) {
  const { pathname } = url;
  const method = req.method;

  // ---- 黑名单 ----
  if (pathname === '/api/blacklist' && method === 'GET') {
    return sendJson(res, 200, {
      banned: ban.listBanned({
        channel: url.searchParams.get('channel'),
        source: url.searchParams.get('source'),
      }),
      /** 来源枚举，供前端下拉筛选 */
      sources: Object.entries(ban.SOURCE_LABEL).map(([value, label]) => ({ value, label })),
    });
  }

  if (pathname === '/api/blacklist' && method === 'POST') {
    const body = await readJson(req);
    const rec = ban.ban({
      channel: body?.channel,
      model: body?.model,
      reason: String(body?.reason ?? '').trim() || '手动加入',
      source: ban.BanSource.MANUAL,
    });
    return sendJson(res, 201, { ok: true, banned: rec });
  }

  if (pathname === '/api/blacklist/unban' && method === 'POST') {
    const body = await readJson(req);
    if (!body?.channel || !body?.model) throw new HttpError(400, '需要 channel 与 model');
    const ok = ban.unban({ channel: body.channel, model: body.model });
    if (!ok) throw new HttpError(404, '该 (渠道,模型) 不在黑名单里');
    return sendJson(res, 200, { ok: true, unbaned: true, channel: body.channel, model: body.model });
  }

  // 按当前「快速模式」开关重算 fast-mode 拉黑（开关切换后由设置页调用）
  if (pathname === '/api/blacklist/sync-fast' && method === 'POST') {
    const r = ban.applyFastModeBans(fastModelsOnly());
    return sendJson(res, 200, { ok: true, ...r });
  }

  // ---- 归并（同义名）----
  if (pathname === '/api/synonyms') {
    if (method === 'GET') {
      return sendJson(res, 200, {
        synonyms: syn.listSynonyms().map((s) => ({
          name: s.name, canonical: s.canonical, note: s.note, createdAt: s.created_at,
        })),
      });
    }
    if (method === 'POST') {
      const body = await readJson(req);
      try {
        const rec = syn.addSynonym({ name: body?.name, canonical: body?.canonical, note: body?.note ?? null });
        return sendJson(res, 201, {
          ok: true,
          synonym: { name: rec.name, canonical: rec.canonical, note: rec.note, createdAt: rec.created_at },
        });
      } catch (e) {
        throw new HttpError(e.status ?? 400, e.message);
      }
    }
  }

  const ps = matchPath('/api/synonyms/:name', pathname);
  if (ps && method === 'DELETE') {
    const ok = syn.deleteSynonym(decodeURIComponent(ps.name));
    if (!ok) throw new HttpError(404, `归并不存在: ${ps.name}`);
    return sendJson(res, 200, { ok: true, deleted: true });
  }

  return false;
}

export default { handleBlacklist };
