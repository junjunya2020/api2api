/**
 * 书生（上海AI实验室 · 墨点计划 / discovery）适配器。
 *
 * 实测错误壳（未登录探针，2026-10-06）：
 *   {"error":{"message":"invalid API key","type":"invalid_request_error",
 *             "param":null,"code":"invalid_api_key","trace_id":"..."},
 *    "request_id":"req_..."}
 * **已经是标准 OpenAI 兼容格式**，因此这里只做"读"不做的"改" —— 成功响应原样透传。
 *
 * 注意：本项目**不做** `chat.intern-ai.org.cn/api/v1` 那个老入口
 * （它的壳是私有格式 {"traceId","msgCode","msg"}，用户已确认不需要）。
 */
import { BaseAdapter } from './base.mjs';
import { ErrClass, classifyByStatus } from '../util/errors.mjs';

/** OpenAI 标准 code → 归类 */
const CODE_MAP = {
  invalid_api_key: ErrClass.AUTH,
  invalid_authentication: ErrClass.AUTH,
  authentication_error: ErrClass.AUTH,
  permission_denied: ErrClass.AUTH,
  insufficient_quota: ErrClass.QUOTA,
  rate_limit_exceeded: ErrClass.QUOTA,
  quota_exceeded: ErrClass.QUOTA,
  model_not_found: ErrClass.CONFIG_FAULT,
  // 实测（2026-10-06）：书生用 "model_not_available" 表达"该模型不在我这边"
  model_not_available: ErrClass.CONFIG_FAULT,
  invalid_request_error: ErrClass.REQUEST_FAULT,
  context_length_exceeded: ErrClass.REQUEST_FAULT,
  invalid_parameter: ErrClass.REQUEST_FAULT,
  server_error: ErrClass.TRANSIENT,
};

/** 书生 err.type 字段 → 归类（实测它比 code 更语义化） */
const TYPE_MAP = {
  invalid_api_key: ErrClass.AUTH,
  authentication_error: ErrClass.AUTH,
  permission_denied: ErrClass.AUTH,
  insufficient_quota: ErrClass.QUOTA,
  rate_limit_error: ErrClass.QUOTA,
  model_not_available: ErrClass.CONFIG_FAULT,
  model_not_found: ErrClass.CONFIG_FAULT,
  invalid_request_error: ErrClass.REQUEST_FAULT,
  server_error: ErrClass.TRANSIENT,
};

const TEXT_HINTS = [
  { re: /rate ?limit|too many request|限流/i, errClass: ErrClass.QUOTA },
  { re: /quota|insufficient|balance|余额|额度/i, errClass: ErrClass.QUOTA },
  { re: /not supported by|is not supported|model.*not.*(found|exist|available)|模型不存在|模型未上线/i, errClass: ErrClass.CONFIG_FAULT },
  { re: /invalid.*(api ?key|token)|authentication|unauthor|token.*expired/i, errClass: ErrClass.AUTH },
  { re: /context.*(length|token)|too long/i, errClass: ErrClass.REQUEST_FAULT },
];

export class InternAdapter extends BaseAdapter {
  constructor() {
    super({
      id: 'intern',
      displayName: '书生·墨点',
      defaultBaseUrl: 'https://discovery-api.intern-ai.org.cn/v1',
    });
  }

  tryParseError(bodyText) {
    if (!bodyText) return null;
    let json;
    try {
      json = JSON.parse(bodyText);
    } catch {
      return null;
    }

    const err = json.error;
    if (!err || typeof err !== 'object') {
      // 有些标准实现把错误放在顶层
      const topMsg = json.message ?? json.detail;
      if (!topMsg) return null;
      return this._byText(String(topMsg), json.code ?? null, json.request_id ?? json.trace_id ?? null);
    }

    const code = err.code ?? null;
    const type = err.type ?? null;
    const message = err.message ?? '';
    const traceId = err.trace_id ?? json.request_id ?? json.trace_id ?? null;

    // ① code 精确匹配
    if (code && CODE_MAP[code]) {
      return { errClass: CODE_MAP[code], message, code, traceId };
    }
    // ② type 匹配（实测 type 比 code 更语义化，如 model_not_available）
    if (type && TYPE_MAP[type]) {
      return { errClass: TYPE_MAP[type], message, code: code ?? type, traceId };
    }
    // ③ 文本兜底
    return this._byText(message, code, traceId);
  }

  _byText(message, code, traceId) {
    for (const h of TEXT_HINTS) {
      if (h.re.test(String(message))) {
        return { errClass: h.errClass, message: message || String(code), code, traceId };
      }
    }
    if (message) {
      return { errClass: ErrClass.TRANSIENT, message: String(message), code, traceId };
    }
    return null;
  }
}

export default new InternAdapter();
