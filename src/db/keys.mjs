/**
 * Key 仓储。核心约束：
 *   - uuid 是主键，由调用方传入（外部系统可幂等对接）
 *   - 同渠道内密钥指纹唯一 —— 明文不同但等价的 Key 也不会重复入库
 *   - 明文永不落盘
 */
import { all, one, run, tx } from './index.mjs';
import { encryptSecret, decryptSecret, fingerprint } from '../util/crypto.mjs';
import { getChannel } from './channels.mjs';

export class DupKeyError extends Error {
  constructor(msg) { super(msg); this.name = 'DupKeyError'; this.status = 409; }
}
export class BadRequestError extends Error {
  constructor(msg) { super(msg); this.name = 'BadRequestError'; this.status = 400; }
}

/** 入参校验 */
function normalizeInput({ channel, key, uuid, name, priority, weight, owner }) {
  if (!channel || typeof channel !== 'string') throw new BadRequestError('channel 必填');
  if (!key || typeof key !== 'string' || !key.trim()) throw new BadRequestError('key 必填');
  if (!uuid || typeof uuid !== 'string' || !uuid.trim()) throw new BadRequestError('uuid 必填');
  if (uuid.length > 190) throw new BadRequestError('uuid 过长（上限 190）');
  const own = owner == null ? '' : String(owner).trim();
  if (own.length > 190) throw new BadRequestError('owner 过长（上限 190）');
  return {
    channel: channel.trim(),
    key: key.trim(),
    uuid: uuid.trim(),
    owner: own,
    name: name == null || name === '' ? null : String(name).slice(0, 190),
    priority: Number.isFinite(+priority) ? Math.trunc(+priority) : 0,
    weight: Number.isFinite(+weight) && +weight > 0 ? Math.trunc(+weight) : 1,
  };
}

