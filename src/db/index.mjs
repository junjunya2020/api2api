/**
 * 数据库连接与通用助手。
 * node:sqlite 的 DatabaseSync 是同步 API —— 对本项目（低频管理写 + 短事务）正合适。
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import config, { ensureDirs } from '../config.mjs';
import { DDL, BUILTIN_CHANNELS } from './schema.mjs';
import { syncBuiltinBans } from './channel-ban.mjs';
import { BUILTIN_BANS } from './builtin-bans.mjs';
import { failOrphanJobs } from './jobs.mjs';
import { uuid } from '../util/crypto.mjs';
import log from '../util/log.mjs';

let db = null;

export function getDb() {
  if (db) return db;
  ensureDirs();
  fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });
  db = new DatabaseSync(config.dbFile);
  // 顺序很重要：DDL 建表（老库上是 no-op）→ **补列** → 建依赖新列的索引。
  // 反过来会在老库上因 "no such column" 直接崩掉整个启动。
  db.exec(DDL);
  migrate();
  ensureIndexes();
  seedBuiltins();
  seedBlacklist();
  orphanJobs();
  return db;
}

/**
 * 启动时把"卡在 queued/running 的历史后台任务"标成失败 ——
 * 进程重启后它们其实已经死了，不能让前端以为"还在跑"。
 */
function orphanJobs() {
  try {
    const n = failOrphanJobs();
    if (n) log.info(`[db] 后台任务：${n} 个中断的任务已标记失败`);
  } catch (e) {
    log.warn(`[db] 处理中断任务失败（不影响运行）: ${e.message}`);
  }
}

/**
 * 预置「已确定用不了」的模型黑名单（用户 2026-10-08 要求）。
 * 幂等：已存在的行不动（用户可能手动改过理由或已解禁）。
 *
 * ⚠️ 放在 seedBuiltins 之后 —— 它按渠道名查 channel 表，渠道必须先存在。
 * ⚠️ 静态 import 造成的循环依赖是安全的：这些模块只在**函数体内**使用
 *    本模块的 all/one/run，模块求值期不会解引用。
 */
function seedBlacklist() {
  try {
    const n = syncBuiltinBans(BUILTIN_BANS);
    if (n) log.info(`[db] 内置模型黑名单：预置 ${n} 条`);
  } catch (e) {
    // 黑名单只是增强，播种失败不该让服务起不来
    log.warn(`[db] 内置模型黑名单播种失败（不影响运行）: ${e.message}`);
  }
}

/** 逐条建索引，且**单条失败不影响启动** ——
 *  索引只是性能优化，不该成为服务起不来的原因。 */
function ensureIndexes() {
  const stmts = [
    'CREATE INDEX IF NOT EXISTS idx_ks_ready ON key_state(state, next_retry_at)',
    'CREATE INDEX IF NOT EXISTS idx_ks_disabled ON key_state(state, disabled_until)',
    'CREATE INDEX IF NOT EXISTS idx_ck_owner ON channel_key(owner, channel_id)',
  ];
  for (const sql of stmts) {
    try {
      db.exec(sql);
    } catch (e) {
      log.warn(`[db] 建索引失败（不影响运行）: ${e.message}`);
    }
  }
}

/**
 * 增量迁移 —— `CREATE TABLE IF NOT EXISTS` 不会给**已存在**的表补列，
 * 所以新增字段必须在这里显式 ALTER。
 * 用 PRAGMA table_info 探测，幂等，可反复执行。
 */
