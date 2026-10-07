/**
 * OpenRouter 适配器。
 *
 * 与商汤/书生的最大不同：**上游 /models 会返回全部 465 个模型，绝大多数是付费的**。
 * 用户要的是「免费 key 聚合免费模型」，所以这里必须**过滤出免费模型**，
 * 否则下游清单会被几百个付费模型淹没，而且误调用会真实扣费。
 *
 * 免费判定（2026-10-06 实测 465 个模型得出）：
 *   ① id 以 `:free` 结尾  → 16 个
 *   ② pricing.prompt === "0" 且 pricing.completion === "0" → 20 个
 *   ①② 的交集恰好 16 个，即「带 :free 后缀的一定免费」，两者等价。
 *
 * 但实测还发现 3 个「免费但不带 :free」的例外，需要白名单：
 *   - `openrouter/free`            元模型（自动挑一个免费模型）
 *   - `inclusionai/ling-3.1-flash` 免费
 *   - `google/lyria-3-*`           音频生成（免费，但不是 chat）
 *
 * 因此策略：**`pricing` 全 0 即视为免费**（比后缀更可靠），
 * 并支持环境变量 `OPENROUTER_FREE_ONLY=1`（默认开）在拉取时只保留免费模型；
 * 关掉则拉全量，供用户自己挑。
 *
 * 错误壳（实测）：
 *   {"error":{"message":"User not found.","code":401}}          —— 数字 code
 *   {"error":{"message":"No cookie auth credentials found","code":401}}
 * 注意：**免费模型也需要带 key**，不带 Authorization 直接 401。
 */
import { BaseAdapter } from './base.mjs';
import { ErrClass } from '../util/errors.mjs';

/** OpenRouter 数字 code → 归类（实测 401 形态；其余按通用语义补全） */
const NUM_CODE_MAP = {
  400: { errClass: ErrClass.REQUEST_FAULT, http: 400 },
  401: { errClass: ErrClass.AUTH, http: 401 },
  402: { errClass: ErrClass.QUOTA, http: 402 },           // 余额不足
  403: { errClass: ErrClass.AUTH, http: 403 },
  404: { errClass: ErrClass.CONFIG_FAULT, http: 404 },
  408: { errClass: ErrClass.TRANSIENT, http: 408 },
  429: { errClass: ErrClass.QUOTA, http: 429 },
  502: { errClass: ErrClass.TRANSIENT, http: 502 },
  503: { errClass: ErrClass.TRANSIENT, http: 503 },
};

/** OpenRouter 字符串 code / 文本特征（覆盖非数字形态） */
const STR_HINTS = [
  { re: /insufficient|balance|credit|quota|402/i, errClass: ErrClass.QUOTA },
  { re: /rate ?limit|too many request|429/i, errClass: ErrClass.QUOTA },
  { re: /no (cookie )?auth|user not found|invalid.*(api ?key|token)|unauthor/i, errClass: ErrClass.AUTH },
  { re: /permission|forbidden/i, errClass: ErrClass.AUTH },
  { re: /model.*not.*(found|exist)|no allowed providers|no endpoints found/i, errClass: ErrClass.CONFIG_FAULT },
  { re: /context.*(length|token)|max.*token|too long|invalid.*(request|parameter)/i, errClass: ErrClass.REQUEST_FAULT },
];

/**
 * `Provider returned error` 包装壳里的**真实原因**特征（实测 2026-10-06）。
 *
 * 这里要区分两类，否则状态码会误导客户端：
 *
 *  ① 提供方限流（`temporarily rate-limited upstream`）→ **QUOTA**
 *     这是"稍后重试就好"，绝不能报成 404 让客户端以为模型不存在。
 *  ② 提供方服务不了（地区限制 / 客户端门禁 / 无可用端点）→ **CONFIG_FAULT**
 *     这个模型在这个 provider 走不通，该换渠道或换模型。
 */
const PROVIDER_FAULT_HINTS = [
  { re: /location is not supported|not available in your (region|country)/i },
  { re: /only available on agentic harnesses|agentic harness/i },
  { re: /no (allowed )?providers?|no endpoints? (found|available)/i },
  { re: /provider (is )?(down|unavailable)|upstream.*unavailable/i },
];

/** 提供方侧的限流特征 —— 归 QUOTA（可恢复，稍后重试） */
const PROVIDER_RATE_LIMIT = /rate.?limit|too many request|overloaded|capacity/i;

/** 免费但 id 不带 `:free` 后缀的例外（实测） */
export const FREE_EXCEPTIONS = new Set([
  'openrouter/free',
  'inclusionai/ling-3.1-flash',
]);

/** 判断一个 /models 条目是否免费 */
export function isFreeModel(m) {
  if (!m || !m.id) return false;
  const p = m.pricing;
  // pricing 是逐 token 的字符串价格，"0" 即免费（最可靠判据）
  if (p && p.prompt !== undefined && p.completion !== undefined) {
    return Number(p.prompt) === 0 && Number(p.completion) === 0;
  }
  // 没有 pricing 字段时回落到后缀 / 白名单
  return /:free$/.test(m.id) || FREE_EXCEPTIONS.has(m.id);
}