/** 新增单个 Key */
export function addKey(input) {
  const v = normalizeInput(input);
  const ch = getChannel(v.channel);
  if (!ch) throw new BadRequestError(`渠道不存在: ${v.channel}`);

  const fp = fingerprint(v.key);

  const existingUuid = one('SELECT uuid FROM channel_key WHERE uuid = ?', v.uuid);
  if (existingUuid) throw new DupKeyError(`uuid 已存在: ${v.uuid}`);

  const existingFp = one('SELECT uuid FROM channel_key WHERE channel_id = ? AND secret_fp = ?', ch.id, fp);
  if (existingFp) throw new DupKeyError(`该渠道下相同 Key 已存在（uuid=${existingFp.uuid}）`);

  const now = Date.now();
  run(
    `INSERT INTO channel_key
      (uuid, channel_id, owner, name, secret_enc, secret_fp, priority, weight, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    v.uuid, ch.id, v.owner, v.name, encryptSecret(v.key), fp, v.priority, v.weight, now, now,
  );
  return getKey(v.uuid);
}

/** 批量新增：逐个尝试，返回每条结果（部分成功不整体回滚） */
export function addKeysBulk(channelRef, items) {
  if (!Array.isArray(items)) throw new BadRequestError('keys 必须是数组');
  const results = [];
  for (const it of items) {
    try {
      const rec = addKey({ ...it, channel: it.channel ?? channelRef });
      results.push({ ok: true, uuid: rec.uuid });
    } catch (e) {
      results.push({ ok: false, uuid: it?.uuid ?? null, error: e.message, status: e.status ?? 500 });
    }
  }
  return {
    total: items.length,
    okCount: results.filter((r) => r.ok).length,
    failCount: results.filter((r) => !r.ok).length,
    results,
  };
}

const KEY_COLS = `k.uuid, k.channel_id, k.owner, k.name, k.priority, k.weight, k.enabled,
  k.last_checked, k.last_ok, k.last_error, k.grace_until, k.created_at, k.updated_at,
  c.name AS channel_name, c.display_name AS channel_display`;

/** 查询单个（不含明文） */
export function getKey(uuid) {
  return one(`SELECT ${KEY_COLS} FROM channel_key k JOIN channel c ON c.id = k.channel_id WHERE k.uuid = ?`, uuid);
}

/** 取明文（仅内部转发使用，绝不外泄） */
export function getKeySecret(uuid) {
  const row = one('SELECT secret_enc FROM channel_key WHERE uuid = ?', uuid);
  if (!row) return null;
  return decryptSecret(row.secret_enc);
}

/**
 * 列出 Key；可按渠道过滤。永不返回明文。
 *
 * `owner` 语义（三态，务必区分）：
 *   - `undefined` → **不过滤**，返回全部（管理后台用）
 *   - `''`        → 只要系统 Key（owner 为空）
 *   - `'abc'`     → 只要该 owner 的 Key
 */
export function listKeys({ channel = null, enabledOnly = false, owner } = {}) {
  let sql = `SELECT ${KEY_COLS} FROM channel_key k JOIN channel c ON c.id = k.channel_id`;
  const where = [];
  const params = [];
  if (channel) { where.push('(c.id = ? OR c.name = ?)'); params.push(channel, channel); }
  if (enabledOnly) where.push('k.enabled = 1');
  if (owner !== undefined) { where.push('k.owner = ?'); params.push(owner == null ? '' : String(owner)); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY c.sort_order ASC, k.priority DESC, k.created_at ASC';
  return all(sql, ...params);
}

/** 该 owner 名下的 Key uuid 集合（用于归属校验，避免越权操作） */
export function ownerKeyUuids(owner) {
  const own = owner == null ? '' : String(owner);
  return new Set(all('SELECT uuid FROM channel_key WHERE owner = ?', own).map((r) => r.uuid));
}

/**
 * 列出**所有绑过 Key 的 owner**（含各自 Key 数）。
 *
 * 供桥的后台巡检遍历 —— 桥需要知道"该检查哪些用户"。
 * `owner = ''` 是系统 Key（管理员自己加的），**不返回**：
 * 系统 Key 失效不该触发任何用户分组动作。
 */
export function listOwners() {
  return all(`SELECT owner, COUNT(*) AS keyCount
              FROM channel_key
              WHERE owner IS NOT NULL AND owner <> ''
              GROUP BY owner
              ORDER BY owner`);
}

/** 更新名称/优先级/权重/启停 */
export function patchKey(uuid, patch) {
  const cur = getKey(uuid);
  if (!cur) return null;
  const next = {
    name: patch.name === undefined ? cur.name : (patch.name === '' ? null : String(patch.name).slice(0, 190)),
    priority: Number.isFinite(+patch.priority) ? Math.trunc(+patch.priority) : cur.priority,
    weight: Number.isFinite(+patch.weight) && +patch.weight > 0 ? Math.trunc(+patch.weight) : cur.weight,
    enabled: patch.enabled === undefined ? cur.enabled : (patch.enabled ? 1 : 0),
  };
  run('UPDATE channel_key SET name=?, priority=?, weight=?, enabled=?, updated_at=? WHERE uuid=?',
    next.name, next.priority, next.weight, next.enabled, Date.now(), uuid);
  return getKey(uuid);
}

/** 删除 Key。级联清理 key_state */
export function deleteKey(uuid) {
  const res = run('DELETE FROM channel_key WHERE uuid = ?', uuid);
  return res.changes > 0;
}

/** 删除某渠道下全部 Key */
export function deleteKeysByChannel(channelRef) {
  const ch = getChannel(channelRef);
  if (!ch) return 0;
  const res = run('DELETE FROM channel_key WHERE channel_id = ?', ch.id);
  return res.changes;
}

/** 测活结果回写 */
export function markChecked(uuid, ok, error = null) {
  run('UPDATE channel_key SET last_checked=?, last_ok=?, last_error=?, updated_at=? WHERE uuid=?',
    Date.now(), ok ? 1 : 0, error, Date.now(), uuid);
}

/**
 * 复核续期：把该 Key 的「零成功判定」豁免延到 now + ms（滑动窗口）。
 *
 * ⭐ 用户要求（2026-10-07）：
 *   「复核通过后相当于继续三天缓冲，能一直调用最好」
 *   —— 只要每轮复核还能出字，就再保 3 天，可以无限续下去。
 *
 * 取 **max(现有到期时间, 现在+ms)** 而不是直接覆盖：
 * 连续两次复核之间不该因为某次晚到而把窗口缩短。
 *
 * @returns 新的到期时间戳
 */
export function renewGrace(uuid, ms, now = Date.now()) {
  const until = now + Math.max(0, Number(ms) || 0);
  run(`UPDATE channel_key SET grace_until = MAX(COALESCE(grace_until, 0), ?), updated_at = ?
       WHERE uuid = ?`, until, now, uuid);
  return until;
}

/** 读某个 Key 的豁免到期时间（0 = 无豁免） */
export function graceUntilOf(uuid) {
  const row = one('SELECT grace_until FROM channel_key WHERE uuid = ?', uuid);
  return Number(row?.grace_until || 0);
}

/** 取候选 Key（含明文），按渠道 + 模型状态过滤。供调度器使用 */
export function candidatesForChannel(channelId, model, now = Date.now()) {
  const rows = all(`
    SELECT k.uuid, k.priority, k.weight, k.secret_enc,
           COALESCE(s.state, 'READY') AS state,
           COALESCE(s.next_retry_at, 0) AS next_retry_at,
           COALESCE(s.current_weight, 0) AS current_weight,
           COALESCE(s.fail_streak, 0) AS fail_streak
    FROM channel_key k
    LEFT JOIN key_state s ON s.key_uuid = k.uuid AND s.model = ?
    WHERE k.channel_id = ? AND k.enabled = 1
    ORDER BY k.priority DESC, k.created_at ASC
  `, model, channelId);

  return rows
    .filter((r) => r.state !== 'DISABLED')
    .filter((r) => !(r.state === 'COOLDOWN' && r.next_retry_at > now))
    .map((r) => ({
      uuid: r.uuid,
      priority: r.priority,
      weight: r.weight,
      secret: decryptSecret(r.secret_enc),
      state: r.state === 'COOLDOWN' ? 'READY' : r.state,
      currentWeight: r.current_weight,
    }));
}

/** 统计：Key 总数 / 各状态数 */
export function keyStats() {
  return all(`
    SELECT c.name AS channel, c.display_name,
           COUNT(k.uuid) AS total,
           SUM(CASE WHEN k.enabled = 1 THEN 1 ELSE 0 END) AS enabled,
           SUM(CASE WHEN k.last_ok = 1 THEN 1 ELSE 0 END) AS healthy,
           SUM(CASE WHEN k.last_ok = 0 THEN 1 ELSE 0 END) AS unhealthy
    FROM channel c LEFT JOIN channel_key k ON k.channel_id = c.id
    GROUP BY c.id ORDER BY c.sort_order
  `);
}

export { normalizeInput };
export default {
  addKey, addKeysBulk, getKey, getKeySecret, listKeys, patchKey,
  deleteKey, deleteKeysByChannel, markChecked, candidatesForChannel, keyStats,
  ownerKeyUuids, listOwners, renewGrace, graceUntilOf,
};