function migrate() {
  const cols = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

  // ---- key_state.disabled_until ----
  try {
    const ks = cols('key_state');
    if (!ks.includes('disabled_until')) {
      db.exec('ALTER TABLE key_state ADD COLUMN disabled_until INTEGER');
      log.info('[db] 迁移：key_state 增加 disabled_until');

      // ⚠️ 旧版本的 DISABLED 行没有 disabled_until，惰性恢复逻辑（要求该字段非空）
      //    永远碰不到它们 → Key 会被**永久禁用**。
      //    而且旧阈值是"连败 3 次"（比新规则的 10 次激进得多），这些禁用多半是误伤。
      //    语义已经变了，让所有旧禁用 Key 重新开始更符合预期。
      const n = db.prepare(`UPDATE key_state SET state='READY', next_retry_at=NULL,
                              disabled_until=NULL, fail_streak=0
                            WHERE state='DISABLED' AND disabled_until IS NULL`).run().changes;
      if (n) log.info(`[db] 迁移：解除 ${n} 条旧版 DISABLED 状态（旧阈值为 3 次，新规则为 10 次）`);
    }
  } catch (e) {
    // 补列失败是**严重**问题（后续所有 SQL 都会挂），必须显式抛出让部署时立刻发现
    log.error('[db] 迁移 key_state 失败:', e.message);
    throw e;
  }

  // ---- channel_key.owner ----
  // 已有 Key 一律归为「系统 Key」（owner=''）—— 它们是管理员自己加的，
  // 不该被任何外部用户通过 owner 接口看到或删除。
  // SQLite 的 ADD COLUMN ... NOT NULL DEFAULT '' 会**自动给存量行填默认值**，
  // 所以这里只需补列，无需再 UPDATE。
  try {
    const ck = cols('channel_key');
    if (!ck.includes('owner')) {
      db.exec(`ALTER TABLE channel_key ADD COLUMN owner TEXT NOT NULL DEFAULT ''`);
      const n = db.prepare(`SELECT COUNT(*) AS n FROM channel_key`).get()?.n ?? 0;
      log.info(`[db] 迁移：channel_key 增加 owner（${n} 条存量 Key 归为系统 Key）`);
    }
  } catch (e) {
    log.error('[db] 迁移 channel_key 失败:', e.message);
    throw e;
  }

  // ---- upstream_model.seq ----
  // 「验活按上游声明顺序逐个试」需要记住模型在 /models 响应里的**原始次序**。
  // 存量行没有 seq（都是 0）→ 补列后按 model_id 赋一个稳定顺序，
  // 让老库在拉取新目录之前也有可用的确定性次序。
  try {
    const um = cols('upstream_model');
    if (!um.includes('seq')) {
      db.exec('ALTER TABLE upstream_model ADD COLUMN seq INTEGER NOT NULL DEFAULT 0');
      // 存量行按 model_id 排序编号（下次拉取目录时会被真实顺序覆盖）
      const rows = db.prepare('SELECT channel_id, model_id FROM upstream_model ORDER BY channel_id, model_id').all();
      const upd = db.prepare('UPDATE upstream_model SET seq = ? WHERE channel_id = ? AND model_id = ?');
      let i = 0; let lastCh = null;
      for (const r of rows) {
        if (r.channel_id !== lastCh) { i = 0; lastCh = r.channel_id; }
        upd.run(i++, r.channel_id, r.model_id);
      }
      log.info(`[db] 迁移：upstream_model 增加 seq（${rows.length} 条存量按名称排序编号）`);
    }
  } catch (e) {
    log.error('[db] 迁移 upstream_model 失败:', e.message);
    throw e;
  }

  // ---- channel_key.grace_until ----
  // 「复核通过 → 续 3 天缓冲」需要把续期**持久化**，否则进程重启就丢，
  // 用户刚复核通过又立刻被判失效。
  // 存量行默认 0 = 无豁免，行为与迁移前一致。
  try {
    const ck = cols('channel_key');
    if (!ck.includes('grace_until')) {
      db.exec('ALTER TABLE channel_key ADD COLUMN grace_until INTEGER NOT NULL DEFAULT 0');
      log.info('[db] 迁移：channel_key 增加 grace_until（复核续期用，存量默认无豁免）');
    }
  } catch (e) {
    log.error('[db] 迁移 channel_key.grace_until 失败:', e.message);
    throw e;
  }

  // ---- client_token.scope_channel ----
  // ⭐ 渠道作用域 token（用户 2026-10-08）：
  //   令牌可以绑定到某个渠道（**只用该渠道的 Key**），用于"测这个渠道真实能力"。
  //   NULL = 全部渠道（原有行为，存量行自动为 NULL）。
  try {
    const ct = cols('client_token');
    if (!ct.includes('scope_channel')) {
      db.exec('ALTER TABLE client_token ADD COLUMN scope_channel TEXT');
      log.info('[db] 迁移：client_token 增加 scope_channel（NULL=全部渠道）');
    }
    if (!ct.includes('scope_note')) {
      db.exec('ALTER TABLE client_token ADD COLUMN scope_note TEXT');
    }
  } catch (e) {
    log.error('[db] 迁移 client_token.scope_channel 失败:', e.message);
    throw e;
  }
}

/** 预置内置渠道：存在则只更新展示性字段，**不覆盖 base_url / adapter**
 *  —— 用户可能把渠道指向镜像站，重启不能把它改回去。 */
function seedBuiltins() {
  const now = Date.now();
  const find = db.prepare('SELECT id FROM channel WHERE name = ?');
  const ins = db.prepare(`INSERT INTO channel
    (id, name, display_name, adapter, base_url, default_model, enabled, sort_order, note, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const upd = db.prepare(`UPDATE channel SET display_name=?, default_model=?, sort_order=?, note=?
    WHERE id=?`);

  for (const c of BUILTIN_CHANNELS) {
    const row = find.get(c.name);
    if (row) {
      upd.run(c.display_name, c.default_model, c.sort_order, c.note, row.id);
    } else {
      ins.run(uuid(), c.name, c.display_name, c.adapter, c.base_url, c.default_model, 1, c.sort_order, c.note, now);
      log.info(`[db] 预置内置渠道: ${c.name}`);
    }
  }
}

/** 所有查询：返回对象数组 */
export function all(sql, ...params) {
  return getDb().prepare(sql).all(...params);
}

/** 单行查询 */
export function one(sql, ...params) {
  return getDb().prepare(sql).get(...params) ?? null;
}

/** 写入，返回 { changes, lastInsertRowid } */
export function run(sql, ...params) {
  return getDb().prepare(sql).run(...params);
}

/** 取单值 */
export function scalar(sql, ...params) {
  const row = one(sql, ...params);
  if (!row) return null;
  return Object.values(row)[0];
}

/** 事务包装。同步执行，异常自动回滚 */
export function tx(fn) {
  const d = getDb();
  d.exec('BEGIN');
  try {
    const out = fn();
    d.exec('COMMIT');
    return out;
  } catch (e) {
    try { d.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }
}

export function closeDb() {
  if (db) {
    try { db.close(); } catch { /* ignore */ }
    db = null;
  }
}

export default { getDb, all, one, run, scalar, tx, closeDb };
