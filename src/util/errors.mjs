/**
 * 错误分类与异常类型。
 *
 * 分类决定调度动作：
 *   - 换 Key：QUOTA / AUTH / TRANSIENT / NO_KEY
 *   - 不换 Key（换谁也白搭）：REQUEST_FAULT / CONFIG_FAULT
 */
export const ErrClass = {
  OK: 'ok',
  QUOTA: 'quota',
  AUTH: 'auth',
  TRANSIENT: 'transient',
  REQUEST_FAULT: 'request_fault',
  CONFIG_FAULT: 'config_fault',
  NO_KEY: 'no_key',
  /**
   * ⭐ 「该渠道的这个模型已被模型级熔断器标记为不可用」（2026-10-07 新增）。
   *
   * 与 CONFIG_FAULT 的区别（别混）：
   *   CONFIG_FAULT     —— 上游明确回"我这没这个模型"（404 / model_not_found），
   *                       是**上游事实**，换渠道可能就有。
   *   MODEL_UNAVAILABLE —— 我们**自己**根据连续失败（多次不同 Key 都打不通）
   *                       判定该模型在该渠道是坏的，主动跳过一次都不试。
   *                       24 小时后自动降到 DEGRADED 观察。
   *
   * 为什么单独一个分类：用户要看得出「这是被我熔断的」还是「上游真没有」——
   * 前者可以手动重置，后者只能换渠道。
   */
  MODEL_UNAVAILABLE: 'model_unavailable',
};

/** 这些分类意味着"该换 Key / 换渠道" */
export const RETRYABLE = new Set([
  ErrClass.QUOTA,
  ErrClass.AUTH,
  ErrClass.TRANSIENT,
  ErrClass.NO_KEY,
  ErrClass.CONFIG_FAULT, // 模型在该渠道不存在 → 换渠道可能就有（关键：不能当 fatal）
]);

/**
 * 「换谁都一样」的错误 —— 只有请求体本身有问题才属此类。
 *
 * ⚠️ 重要设计决策（2026-10-06 真 Key 实测修正）：
 *   CONFIG_FAULT **不在此列**。
 *   实测：`glm-5.3` 只在书生存在、商汤返回 404 `model route not found`。
 *   若把"模型不存在"当 fatal，路由会在第一个渠道就停住，
 *   跨渠道能力直接失效 —— 而"模型在哪个渠道存在就落到哪个渠道"正是本项目的核心。
 *   因此 CONFIG_FAULT 语义为「**该渠道**没有这个模型」→ 跳过该渠道剩余 Key，继续下一渠道。
 */
export const FATAL_FOR_REQUEST = new Set([
  ErrClass.REQUEST_FAULT,
]);

/**
 * 「本渠道所有 Key 都会得到同样结果」的错误 —— 换 Key 无用，直接落下一渠道。
 * 用于避免模型不存在时把同渠道的每把 Key 都撞一遍。
 */
export const FATAL_FOR_CHANNEL = new Set([
  ErrClass.CONFIG_FAULT,
]);

/** HTTP 状态码 → 默认分类（未识别到上游私有壳时的兜底） */
export function classifyByStatus(status) {
  if (status >= 200 && status < 300) return ErrClass.OK;
  if (status === 401 || status === 403) return ErrClass.AUTH;
  if (status === 429) return ErrClass.QUOTA;
  if (status === 408) return ErrClass.TRANSIENT;
  if (status === 404) return ErrClass.CONFIG_FAULT;
  if (status >= 500) return ErrClass.TRANSIENT;
  if (status >= 400) return ErrClass.REQUEST_FAULT;
  return ErrClass.TRANSIENT;
}

/** 面向下游客户端的错误（会被归一化成 OpenAI 壳输出） */
export class ApiError extends Error {
  constructor(status, message, {
    code = null, type = 'api_error', traceId = null, errClass = null,
    retryAfterMs = null, headers = null, logged = false,
  } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.type = type;
    this.traceId = traceId;
    this.errClass = errClass ?? classifyByStatus(status);
    /** 建议客户端多久后重试（毫秒）。仅在全渠道耗尽且属可恢复错误时有值 */
    this.retryAfterMs = retryAfterMs;
    /** 附加响应头 */
    this.headers = headers;
    /** relay 抛错时已经写过一条完整流水（含 chain），上层不要再写一遍 */
    this.logged = logged;
  }

  toOpenAI() {
    const retryAfterS = this.retryAfterMs ? Math.ceil(this.retryAfterMs / 1000) : null;
    return {
      error: {
        message: this.message,
        type: this.type,
        param: null,
        code: this.code,
        ...(retryAfterS ? { retry_after: retryAfterS } : {}),
      },
      ...(this.traceId ? { trace_id: this.traceId } : {}),
    };
  }

  /** 该错误附带的 HTTP 响应头 */
  toHeaders() {
    const h = { ...(this.headers ?? {}) };
    if (this.retryAfterMs) h['Retry-After'] = String(Math.max(1, Math.ceil(this.retryAfterMs / 1000)));
    return h;
  }
}

/** 记录一次尝试的结果，用于 pipeline 汇总 */
export function attemptRecord({ channelId, keyUuid, status, errClass, upstreamTrace, latencyMs, ttfbMs, note }) {
  return { channelId, keyUuid, status, errClass, upstreamTrace: upstreamTrace ?? null, latencyMs, ttfbMs, note: note ?? null };
}
