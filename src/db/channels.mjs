/**
 * 渠道仓储。内置渠道预置，不使用 CRUD 界面；仅支持列出 / 查询 / 启停。
 */
import { all, one, run, tx } from './index.mjs';

/** 渠道默认步长：拉开间距，方便手工插入而不必重排。 */
export const SORT_STEP = 10;

/** 列出全部渠道（含 Key 计数） */
export function listChannels() {
  return all(`
    SELECT c.id, c.name, c.display_name, c.adapter, c.base_url, c.default_model,
           c.enabled, c.sort_order, c.note, c.created_at,
           (SELECT COUNT(*) FROM channel_key k WHERE k.channel_id = c.id) AS key_count,
           (SELECT COUNT(*) FROM channel_key k WHERE k.channel_id = c.id AND k.enabled = 1) AS key_enabled_count
    FROM channel c
    ORDER BY c.sort_order ASC, c.name ASC
  `);
}

export function getChannel(idOrName) {
  return one(
    'SELECT * FROM channel WHERE id = ? OR name = ?',
    String(idOrName), String(idOrName),
  );
}

export function getChannelById(id) {
  return one('SELECT * FROM channel WHERE id = ?', String(id));
}

/** 只允许改本地运维字段，不允许改 base_url / adapter（内置渠道契约） */
export function updateChannel(id, patch) {
  const cur = getChannelById(id);
  if (!cur) return null;
  const next = {
    display_name: patch.display_name ?? cur.display_name,
    default_model: patch.default_model ?? cur.default_model,
    enabled: patch.enabled === undefined ? cur.enabled : (patch.enabled ? 1 : 0),
    sort_order: patch.sort_order ?? cur.sort_order,
    note: patch.note ?? cur.note,
  };
  run(
    `UPDATE channel SET display_name=?, default_model=?, enabled=?, sort_order=?, note=?
     WHERE id=?`,
    next.display_name, next.default_model, next.enabled, next.sort_order, next.note, id,
  );
  return getChannelById(id);
}

/**
 * 按给定的渠道名顺序**整体重排**，步长 SORT_STEP。
 *
 * 这是「渠道优先级」的唯一写入口 —— 前端拖拽后一次性提交完整顺序，
 * 避免逐条 PATCH 造成中间态（比如两条渠道暂时同序）。
 *
 * @param {string[]} orderedNames 期望的渠道顺序（name），未列出的排在最后、保持原相对序
 * @returns {Array} 重排后的渠道列表
 */
export function reorderChannels(orderedNames) {
  const all0 = listChannels();
  const byName = new Map(all0.map((c) => [c.name, c]));
  const seen = new Set();
  const finalOrder = [];

  for (const n of orderedNames) {
    if (byName.has(n) && !seen.has(n)) {
      finalOrder.push(byName.get(n));
      seen.add(n);
    }
  }
  // 未列出的补在后面，保持原有相对顺序
  for (const c of all0) {
    if (!seen.has(c.name)) finalOrder.push(c);
  }

  tx(() => {
    finalOrder.forEach((c, i) => {
      run('UPDATE channel SET sort_order = ? WHERE id = ?', (i + 1) * SORT_STEP, c.id);
    });
  });
  return listChannels();
}

/** 对外简报：不含敏感字段 */
export function publicChannelBrief() {
  return listChannels().map((c) => ({
    id: c.id,
    name: c.name,
    displayName: c.display_name,
    adapter: c.adapter,
    baseUrl: c.base_url,
    defaultModel: c.default_model,
    enabled: !!c.enabled,
    sortOrder: c.sort_order ?? 0,
    keyCount: c.key_count,
    keyEnabledCount: c.key_enabled_count,
  }));
}

export default {
  listChannels, getChannel, getChannelById, updateChannel,
  reorderChannels, publicChannelBrief, SORT_STEP,
};
