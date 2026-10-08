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

-- 「模型级」健康度 —— 粒度 = (渠道 × 上游模型)，**与 Key 无关**。
--
-- ⭐ 为什么需要这张表（用户 2026-10-07 明确要求）：
--   key_state 的粒度是 (Key × 模型)，只能表达"这把 Key 在这个模型上不行"。
--   但真实故障常常是「**这个模型**在某渠道就是不行」——典型是上游对该模型
--   持续 429，或该模型根本不在 token plan 里。此时**惩罚 Key 是错的**：
--   换一把 Key 打同一个模型照样失败，结果是把整个 Key 池子全部烧成冷却。
--
--   用户原话：「有些模型上游就是喜欢429」「ban的话只ban模型，不ban key」
--             「分多级才行，不然全池子死了：正常 → 降级 → 不可用」
--
-- 三级状态机：
--   NORMAL     正常    —— 按 1/4 熔断预算尝试
--   DEGRADED   降级    —— 已连续失败若干次；**排到候选末尾**且只允许 1 次尝试
--   UNAVAILABLE 不可用 —— 直接跳过（除非全渠道都不可用才兜底）；24 小时后自动恢复
CREATE TABLE IF NOT EXISTS model_health (
  channel_id     TEXT NOT NULL REFERENCES channel(id) ON DELETE CASCADE,
  model          TEXT NOT NULL,
  state          TEXT NOT NULL DEFAULT 'NORMAL',
  fail_streak    INTEGER NOT NULL DEFAULT 0,
  total_ok       INTEGER NOT NULL DEFAULT 0,
  total_fail     INTEGER NOT NULL DEFAULT 0,
  -- DEGRADED 的冷却到期（到期后仍留在 DEGRADED，靠一次成功才能回 NORMAL）
  cooldown_until INTEGER,
  -- UNAVAILABLE 的自动恢复时间
  disabled_until INTEGER,
  last_ok_at     INTEGER,
  last_error     TEXT,
  reason         TEXT,
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (channel_id, model)
);

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

-- 模型名归并（同义名 → 规范名）。
--
-- ⭐ 为什么需要（用户 2026-10-08 要求）：
--   「DeepSeek-V4-Flash-0731 / deepseek-v4-flash-0731 / Deepseek-V4-Flash /
--     deepseek-v4-flash:0731 都映射成 deepseek-v4-flash」
--   同一个模型在不同渠道的上游名千奇百怪（大小写 / 版本后缀 / ':0731' 标签 /
--    供应商前缀），下游只想记一个名字。这里把「别名 → 规范名」落库：
--     · 调用任一别名 → 先重定向到规范名，再走正常的跨渠道路由
--     · 别名本身**不再单独出现在下游模型清单里**（折叠掉，避免重复）
--
--   ⚠️ 与 model_alias 的区别：
--     model_alias 是「**对外名 → 上游名**」，回答"这个名字在这条渠道上叫啥"；
--     model_synonym 是「**别名 → 规范名**」，回答"这两个名字是不是同一个东西"。
--     前者管渠道内改名，后者管全局归并。两者叠加，互不替代。
CREATE TABLE IF NOT EXISTS model_synonym (
  name       TEXT PRIMARY KEY,
  canonical  TEXT NOT NULL,
  note       TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_syn_canonical ON model_synonym(canonical);

-- ⭐ 模型黑名单（原始渠道 × 原始上游模型）。
--
-- 用户要求（2026-10-08）：
--   「连续失败过多的模型+渠道自动禁用 比如一个模型 从来没成功过 每次调用都失败
--     不在在模型列表出现」
--   「加入的是原始渠道名称+原始上游模型名称 不是转换后的名称」
--   「之前确定用不了的模型就直接拉黑了 让用户能看到 为什么拉黑」
--
-- 与 model_health 的区别（两者互补，不能互相替代）：
--   model_health  三级、运行时学到、**24h 后自动降级观察**（会自己回来）
--   model_blacklist **永久**（只能手动解禁）、有明确理由、**从模型清单里彻底消失**
--                 并且不是"少试几次"，而是**直接不发请求**。
--
-- 键 = (channel_id, model)：展示时用 channel.name（原始渠道名）+ model（原始上游名）。
CREATE TABLE IF NOT EXISTS model_blacklist (
  channel_id TEXT NOT NULL REFERENCES channel(id) ON DELETE CASCADE,
  model      TEXT NOT NULL,
  reason     TEXT,
  -- builtin = 内置"已确定用不了"名单  fast-mode = 快速模式未收录
  -- auto    = 连续失败自动加入        manual   = 人工加入
  source     TEXT NOT NULL DEFAULT 'manual',
  fail_count INTEGER NOT NULL DEFAULT 0,
  ok_count   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (channel_id, model)
);

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
  {
    name: 'nvidia',
    display_name: 'NVIDIA NIM',
    adapter: 'nvidia',
    base_url: 'https://integrate.api.nvidia.com/v1',
    default_model: 'nvidia/nemotron-3-super-120b-a12b',
    sort_order: 40,
    note: 'NVIDIA build.nvidia.com 免费档（~40 RPM，账号级）。内置「只接快速模型」过滤：'
      + '目录 80 个里真能用且快的只有个位数，默认只收录实测通过的那几个。',
  },
  {
    name: 'modelscope',
    display_name: '魔搭 ModelScope',
    adapter: 'modelscope',
    base_url: 'https://api-inference.modelscope.cn/v1',
    default_model: 'Qwen/Qwen3.5-35B-A3B',
    sort_order: 50,
    note: '阿里魔搭 ModelScope API-Inference 免费档（2000 次/天，单模型 ≤500）。'
      + '⚠️ 需先在 ModelScope 绑定阿里云账号，否则任何 chat 调用返回 401 '
      + '「Please bind your Alibaba Cloud account before use.」。',
  },
  {
    name: 'llm7',
    display_name: 'LLM7.io',
    adapter: 'llm7',
    base_url: 'https://api.llm7.io/v1',
    default_model: 'deepseek-v4-pro',
    sort_order: 60,
    note: 'LLM7.io 免费聚合网关（keyless 也可用，Bearer 随便填；注册 token 限额更高）。'
      + '目录 66 个但免费档只有少数可用；付费档模型返回 402 → 适配器归 CONFIG_FAULT（跳过）。',
  },
];
