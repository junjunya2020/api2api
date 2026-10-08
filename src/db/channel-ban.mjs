/**
 * ⭐ 模型黑名单 —— 原始 (渠道 × 上游模型)。
 *
 * 用户要求（2026-10-08）：
 *   「连续失败过多的模型+渠道自动禁用 比如一个模型 从来没成功过 每次调用都失败
 *     不在在模型列表出现」
 *   「加入的是原始渠道名称+原始上游模型名称 不是转换后的名称」
 *   「之前确定用不了的模型就直接拉黑了 让用户能看到 为什么拉黑」
 *   「nvdia那些模型开启了快速模式后就默认拉黑」
 *
 * 与 `model_health` 的分工（**互补，不替代**）：
 *
 *   | | model_health | model_blacklist |
 *   |---|---|---|
 *   | 语义 | 运行时健康度（三级） | **永久**拉黑 |
 *   | 恢复 | 24h 后自动降到 DEGRADED 观察 | **只能手动解禁** |
 *   | 效果 | DEGRADED 只试 1 次 / UNAVAILABLE 跳过 | **一次请求都不发** |
 *   | 理由 | 自动生成 | 明确的人类可读理由 |
 *   | 展示 | 观测页 | **从下游模型清单里彻底消失** |
 *
 * ⚠️ 键是 (channel_id, model)，即**原始渠道 + 原始上游模型名**，
 *    不是对外名、不是转换后的名字 —— 用户明确要求。
 */
import { all, one, run, tx } from './index.mjs';
import { getChannel } from './channels.mjs';
import { listChannelModels } from './catalog.mjs';
import { isFastOnlyChannel, fastModelsOf } from './fast-models.mjs';
import { autoBlacklistEnabled } from './settings.mjs';
import config from '../config.mjs';
import log from '../util/log.mjs';

export const BanSource = {
  BUILTIN: 'builtin',       // 内置"已确定用不了"名单
  FAST_MODE: 'fast-mode',   // 快速模式未收录
  AUTO: 'auto',             // 连续失败自动加入
  MANUAL: 'manual',         // 人工加入
};

export const SOURCE_LABEL = {
  builtin: '内置（已确定用不了）',
  'fast-mode': '快速模式未收录',
  auto: '连续失败自动加入',
  manual: '手动加入',
};

