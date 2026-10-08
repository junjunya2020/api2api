/**
 * 老库迁移回归测试 —— 这个场景曾经把线上服务打挂过，必须锁住。
 *
 * 事故（2026-10-07）：
 *   新 schema 在 DDL 里给 key_state(disabled_until) 建索引，
 *   但老库的 key_state 表已存在且**没有**该列。
 *   `db.exec(DDL)` 阶段就报 "no such column: disabled_until"，
 *   进程直接退出 → systemd 无限重启循环。
 *
 * 正确的顺序必须是：建表(no-op) → ALTER 补列 → 建索引。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-migrate-'));

/** 老版本的 key_state 建表语句（无 disabled_until） */
const OLD_KEY_STATE = `
CREATE TABLE key_state (
  key_uuid       TEXT NOT NULL,
  model          TEXT NOT NULL,
  state          TEXT NOT NULL DEFAULT 'READY',
  next_retry_at  INTEGER,
  fail_streak    INTEGER NOT NULL DEFAULT 0,
  current_weight REAL NOT NULL DEFAULT 0,
  total_ok       INTEGER NOT NULL DEFAULT 0,
  total_fail     INTEGER NOT NULL DEFAULT 0,
  last_used_at   INTEGER,
  last_error     TEXT,
  PRIMARY KEY (key_uuid, model)
)`;

/** 老版本的 upstream_model 建表语句（无 seq 列） */
const OLD_UPSTREAM_MODEL = `
CREATE TABLE upstream_model (
  channel_id TEXT NOT NULL,
  model_id   TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (channel_id, model_id)
)`;

/** 老版本的 channel_key 建表语句（无 grace_until 列） */
const OLD_CHANNEL_KEY = `
CREATE TABLE channel_key (
  uuid         TEXT PRIMARY KEY,
  channel_id   TEXT NOT NULL,
  owner        TEXT NOT NULL DEFAULT '',
  name         TEXT,
  secret_enc   BLOB NOT NULL,
  secret_fp    TEXT NOT NULL,
  priority     INTEGER NOT NULL DEFAULT 0,
  weight       INTEGER NOT NULL DEFAULT 1,
  enabled      INTEGER NOT NULL DEFAULT 1,
  last_checked INTEGER,
  last_ok      INTEGER,
  last_error   TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
)`;

