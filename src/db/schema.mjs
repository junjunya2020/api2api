/**
 * 数据库结构定义。
 * 使用 TEXT 存 JSON / 时间戳（毫秒），SQLite 无原生布尔，用 0/1。
 */
export const SCHEMA_VERSION = 1;

export const DDL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

-- 渠道：内置两条（sensenova / intern），不做 CRUD 界面
CREATE TABLE IF NOT EXISTS channel (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  adapter       TEXT NOT NULL,
  base_url      TEXT NOT NULL,
  default_model TEXT,
  enabled       INTEGER NOT NULL DEFAULT 1,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  note          TEXT,
  created_at    INTEGER NOT NULL
);

-- Key：主键为调用方传入的 uuid；同渠道内密钥指纹唯一（判重）
--
-- owner：这把 Key 的归属者（外部系统的用户标识，如 casdoor sub）。
--   - 空字符串/ NULL = **系统 Key**（管理员自己加的，任何人不可通过 owner 接口操作）
--   - 非空 = 某用户通过桥绑定的 Key，只能被同 owner 的请求列出/删除
--   路由**不看 owner** —— 所有 Key 都在同一个池子里按渠道优先级参与调度。
CREATE TABLE IF NOT EXISTS channel_key (
  uuid         TEXT PRIMARY KEY,
  channel_id   TEXT NOT NULL REFERENCES channel(id) ON DELETE CASCADE,
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
  -- 复核续期：验活通过的 Key 在此时刻之前**豁免**「零成功」判定（毫秒时间戳，0=无）。
  -- 滑动窗口语义 —— 每轮复核通过就 +3 天，只要还能出字就能一直留。
  grace_until  INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ck_channel ON channel_key(channel_id, enabled);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ck_fp ON channel_key(channel_id, secret_fp);

-- 运行时状态：粒度 = (Key × 上游模型)
CREATE TABLE IF NOT EXISTS key_state (
  key_uuid       TEXT NOT NULL REFERENCES channel_key(uuid) ON DELETE CASCADE,
  model          TEXT NOT NULL,
  state          TEXT NOT NULL DEFAULT 'READY',
  next_retry_at  INTEGER,
  disabled_until INTEGER,
  fail_streak    INTEGER NOT NULL DEFAULT 0,
  current_weight REAL NOT NULL DEFAULT 0,
  total_ok       INTEGER NOT NULL DEFAULT 0,
  total_fail     INTEGER NOT NULL DEFAULT 0,
  last_used_at   INTEGER,
  last_error     TEXT,
  PRIMARY KEY (key_uuid, model)
);
-- ⚠️ key_state 的索引**不在这里建** —— 见 db/index.mjs 的 ensureIndexes()。
--    原因：老库的 key_state 表已存在且没有 disabled_until 列，
--    在这个 DDL 里建 key_state(disabled_until) 索引会在补列之前就报
--    "no such column"，导致整个 DDL 执行失败、进程起不来。
--    必须在 ALTER TABLE 补列之后，单独、逐条建索引。

-- 上游模型目录：从各渠道 GET /models 拉回来的真实模型清单（落库，供下游 /v1/models 输出）
CREATE TABLE IF NOT EXISTS upstream_model (
  channel_id TEXT NOT NULL REFERENCES channel(id) ON DELETE CASCADE,
  model_id   TEXT NOT NULL,
  seq        INTEGER NOT NULL DEFAULT 0,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (channel_id, model_id)
);
CREATE INDEX IF NOT EXISTS idx_um_model ON upstream_model(model_id);
CREATE INDEX IF NOT EXISTS idx_um_channel ON upstream_model(channel_id);

-- 模型映射：对外名 → 上游名（**额外的**改名/指定，不参与"有哪些模型"的判定）
CREATE TABLE IF NOT EXISTS model_alias (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  public_name   TEXT NOT NULL,
  channel_id    TEXT REFERENCES channel(id) ON DELETE CASCADE,
  upstream_name TEXT NOT NULL,
  priority      INTEGER NOT NULL DEFAULT 0,
  weight        INTEGER NOT NULL DEFAULT 1,
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alias_public ON model_alias(public_name, enabled, priority DESC);

-- 下游客户端 token（只存 sha256）
CREATE TABLE IF NOT EXISTS client_token (
  token_hash TEXT PRIMARY KEY,
  name       TEXT,
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);

-- Key 的按日调用聚合。
--
-- 为什么不用 request_log 直接统计：流水会被 pruneLogs 按条数裁掉（只留最近 N 条），
-- 用它算"最近 3 天"会在量大的时候失真。这张表每 (Key, 天) 一行，体量极小且永不裁剪。
--
-- 用途：判断「最近 N 天调用过、但一次都没成功」的 Key（桥要据此提醒用户换 Key）。
--   ok=0 且 fail>0  → 调用过但零成功 → 判为失败
--   ok>0            → 有成功过 → 正常（哪怕失败更多）
--   两者都是 0      → **没被调用过**，不参与判定（用户明确：本身没调用不算）
CREATE TABLE IF NOT EXISTS key_daily (
  key_uuid     TEXT NOT NULL REFERENCES channel_key(uuid) ON DELETE CASCADE,
  day          TEXT NOT NULL,              -- 本地日期 YYYY-MM-DD
  ok           INTEGER NOT NULL DEFAULT 0,
  fail         INTEGER NOT NULL DEFAULT 0,
  last_ok_at   INTEGER,
  last_fail_at INTEGER,
  PRIMARY KEY (key_uuid, day)
);
CREATE INDEX IF NOT EXISTS idx_kd_day ON key_daily(day);

-- 请求流水
CREATE TABLE IF NOT EXISTS request_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ts             INTEGER NOT NULL,
  model          TEXT,
  public_model   TEXT,
  channel_id     TEXT,
  key_uuid       TEXT,
  status         INTEGER,
  err_class      TEXT,
  upstream_trace TEXT,
  latency_ms     INTEGER,
  ttfb_ms        INTEGER,
  attempts       INTEGER,
  chain          TEXT
);
CREATE INDEX IF NOT EXISTS idx_rl_ts ON request_log(ts);
CREATE INDEX IF NOT EXISTS idx_rl_model ON request_log(model, ts);

-- 元信息
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT
);
`;

/** 内置渠道预置数据。用户只需往里填 Key */
export const BUILTIN_CHANNELS = [
  {
    name: 'sensenova',
    display_name: '商汤日日新',
    adapter: 'sensenova',
    base_url: 'https://token.sensenova.cn/v1',
    default_model: 'SenseChat-5-0903',
    sort_order: 10,
    note: '商汤日日新。错误壳为 gRPC-gateway 风格，需归一化。',
  },
  {
    name: 'intern',
    display_name: '书生·墨点',
    adapter: 'intern',
    base_url: 'https://discovery-api.intern-ai.org.cn/v1',
    default_model: 'intern-latest',
    sort_order: 20,
    note: '上海AI实验室 discovery 端点。错误壳符合 OpenAI 标准，可直接透传。',
  },
  {
    name: 'openrouter',
    display_name: 'OpenRouter',
    adapter: 'openrouter',
    base_url: 'https://openrouter.ai/api/v1',
    default_model: null,
    sort_order: 30,
    note: 'OpenRouter。拉取时**只保留免费模型**（pricing 全 0），避免下游被几百个付费模型淹没、误调用扣费。',
  },
];
