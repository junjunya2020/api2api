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