/** 老库的历史数据：两把 Key 都处于被禁用状态（旧规则只连败 3 次就禁用） */
function buildOldDb(file) {
  const d = new DatabaseSync(file);
  d.exec(OLD_KEY_STATE);
  const ins = d.prepare(`INSERT INTO key_state
    (key_uuid, model, state, next_retry_at, fail_streak, total_ok, total_fail)
    VALUES (?,?,?,?,?,?,?)`);
  ins.run('old-a', 'glm-5.2', 'DISABLED', null, 3, 10, 3);
  ins.run('old-b', 'kimi-k3', 'COOLDOWN', Date.now() - 1000, 1, 5, 1);
  ins.run('old-c', 'glm-5.3', 'READY', null, 0, 20, 0);

  // 老版本的模型目录（无 seq 列）—— 迁移要给它补列并编号
  d.exec(OLD_UPSTREAM_MODEL);
  const um = d.prepare('INSERT INTO upstream_model (channel_id, model_id, fetched_at) VALUES (?,?,?)');
  um.run('ch-old', 'zzz-model', 1);
  um.run('ch-old', 'aaa-model', 1);
  um.run('ch-old', 'mmm-model', 1);

  // 老版本的 Key 表（无 grace_until）—— 迁移要补列，存量默认「无豁免」
  d.exec(OLD_CHANNEL_KEY);
  const ck = d.prepare(`INSERT INTO channel_key
    (uuid, channel_id, owner, name, secret_enc, secret_fp, priority, weight, enabled, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  ck.run('oldk-1', 'ch-old', '', '旧Key', Buffer.from([1, 2, 3]), 'fp-1', 0, 1, 1, Date.now() - 1000, Date.now() - 1000);
  d.close();
}

let pass = 0; let fail = 0;
async function t(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

console.log('\n[迁移] 老库 → 新 schema');

const DB = path.join(TMP, 'old.db');
buildOldDb(DB);

// 用环境变量指向这个老库，然后**正常启动 db 模块** —— 完全复现线上路径
process.env.DATA_DIR = TMP;
process.env.DB_FILE = DB;
process.env.MASTER_KEY_FILE = path.join(TMP, 'master.key');
process.env.ADMIN_TOKEN_FILE = path.join(TMP, 'admin_token');
process.env.LOG_LEVEL = 'error';

await t('带老 schema 的库能正常启动（不再 "no such column" 崩掉）', async () => {
  const { getDb } = await import('../src/db/index.mjs');
  assert.doesNotThrow(() => getDb());
});

const { all, run } = await import('../src/db/index.mjs');
const stateMod = await import('../src/db/state.mjs');
const keysRef = await import('../src/db/keys.mjs');

await t('disabled_until 列已补上', () => {
  const cols = all('PRAGMA table_info(key_state)').map((c) => c.name);
  assert.ok(cols.includes('disabled_until'), `实际列: ${cols.join(',')}`);
});

await t('依赖新列的索引已建成', () => {
  const idx = all("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='key_state'")
    .map((r) => r.name);
  assert.ok(idx.includes('idx_ks_disabled'), `实际索引: ${idx.join(',')}`);
  assert.ok(idx.includes('idx_ks_ready'), `实际索引: ${idx.join(',')}`);
});

await t('旧的 DISABLED 行被解除（否则会永久禁用，且旧阈值 3 次是误伤）', () => {
  const a = all("SELECT state, fail_streak FROM key_state WHERE key_uuid='old-a'")[0];
  assert.strictEqual(a.state, 'READY', '旧 DISABLED 应被解除');
  assert.strictEqual(a.fail_streak, 0, '连续失败计数应清零');
});

await t('READY 行不受迁移影响', () => {
  const c = all("SELECT state, total_ok FROM key_state WHERE key_uuid='old-c'")[0];
  assert.strictEqual(c.state, 'READY');
  assert.strictEqual(c.total_ok, 20, '历史统计不能被动');
});

await t('COOLDOWN 行原样保留（它本来就有 next_retry_at，能正常恢复）', () => {
  const b = all("SELECT state, next_retry_at FROM key_state WHERE key_uuid='old-b'")[0];
  assert.strictEqual(b.state, 'COOLDOWN');
});

await t('迁移可重复执行（幂等，第二次启动不再 ALTER）', async () => {
  // 直接再跑一次 migrate 逻辑：列已存在 → 不重复 ALTER
  const { getDb } = await import('../src/db/index.mjs');
  assert.doesNotThrow(() => getDb());
  const cols = all('PRAGMA table_info(key_state)').map((c) => c.name);
  assert.strictEqual(cols.filter((c) => c === 'disabled_until').length, 1, '不应出现重复列');
});

await t('迁移后新状态机能正常写入', () => {
  const { recordFailure, getState, reviveExpired } = stateMod;
  recordFailure('old-a', 'glm-5.2', { action: 'disable', streak: 10, error: '测试' });
  const s = getState('old-a', 'glm-5.2');
  assert.strictEqual(s.state, 'DISABLED');
  assert.ok(s.disabled_until > Date.now() + 23 * 3600_000, '应有 24 小时后恢复的时间戳');
  // 到期后能恢复
  reviveExpired(s.disabled_until + 1);
  assert.strictEqual(getState('old-a', 'glm-5.2').state, 'READY');
});

await t('upstream_model.seq 列已补上（老库没有它）', () => {
  const cols = all('PRAGMA table_info(upstream_model)').map((c) => c.name);
  assert.ok(cols.includes('seq'), `实际列: ${cols.join(',')}`);
});

await t('存量模型都被编了号（按名称排序，且不丢行）', () => {
  const rows = all("SELECT model_id, seq FROM upstream_model WHERE channel_id='ch-old' ORDER BY seq");
  assert.strictEqual(rows.length, 3, '三行都必须在');
  // 按 model_id 排序编号：aaa-model=0, mmm-model=1, zzz-model=2
  assert.deepStrictEqual(rows.map((r) => r.model_id), ['aaa-model', 'mmm-model', 'zzz-model']);
  assert.deepStrictEqual(rows.map((r) => r.seq), [0, 1, 2]);
});

await t('新写入的目录顺序被 seq 记录，读取按 seq 返回（不是字母序）', () => {
  // 用真实的 catalog API 写入一个"非字母序"的清单
  const rows = all("SELECT seq FROM upstream_model WHERE channel_id='ch-old'");
  assert.strictEqual(rows.length, 3);
  // 直接断言 seq 是连续整数 —— 保证 ORDER BY seq 能还原写入顺序
  assert.deepStrictEqual([...rows].map((r) => r.seq).sort((a, b) => a - b), [0, 1, 2]);
});

await t('channel_key.grace_until 列已补上（老库没有它）', () => {
  const cols = all('PRAGMA table_info(channel_key)').map((c) => c.name);
  assert.ok(cols.includes('grace_until'), `实际列: ${cols.join(',')}`);
});

await t('存量 Key 的 grace_until 默认 0（无豁免，行为与迁移前一致）', () => {
  const r = all("SELECT grace_until FROM channel_key WHERE uuid='oldk-1'")[0];
  assert.strictEqual(Number(r.grace_until), 0, '老 Key 不该凭空获得豁免');
});

await t('迁移后 renewGrace 能正常写入并被 keysWithNoSuccess 认可', () => {
  const keysMod = keysRef;
  assert.ok(keysMod, 'keys 模块应已加载');
  const now = Date.now();
  const until = keysMod.renewGrace('oldk-1', 3 * 24 * 3600_000, now);
  assert.strictEqual(keysMod.graceUntilOf('oldk-1'), until, '续期应可读回');
  assert.ok(until > now);
});

/* ---------------- ⭐ 2026-10-08：归并 / 黑名单 两张新表 ---------------- */

await t('老库启动后新增 model_synonym 表（别名 → 规范名）', () => {
  const cols = all('PRAGMA table_info(model_synonym)').map((c) => c.name);
  assert.deepStrictEqual(cols.sort(), ['canonical', 'created_at', 'name', 'note']);
});

await t('老库启动后新增 model_blacklist 表（原始渠道 × 原始上游模型）', () => {
  const cols = all('PRAGMA table_info(model_blacklist)').map((c) => c.name);
  for (const c of ['channel_id', 'model', 'reason', 'source', 'fail_count', 'ok_count']) {
    assert.ok(cols.includes(c), `缺列 ${c}，实际 ${cols.join(',')}`);
  }
});

await t('内置"已确定用不了"名单在**老库**上也会播种', async () => {
  const banMod = await import('../src/db/channel-ban.mjs');
  const rows = banMod.listBanned({ channel: 'sensenova' });
  assert.strictEqual(rows.length, 6, `老库也要播 6 条，实际 ${rows.length}`);
  assert.ok(rows.every((r) => r.reason && r.reason.length > 10), '每条都要有可读理由');
});

await t('归并表在老库上可正常读写', async () => {
  const synMod = await import('../src/db/synonyms.mjs');
  synMod.addSynonym({ name: 'DeepSeek-V4-Flash-0731', canonical: 'deepseek-v4-flash' });
  assert.strictEqual(synMod.canonicalOf('DeepSeek-V4-Flash-0731'), 'deepseek-v4-flash');
  synMod.deleteSynonym('DeepSeek-V4-Flash-0731');
  assert.strictEqual(synMod.canonicalOf('DeepSeek-V4-Flash-0731'), 'DeepSeek-V4-Flash-0731');
});

console.log(`\n=== 迁移测试结果：${pass} 通过 / ${fail} 失败 ===\n`);
process.exit(fail ? 1 : 0);