export class OpenRouterAdapter extends BaseAdapter {
  constructor() {
    super({
      id: 'openrouter',
      displayName: 'OpenRouter',
      defaultBaseUrl: 'https://openrouter.ai/api/v1',
    });
    /**
     * 标记：这个渠道的上游 /models 是"混合的"（465 个里只有 16 个免费）。
     * 拉取时默认只保留免费模型 —— 见 parseModels。
     */
    this.freeOnlyModels = true;
  }

  /**
   * 拉模型清单。**默认只保留免费模型** —— 这是本渠道存在的意义。
   * 设为 OPENROUTER_FREE_ONLY=0 可拉全量 465 个。
   */
  parseModels(json, { freeOnly = true } = {}) {
    if (!json || !Array.isArray(json.data)) return [];
    const rows = freeOnly ? json.data.filter(isFreeModel) : json.data;
    return rows.map((m) => (typeof m === 'string' ? m : m?.id)).filter(Boolean);
  }

  /** 供管理页展示：免费 / 全量 分别多少 */
  static summarize(json) {
    const all = Array.isArray(json?.data) ? json.data : [];
    const free = all.filter(isFreeModel);
    return {
      total: all.length,
      free: free.length,
      freeIds: free.map((m) => m.id),
    };
  }

  tryParseError(bodyText) {
    if (!bodyText) return null;
    let json;
    try { json = JSON.parse(bodyText); } catch { return null; }

    const err = json.error ?? json;
    const rawCode = err.code ?? null;
    const message = err.message ?? err.msg ?? '';
    const traceId = json.id ?? err.trace_id ?? null;

    // ① 【最关键】`Provider returned error` 是包装壳 —— 真原因在 metadata.raw / metadata 里。
    //    不剥开的话会把它误判成 request_fault（不换渠道），
    //    而真相往往是"这个 provider 服务不了"或"provider 侧限流"，两者都该处理。
    const real = extractProviderFault(err);
    if (real) {
      // 提供方限流 → QUOTA（可恢复）；其余提供方故障 → CONFIG_FAULT（换渠道）
      const isRate = PROVIDER_RATE_LIMIT.test(real);
      return {
        errClass: isRate ? ErrClass.QUOTA : ErrClass.CONFIG_FAULT,
        message: `上游提供方${isRate ? '限流' : '无法服务该请求'}：${real}`,
        code: isRate ? 'provider_rate_limited' : 'provider_error',
        traceId,
      };
    }

    // ② 数字 code（OpenRouter 实测形态）
    const num = typeof rawCode === 'number'
      ? rawCode
      : (typeof rawCode === 'string' && /^\d+$/.test(rawCode) ? +rawCode : null);
    if (num != null && NUM_CODE_MAP[num]) {
      const m = NUM_CODE_MAP[num];
      return { errClass: m.errClass, message: message || `HTTP ${num}`, code: rawCode, traceId };
    }

    // ③ 文本特征
    for (const h of STR_HINTS) {
      if (h.re.test(String(message))) {
        return { errClass: h.errClass, message: message || String(rawCode), code: rawCode, traceId };
      }
    }

    // ④ 认不出 → 交给基类按 HTTP 状态兜底
    if (rawCode != null || message) {
      return { errClass: ErrClass.TRANSIENT, message: message || `上游错误 code=${rawCode}`, code: rawCode, traceId };
    }
    return null;
  }
}

/**
 * 从 OpenRouter 的错误对象里抽出"提供方层"的真实原因。
 *
 * 实测响应长这样：
 * {
 *   "error": {
 *     "message": "Provider returned error",     ← 无用，只有壳
 *     "code": 400,
 *     "metadata": {
 *       "raw": "{\"error\":{\"code\":400,\"message\":\"User location is not supported...\",\"status\":\"FAILED_PRECONDITION\"}}",
 *       "provider_name": "Google AI Studio"
 *     }
 *   }
 * }
 * 或者：
 * {
 *   "error": {
 *     "message": "xxx is only available on agentic harnesses. Try plugging it into ...",
 *     "code": 403,
 *     "metadata": { "failed_routing_step": "Gate Free Endpoints by Agentic Harness" }
 *   }
 * }
 *
 * @returns {string|null} 真实原因文本；不是提供方故障时返回 null
 */
function extractProviderFault(err) {
  const meta = err?.metadata;
  if (!meta || typeof meta !== 'object') return null;

  const provider = meta.provider_name ? `[${meta.provider_name}] ` : '';

  // metadata.raw 是**被序列化成字符串的 JSON**，得再解一层
  if (typeof meta.raw === 'string' && meta.raw.trim()) {
    let inner = null;
    try { inner = JSON.parse(meta.raw); } catch { /* 可能是纯文本 */ }
    const innerMsg = inner?.error?.message ?? inner?.message ?? null;
    if (innerMsg) return provider + innerMsg;
    return provider + meta.raw.slice(0, 300);
  }

  // 消息本身就带了可识别的提供方故障特征
  const msg = String(err?.message ?? '');
  for (const h of PROVIDER_FAULT_HINTS) {
    if (h.re.test(msg)) return provider + msg;
  }
  if (meta.failed_routing_step) {
    return `${provider}路由失败于「${meta.failed_routing_step}」`;
  }
  return null;
}

export default new OpenRouterAdapter();