function shape(r) {
  return {
    channel: r.channel_name,
    channelDisplay: r.channel_display,
    /** ⭐ 原始上游模型名（不是对外名 / 不是转换后的名字） */
    model: r.model,
    reason: r.reason,
    source: r.source,
    sourceLabel: SOURCE_LABEL[r.source] ?? r.source,
    failCount: r.fail_count ?? 0,
    okCount: r.ok_count ?? 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function listBanned({ channel = null, source = null } = {}) {
  let sql = `SELECT b.*, c.name AS channel_name, c.display_name AS channel_display, c.sort_order
             FROM model_blacklist b JOIN channel c ON c.id = b.channel_id`;
  const where = [];
  const params = [];
  if (channel) {
    const ch = getChannel(channel);
    if (ch) { where.push('b.channel_id = ?'); params.push(ch.id); }
    else { where.push('c.name = ?'); params.push(String(channel)); }
  }
  if (source) { where.push('b.source = ?'); params.push(String(source)); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY c.sort_order, b.model';
  return all(sql, ...params).map(shape);
}

/**
 * relay 用的 O(1) 查询：返回 `${channelId}::${model}` 的集合。
 * 一次全量读进内存（黑名单规模是个位到百位级，完全可接受）。
 */
export function bannedPairSet() {
  const rows = all('SELECT channel_id, model FROM model_blacklist');
  return new Set(rows.map((r) => `${r.channel_id}::${r.model}`));
}

/** 单个判定（管理/测试用） */
export function isBanned(channelRef, model) {
  const ch = getChannel(channelRef);
  if (!ch) return false;
  const row = one('SELECT 1 AS x FROM model_blacklist WHERE channel_id = ? AND model = ?', ch.id, String(model));
  return !!row;
}

/** 加入黑名单（幂等 upsert）。 */
export function ban({ channel, model, reason = '', source = BanSource.MANUAL,
  failCount = 0, okCount = 0 }) {
  const ch = getChannel(channel);
  if (!ch) throw new Error(`渠道不存在: ${channel}`);
  const m = String(model ?? '').trim();
  if (!m) throw new Error('model 必填');
  const now = Date.now();
  run(`INSERT INTO model_blacklist (channel_id, model, reason, source, fail_count, ok_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(channel_id, model) DO UPDATE SET
         reason = excluded.reason, source = excluded.source,
         fail_count = excluded.fail_count, ok_count = excluded.ok_count,
         updated_at = excluded.updated_at`,
  ch.id, m, reason, source, Math.trunc(failCount) || 0, Math.trunc(okCount) || 0, now, now);
  return { channel: ch.name, model: m, reason, source };
}

export function unban({ channel, model }) {
  const ch = getChannel(channel);
  if (!ch) return false;
  return run('DELETE FROM model_blacklist WHERE channel_id = ? AND model = ?', ch.id, String(model)).changes > 0;
}

/** 清空某来源的全部记录（切开关时用） */
export function clearBySource(source) {
  return run('DELETE FROM model_blacklist WHERE source = ?', String(source)).changes;
}

/**
 * ⭐ 内置"已确定用不了"名单（`src/db/builtin-bans.mjs`）—— 首次启动落库。
 * 幂等：已存在的行不动（用户可能手动改过理由）。
 */
export function syncBuiltinBans(list) {
  let added = 0;
  tx(() => {
    for (const b of list) {
      const ch = getChannel(b.channel);
      if (!ch) continue;
      const exists = one('SELECT 1 AS x FROM model_blacklist WHERE channel_id = ? AND model = ?', ch.id, b.model);
      if (exists) continue;
      const now = Date.now();
      run(`INSERT INTO model_blacklist (channel_id, model, reason, source, fail_count, ok_count, created_at, updated_at)
           VALUES (?, ?, ?, ?, 0, 0, ?, ?)`,
      ch.id, b.model, b.reason, b.source ?? BanSource.BUILTIN, now, now);
      added++;
    }
  });
  if (added) log.info(`[blacklist] 内置拉黑 ${added} 个 (渠道,模型)`);
  return added;
}

/**
 * 批量加入黑名单（同一渠道 + 同一来源）。
 * 用于「拉目录时被快速白名单挡掉的那些模型」—— 用户要求
 * 「nvdia那些模型开启了快速模式后就默认拉黑」。
 *
 * @param {{channel:string, models:string[], reason:string, source:string}} p
 * @returns {{added:number}} added = 新增行数（已存在的跳过）
 */
export function banMany({ channel, models, reason, source = BanSource.MANUAL }) {
  const ch = getChannel(channel);
  if (!ch) return { added: 0 };
  let added = 0;
  const now = Date.now();
  tx(() => {
    for (const raw of models) {
      const m = String(raw ?? '').trim();
      if (!m) continue;
      const exists = one('SELECT 1 AS x FROM model_blacklist WHERE channel_id = ? AND model = ?', ch.id, m);
      if (exists) continue;
      run(`INSERT INTO model_blacklist (channel_id, model, reason, source, fail_count, ok_count, created_at, updated_at)
           VALUES (?, ?, ?, ?, 0, 0, ?, ?)`, ch.id, m, reason, source, now, now);
      added++;
    }
  });
  if (added) log.info(`[blacklist] ${ch.name} 批量拉黑 ${added} 个（${source}）`);
  return { added };
}

/**
 * ⭐ 「快速模式」拉黑同步（用户 2026-10-08 要求）。
 *
 * 语义：只要「只接快速模型」开关**打开**，对快速渠道（目前只有 nvidia），
 * 把**该渠道目录里存在、但不在快速白名单里**的模型全部拉黑；
 * 开关关闭 → 移除所有 fast-mode 来源的拉黑（恢复可调用）。
 *
 * ⚠️⚠️ 这里**只能覆盖"目录里还留着"的残留** —— 真正的大头（拉目录时被白名单
 *    挡下的那几十个）**根本不在 `upstream_model` 表里**，扫目录扫不到。
 *    那部分由 `POST /api/models/fetch` 在过滤的当下 `banMany` 落库。
 *    所以：**关开关再开回来时，`fetch` 时落的那批无法靠本函数恢复** ——
 *    要恢复只能重拉一次目录（见 admin-meta 的重开逻辑）。
 *
 * @param {boolean} fastOn 「只接快速模型」当前是否打开
 */
export function applyFastModeBans(fastOn) {
  const channels = all('SELECT id, name FROM channel WHERE enabled = 1');
  let added = 0;
  let removed = 0;
  tx(() => {
    for (const c of channels) {
      if (!isFastOnlyChannel(c.name)) continue;
      const whitelist = new Set(fastModelsOf(c.name).map(String));
      const inCatalog = listChannelModels(c.id).map((m) => m.model_id);
      const now = Date.now();
      for (const mid of inCatalog) {
        if (whitelist.has(String(mid))) continue;
        const exists = one('SELECT 1 AS x FROM model_blacklist WHERE channel_id = ? AND model = ? AND source = ?',
          c.id, mid, BanSource.FAST_MODE);
        if (exists) continue;
        run(`INSERT INTO model_blacklist (channel_id, model, reason, source, fail_count, ok_count, created_at, updated_at)
             VALUES (?, ?, ?, ?, 0, 0, ?, ?)`,
        c.id, mid, '快速模式未收录（该渠道目录虚胖，仅保留实测可用的快速模型）', BanSource.FAST_MODE, now, now);
        added++;
      }
    }
    if (!fastOn) {
      removed = run('DELETE FROM model_blacklist WHERE source = ?', BanSource.FAST_MODE).changes;
    }
  });
  if (added || removed) {
    log.info(`[blacklist] 快速模式同步：新增 ${added} / 移除 ${removed}（开关=${fastOn ? '开' : '关'}）`);
  }
  return { added, removed };
}

/**
 * ⭐ 自动拉黑判定（用户 2026-10-08：「连续失败过多的模型+渠道自动禁用，
 *    比如一个模型 从来没成功过 每次调用都失败」）。
 *
 * 由 `recordModelFailure` 在**每次模型级失败**后调用。
 *
 * 判据（严格）：
 *   ① 自动拉黑开关打开
 *   ② 该 (渠道,模型) **从未成功过**（total_ok === 0）
 *   ③ 累计失败 ≥ `modelAutoBanAfterFails`
 *
 * 为什么要求"从未成功过"：偶尔能出字的模型不该被**永久**拉黑 ——
 * 它的高失败率交给 model_health 的三级熔断（会自动恢复）。
 * 这张表是永久的，只收"压根没救"的。
 *
 * ⚠️ 已有的 builtin / manual 记录不会被降级覆盖（保留更权威的理由）。
 *
 * @returns {{banned:boolean, reason?:string, model?:string}}
 */
export function maybeAutoBan(channelId, model, channelName = null) {
  if (!autoBlacklistEnabled()) return { banned: false };
  const row = one(`SELECT total_ok, total_fail FROM model_health WHERE channel_id = ? AND model = ?`,
    channelId, String(model));
  if (!row) return { banned: false };
  const ok = row.total_ok ?? 0;
  const fail = row.total_fail ?? 0;
  const need = Math.max(1, Number(config.modelAutoBanAfterFails) || 10);
  if (ok > 0 || fail < need) return { banned: false };

  const existing = one('SELECT source FROM model_blacklist WHERE channel_id = ? AND model = ?',
    channelId, String(model));
  if (existing && (existing.source === BanSource.BUILTIN || existing.source === BanSource.MANUAL
    || existing.source === BanSource.FAST_MODE)) {
    return { banned: false };
  }

  const chName = channelName || one('SELECT name FROM channel WHERE id = ?', channelId)?.name || channelId;
  const reason = `连续失败 ${fail} 次且**从未成功过**（0 次成功）—— 判定该模型在该渠道不可用，`
    + '已自动加入黑名单（不再尝试、不再列出；可在设置页解禁）。';
  ban({ channel: chName, model, reason, source: BanSource.AUTO, failCount: fail, okCount: ok });
  log.warn(`[blacklist] 自动拉黑 ${chName}/${model}（失败 ${fail} 次、成功 ${ok} 次）`);
  return { banned: true, reason, model: String(model) };
}

export default {
  BanSource, SOURCE_LABEL, listBanned, bannedPairSet, isBanned,
  ban, banMany, unban, clearBySource, syncBuiltinBans, applyFastModeBans, maybeAutoBan,
};
