/**
 * 配置加载。
 * 优先级：环境变量 > data/config.json > 内置默认值。
 * 所有路径基于项目根目录解析，保证本机开发与 219 部署行为一致。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');

function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}

const fileCfg = readJsonSafe(path.join(ROOT, 'data', 'config.json'));

function pick(key, fallback) {
  const v = process.env[key];
  if (v !== undefined && v !== '') return v;
  if (fileCfg[key] !== undefined) return fileCfg[key];
  return fallback;
}

function int(key, fallback) {
  const n = Number.parseInt(pick(key, fallback), 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 数据目录。
 * ⚠️ 以下三个文件路径**默认从 dataDir 派生**，而不是各自写死 'data/xxx'。
 *    否则设了 DATA_DIR 后，DB/主密钥/token 仍会落在老的 data/ 里 ——
 *    表现为"换了数据目录但数据没跟过去"，且多实例会互相踩对方的 DB。
 *    各自仍可用独立环境变量覆盖。
 */
const DATA_DIR = path.resolve(ROOT, pick('DATA_DIR', 'data'));

export const config = {
  /** 只监听本机；外部访问走 SSH 隧道 */
  host: pick('HOST', '127.0.0.1'),
  port: int('PORT', 3210),

  dataDir: DATA_DIR,
  dbFile: path.resolve(ROOT, pick('DB_FILE', path.join(DATA_DIR, 'api2api.db'))),
  masterKeyFile: path.resolve(ROOT, pick('MASTER_KEY_FILE', path.join(DATA_DIR, 'master.key'))),
  adminTokenFile: path.resolve(ROOT, pick('ADMIN_TOKEN_FILE', path.join(DATA_DIR, 'admin_token'))),
  webDir: path.resolve(ROOT, 'web'),

  /** 主密钥：env MASTER_KEY 优先；否则从文件读；都没有则自动生成落盘 */
  masterKey: process.env.MASTER_KEY || '',

  /** 单次上游请求超时（毫秒） */
  upstreamTimeoutMs: int('UPSTREAM_TIMEOUT_MS', 120_000),
  /** 建立连接阶段的超时；超过则视为 transient 可换 Key */
  upstreamConnectTimeoutMs: int('UPSTREAM_CONNECT_TIMEOUT_MS', 15_000),

  /**
   * 验活（"发 hi 等首字"）时，单个模型等首字的超时。
   *
   * 比 upstreamConnectTimeoutMs 短 —— 验活只等**第一帧**，不是整段生成。
   */
  verifyPerModelTimeoutMs: int('VERIFY_PER_MODEL_TIMEOUT_MS', 20_000),

  /**
   * 验活整轮的**总时间预算**（毫秒，默认 2 分钟）。
   *
   * 一个渠道可能有十几个模型，全试一遍不能把用户卡死 ——
   * 预算用尽就停止，把"已试 N 个都失败"如实返回。
   *
   * ⚠️ 这个配置项曾经**不存在**，但 firstbyte.mjs 直接引用了它 →
   *    `budgetMs = undefined` → `deadline = Date.now() + undefined = NaN`
   *    → `Math.min(perModelMs, NaN) = NaN` → `setTimeout(abort, NaN)` **立即中断**
   *    → 每个模型请求都被瞬间砍断，永远拿不到首字，**任何 Key 都绑不上**。
   *    补上默认值是修这个 bug 的关键。
   */
  verifyTotalBudgetMs: int('VERIFY_TOTAL_BUDGET_MS', 120_000),

  /**
   * 单次请求最多尝试多少个 (渠道, Key) 组合 —— 全局总预算，防止雪崩。
   * 注意：默认值要给足，让它**不是**渠道降级的瓶颈；
   * 渠道级别的限制用 maxAttemptsPerChannel。
   */
  maxAttempts: int('MAX_ATTEMPTS', 48),

  /**
   * 单个渠道内最多尝试几把 Key。
   *
   * 用户要求的语义（2026-10-06）：
   *   「商汤 > 书生 > OpenRouter。同名模型先把商汤的 Key 全试完（都死了），
   *     再开始遍历书生、OpenRouter。」
   * 所以渠道是**严格分层**的：本渠道试满这个次数（或 Key 用尽）才降级。
   * 设 0 表示不限制（有多少 Key 试多少，直到全局预算耗尽）。
   */
  maxAttemptsPerChannel: int('MAX_ATTEMPTS_PER_CHANNEL', 8),

  /**
   * 单个渠道内，一次请求最多尝试该渠道**可用 Key 总数的几分之一**。
   *
   * ⭐ 用户要求（2026-10-07 原话）：
   *   「那些商汤 尝试要熔断 最多尝试四分之一的号 不然一直切换 key 重试全死了」
   *
   * 为什么需要：某个模型持续失败时，若把渠道内所有 Key 都试一遍，
   *   几十把 Key 会**同时**被打进冷却 —— 池子被一个坏模型烧穿。
   *   限制成 1/4 后，坏模型最多烧掉四分之一的 Key，剩余 3/4 仍可服务其它模型。
   *
   * 与 `maxAttemptsPerChannel` 的关系：**两者取小**。
   *   maxAttemptsPerChannel 是用户配置的硬上限（默认 8），
   *   本项是按池子规模动态算出的熔断线（ceil(可用Key数 / 4)）。
   *   例：渠道 8 把 Key → min(8, 2) = 2；渠道 40 把 Key → min(8, 10) = 8。
   *
   * 设 0 表示不启用本熔断（退回只看 maxAttemptsPerChannel）。
   */
  channelCircuitFraction: int('CHANNEL_CIRCUIT_FRACTION', 4),

  /**
   * 本渠道熔断预算的**下限**（至少允许试几把）。
   *
   * ⚠️ 默认 **2**，不是 1 —— 这是可用性底线，不是可调项：
   *   `ceil(3把 / 4) = 1`，若下限是 1，则小池子一次就放弃，
   *   **连"换一把 Key"都做不到**，一个偶发 429 就让整条渠道被跳过。
   *   （真实回归：e2e 三条路由用例因此全落到下一渠道。）
   *
   *   2 的含义 = "至少能换一把 Key 再下结论"，同时仍远低于打穿池子。
   *   单 Key 渠道会被 clamp 到 1（池子只有 1 把，不可能试 2 次），仍可用。
   */
  channelCircuitMin: int('CHANNEL_CIRCUIT_MIN', 2),

  /**
   * 「模型级」降级阈值 —— 同一 (渠道, 模型) 累计连续失败多少次 → DEGRADED。
   *
   * ⭐ 用户要求（2026-10-07）：「分多级才行，不然全池子死了：正常 → 降级 → 不可用」
   *
   * 计数**跨 Key 累计**（换 Key 打同一模型失败也计入）——
   * 这样"多把 Key 都打不通"才算模型坏，而不是一把 Key 倒霉就封模型。
   */
  modelDegradeAfterFails: int('MODEL_DEGRADE_AFTER_FAILS', 3),

  /** 模型累计连续失败多少次 → UNAVAILABLE（直接跳过） */
  modelUnavailableAfterFails: int('MODEL_UNAVAILABLE_AFTER_FAILS', 6),

  /**
   * ⭐ 「内置问题模型规则」开关（2026-10-07）。
   *
   * 有些模型**上游就是喜欢 429**（用户原话），或**画图模型失效了不判真失效**，
   * 需要在**首次遇到时就按已知规律预置健康度** —— 而不是等它把 Key 池子烧穿
   * 才慢慢学习到"这个模型不行"。
   *
   * 比如 `sensenova-u1-fast` 这类文生图模型走的是 `/v1/images/generations`，
   * 用 chat 端点探活必然 404 —— 但 404 是"路径不对"，**不代表模型坏了**。
   * 内置规则把它标为"已知特殊"，避免误熔断。
   *
   * 设 0 关闭内置规则（完全靠运行时学习）。
   */
  builtinModelRules: int('BUILTIN_MODEL_RULES', 1),

  /**
   * ⭐ 已知「上游偏好 429」的模型名单（逗号分隔的上游模型名）。
   *
   * 这些模型首次出现时直接预置为 **DEGRADED**（降级观察）：
   *   - 参与调度，但排到候选末尾
   *   - 每次请求只试 **1 次**（快速证伪，不占熔断预算）
   *
   * 这样既不会因为一个爱 429 的模型烧掉大量 Key，
   * 又保留了"万一它现在好了"的可用性（试 1 次成功即回 NORMAL）。
   *
   * 空字符串 = 名单由 `src/db/model-rules.mjs` 的内置表提供。
   */
  rateLimitProneModels: pick('RATE_LIMIT_PRONE_MODELS', ''),

  /**
   * ⭐ 已知「走非 chat 端点」的模型名单（逗号分隔上游模型名）。
   *
   * 典型是文生图模型（商汤 `sensenova-u1-*`）—— 它们走 `/v1/images/generations`，
   * 用 chat 探活会 404。**这类 404 不该计入模型健康度**，
   * 否则一个根本没用错的模型会被熔断。
   */
  nonChatModels: pick('NON_CHAT_MODELS', ''),

  /**
   * 模型被标 UNAVAILABLE 后的自动恢复时间（毫秒，默认 24 小时）。
   * 到期后**降到 DEGRADED 观察**（不是直接回 NORMAL）——
   * 直接回 NORMAL 会让一个真坏的模型每 24h 又被全池子试一轮，循环烧 Key。
   */
  modelDisabledRecoverMs: int('MODEL_DISABLED_RECOVER_MS', 24 * 3600_000),

  /**
   * ⭐ 「只接快速模型」总开关（用户 2026-10-07 要求，**默认打开**）。
   *
   * 语义：对**目录严重虚胖**的渠道（目前只有 NVIDIA NIM —— 80 个模型里
   * 真能用的个位数，其余 404/410/挂死），拉目录时只收录**实测可用的快速模型**。
   *
   * 运行时可在控制台 / `/api/settings` 里切换，落盘 `data/settings.json`（见 settings.mjs），
   * 优先级：**settings.json > env > 本默认值**。
   *
   * 设 0 = 收录该渠道全部模型（谨慎：挂死模型会烧熔断预算）。
   */
  fastModelsOnly: int('FAST_MODELS_ONLY', 1),

  /**
   * 快速模型名单的**临时覆盖**（逗号分隔上游模型名）。
   * 留空 = 用 `src/db/fast-models.mjs` 的内置实测表。
   */
  fastModels: pick('FAST_MODELS', ''),

  /**
   * ⭐ 模型黑名单**总开关**（用户 2026-10-08 要求，**默认打开**）。
   *
   * 语义：黑名单里的 (渠道 × 原始上游模型) ①从下游模型清单里隐藏
   * ②relay 直接不发请求。关闭后黑名单只保留记录、不产生任何拦截效果。
   *
   * 运行时可在控制台切换（落 meta 表），优先级 **DB > env > 本默认值**。
   */
  blacklistEnabled: int('BLACKLIST_ENABLED', 1),

  /**
   * ⭐ 是否**自动**把连续失败且从未成功过的 (渠道, 模型) 加入黑名单
   * （用户 2026-10-08：「连续失败过多的模型+渠道自动禁用」）。默认打开。
   */
  autoBlacklistEnabled: int('AUTO_BLACKLIST', 1),

  /**
   * 自动拉黑的阈值：**从未成功过**（total_ok == 0）且累计失败达到这个次数
   * → 自动加入黑名单。
   *
   * 为什么要求 total_ok == 0：用户原话是
   *   「比如一个模型 从来没成功过 每次调用都失败」——
   *   一个偶尔能出字的模型哪怕失败率很高，也不该被"永久"拉黑（它还在提供服务）。
   *   失败率高的交给 model_health 的三级熔断（可自动恢复），
   *   这里只处理"压根没救"的。
   */
  modelAutoBanAfterFails: int('MODEL_AUTO_BAN_AFTER_FAILS', 10),

  /** 请求体大小上限 */
  maxBodyBytes: int('MAX_BODY_BYTES', 8 * 1024 * 1024),

  /**
   * 「调用过但一次都没成功」的观察窗口（天）。
   *
   * 用户要求（2026-10-07）：Key 若在窗口内**被调用过、却一次都没成功**，
   * 视为失效，桥会据此提醒用户换 Key。
   * 严格定义：**没被调用过的 Key 不参与判定**（新绑上还没轮到的不算）。
   */
  keyNoSuccessDays: int('KEY_NO_SUCCESS_DAYS', 3),

  /**
   * 新绑定 Key 的宽限期（毫秒，默认 3 天）。
   *
   * 刚绑定的 Key 可能还没被路由选中过 —— 若立刻判定"零成功"会误伤。
   * 绑定满这个时长后才纳入失效判定。
   *
   * 用户明确选择（2026-10-07）：**新绑的 Key 给 3 天宽限**。
   * 曾误设为 1 天 —— 与"3 天观察期"的语义不一致。
   */
  keyNoSuccessGraceMs: int('KEY_NO_SUCCESS_GRACE_MS', 3 * 24 * 3600 * 1000),

  /**
   * 复核验活通过后的**续期时长**（毫秒，默认 3 天）。
   *
   * ⭐ 用户要求（2026-10-07）：
   *   「三天复核，复核通过后相当于继续三天缓冲，能一直调用最好」
   *   —— 每轮复核只要有一把 Key 能出字，就再保 3 天，可以无限续下去。
   *
   * 与 `keyNoSuccessGraceMs` 的区别：
   *   keyNoSuccessGraceMs 是**初次绑定**的静态宽限（按 created_at 算）
   *   keyGraceRenewMs     是**复核通过**后的动态续期（写 channel_key.grace_until）
   */
  keyGraceRenewMs: int('KEY_GRACE_RENEW_MS', 3 * 24 * 3600 * 1000),

  /**
   * 调度策略。
   *
   *   fill_first（默认）—— **填满优先**：始终用排在最前的可用 Key，直到它失败/限速
   *                        才换下一把。Key 数远多于需求时，只会用前几把。
   *   weighted         —— 平滑加权轮询（smooth-WRR，nginx 风格），按 weight 摊开。
   *
   * 用户要求（2026-10-07）：「默认不要轮询，默认是填满优先」。
   */
  schedulerPolicy: pick('SCHEDULER_POLICY', 'fill_first'),

  /**
   * Key 的**软冷却**时长（毫秒，默认 60 秒）。
   *
   * ⭐ 2026-10-07 新增。用于 QUOTA(429) / TRANSIENT 这类**模型侧问题**：
   *   Key 本身没坏，只是这次被上游限流了 → 让位一小会儿，不累加连续失败、
   *   也不递增冷却。真正的判定交给「模型健康度」（累计到阈值直接 ban 模型）。
   *
   * 为什么不能沿用递增冷却：一个坏模型连打 10 次就能把一把好 Key 禁用 ——
   *   用户明确要求「ban 的话只 ban 模型，不 ban key」。
   *
   * 设 0 表示不软冷却（QUOTA/TRANSIENT 完全不动 Key 状态）。
   */
  keySoftCooldownMs: int('KEY_SOFT_COOLDOWN_MS', 60_000),

  /**
   * 每把 Key 每分钟最多发起多少次上游请求（RPM）。
   *
   * 用户要求：「key 够多尽量 每个 key rpm2」。
   * 配合 fill_first 的效果是：第 1 把用满 2 次就轮到第 2 把，负载自然摊开。
   * 设 0 表示不限速。
   */
  keyRpmLimit: int('KEY_RPM_LIMIT', 2),

  /**
   * Key 失败的**线性递增**冷却（毫秒）。
   *
   * 用户要求：「第一次失败冷却10分钟 第二次20分钟 第三次30分钟 …… 第10次禁用」。
   * 即 cooldown = cooldownStepMs × 连续失败次数（连续失败 = fail_streak，
   * **一旦成功立刻清零**，见 state.recordSuccess）。
   *
   * 上限 cooldownMaxMs 默认 90 分钟 —— 正好是禁用前的最后一步（9 × 10min），
   * 也就是说不额外设一个"封顶值"去截断用户的递增意图。
   */
  cooldownStepMs: int('COOLDOWN_STEP_MS', 10 * 60_000),
  cooldownMaxMs: int('COOLDOWN_MAX_MS', 90 * 60_000),

  /** 连续失败多少次后直接 DISABLED（用户要求：第 10 次） */
  disableAfterFails: int('DISABLE_AFTER_FAILS', 10),

  /**
   * 被 DISABLED 之后的恢复等待时间（毫秒）。默认 24 小时。
   * 到期后自动回到 READY 并清零连续失败计数 —— 「直到24小时之后」。
   */
  disabledRecoverMs: int('DISABLED_RECOVER_MS', 24 * 3600_000),

  /**
   * 告诉下游客户端"多久后重试"的基准值（毫秒）。
   * ⚠️ 与 cooldownBaseMs 不同：那是 Key 内部冷却（1 秒级，仅为错开并发），
   *    这是给**客户端**的建议值。上游限流通常按分钟计窗口（如 RPM/TPM），
   *    给 1 秒会让客户端立刻重试又立刻被拒，反而加重限流。
   *    默认 20 秒 ≈ 一个短窗口周期。
   */
  downstreamRetryAfterMs: int('DOWNSTREAM_RETRY_AFTER_MS', 20_000),

  logLevel: pick('LOG_LEVEL', 'info'),
};

/** 确保运行所需目录存在 */
export function ensureDirs() {
  fs.mkdirSync(config.dataDir, { recursive: true });
}

export default config;
