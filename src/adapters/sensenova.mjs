/**
 * 商汤日日新适配器。
 *
 * ⚠️ 实测发现商汤在同一端点内有 **两套错误壳**（2026-10-06 真 Key 实测）：
 *
 *   ① 认证失败（未登录 / Key 无效）—— gRPC-gateway 风格，**非标准**：
 *      {"error": {"code": 16, "message": "Forbidden"}}          [401]
 *
 *   ② 业务错误 —— **标准 OpenAI 壳**，但 code 常是字符串枚举：
 *      {"error":{"message":"required model","type":"invalid_request_error","code":"3"}}
 *      {"error":{"message":"model route not found","type":"invalid_request_error","code":"5"}}
 *      {"error":{"message":"inference exceeds tpm/rpm limit",
 *                "type":"rate_limit_error","code":"RateLimitExceeded.EndpointRPMExceeded"}}
 *
 * 因此解析逻辑必须同时覆盖两条路径，且**字符串 code 优先于数字 code 判断**。
 */
import { BaseAdapter } from './base.mjs';
import { ErrClass } from '../util/errors.mjs';

/** gRPC status code → { 归类, 建议 HTTP 状态 } */
const GRPC_MAP = {
  1:  { errClass: ErrClass.TRANSIENT,     http: 500 }, // CANCELLED
  2:  { errClass: ErrClass.TRANSIENT,     http: 500 }, // UNKNOWN
  3:  { errClass: ErrClass.REQUEST_FAULT, http: 400 }, // INVALID_ARGUMENT
  4:  { errClass: ErrClass.TRANSIENT,     http: 504 }, // DEADLINE_EXCEEDED
  5:  { errClass: ErrClass.CONFIG_FAULT,  http: 404 }, // NOT_FOUND
  6:  { errClass: ErrClass.CONFIG_FAULT,  http: 409 }, // ALREADY_EXISTS
  7:  { errClass: ErrClass.AUTH,          http: 403 }, // PERMISSION_DENIED
  8:  { errClass: ErrClass.QUOTA,         http: 429 }, // RESOURCE_EXHAUSTED
  9:  { errClass: ErrClass.REQUEST_FAULT, http: 400 }, // FAILED_PRECONDITION
  10: { errClass: ErrClass.CONFIG_FAULT,  http: 409 }, // ABORTED
  11: { errClass: ErrClass.REQUEST_FAULT, http: 400 }, // OUT_OF_RANGE
  12: { errClass: ErrClass.CONFIG_FAULT,  http: 501 }, // UNIMPLEMENTED
  13: { errClass: ErrClass.TRANSIENT,     http: 500 }, // INTERNAL
  14: { errClass: ErrClass.TRANSIENT,     http: 503 }, // UNAVAILABLE
  15: { errClass: ErrClass.TRANSIENT,     http: 500 }, // DATA_LOSS
  16: { errClass: ErrClass.AUTH,          http: 401 }, // UNAUTHENTICATED
};

/**
 * 商汤字符串 code 枚举 → 归类（**真 Key 实测收集**）。
 * 形如 `RateLimitExceeded.EndpointRPMExceeded` —— 取第一段做前缀匹配。
 */
const STR_CODE_MAP = [
  { re: /^RateLimitExceeded/i,              errClass: ErrClass.QUOTA },
  { re: /^ResourceExhausted/i,              errClass: ErrClass.QUOTA },
  { re: /^QuotaExceeded/i,                  errClass: ErrClass.QUOTA },
  { re: /^InsufficientBalance/i,            errClass: ErrClass.QUOTA },
  { re: /^Unauthenticated/i,                errClass: ErrClass.AUTH },
  { re: /^PermissionDenied/i,               errClass: ErrClass.AUTH },
  { re: /^InvalidApiKey/i,                  errClass: ErrClass.AUTH },
  { re: /^NotFound/i,                       errClass: ErrClass.CONFIG_FAULT },
  { re: /^ModelNot/i,                       errClass: ErrClass.CONFIG_FAULT },
  { re: /^Unimplemented/i,                  errClass: ErrClass.CONFIG_FAULT },
  { re: /^DeadlineExceeded/i,               errClass: ErrClass.TRANSIENT },
  { re: /^Unavailable/i,                    errClass: ErrClass.TRANSIENT },
  { re: /^Internal/i,                       errClass: ErrClass.TRANSIENT },
  { re: /^InvalidArgument/i,                errClass: ErrClass.REQUEST_FAULT },
  { re: /^OutOfRange/i,                     errClass: ErrClass.REQUEST_FAULT },
  { re: /^FailedPrecondition/i,             errClass: ErrClass.REQUEST_FAULT },
];

/** 商汤非 gRPC 但语义明确的文本特征 */
const TEXT_HINTS = [
  { re: /tpm\/rpm|rate ?limit|too many request|限流|频率|exceeds.*limit/i, errClass: ErrClass.QUOTA },
  { re: /quota|exhaust|insufficient|balance|额度|余额|超限/i, errClass: ErrClass.QUOTA },
  { re: /is not supported|model route not found|model is not found|模型不存在|模型未上线/i, errClass: ErrClass.CONFIG_FAULT },
  { re: /invalid.*(api ?key|token)|unauthor|forbidden|token.*(expired|invalid)/i, errClass: ErrClass.AUTH },
  { re: /permission|no access|无权限/i, errClass: ErrClass.AUTH },
  { re: /context.*(length|token)|max.*token.*exceed|too long|上下文/i, errClass: ErrClass.REQUEST_FAULT },
];

export class SensenovaAdapter extends BaseAdapter {
  constructor() {
    super({
      id: 'sensenova',
      displayName: '商汤日日新',
      defaultBaseUrl: 'https://token.sensenova.cn/v1',
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

    const err = json.error ?? json;
    const rawCode = err.code ?? json.code ?? null;
    const message = err.message ?? err.msg ?? json.message ?? '';
    const traceId = err.trace_id ?? json.trace_id ?? json.request_id ?? null;

    // ① 非数字字符串 code 枚举（商汤业务错误的实际形态，优先级最高）
    //    例：{"message":"inference exceeds tpm/rpm limit",
    //         "type":"rate_limit_error","code":"RateLimitExceeded.EndpointRPMExceeded"}
    if (typeof rawCode === 'string' && rawCode !== '' && !/^\d+$/.test(rawCode)) {
      for (const m of STR_CODE_MAP) {
        if (m.re.test(rawCode)) {
          return { errClass: m.errClass, message: message || rawCode, code: rawCode, traceId };
        }
      }
    }

    // ② 数字 / 纯数字串 code → gRPC 表
    //    覆盖两类：{"code":16,"message":"Forbidden"}（认证失败）
    //             {"code":"3"/"5","message":"..."}（业务错误，复用了 gRPC 编号）
    //    ⚠️ 必须排在文本匹配之前：否则 "field MaxTokens invalid" 会被
    //       文本规则里的 token.*invalid 误判成 AUTH。
    const numCode = typeof rawCode === 'number'
      ? rawCode
      : (typeof rawCode === 'string' && /^\d+$/.test(rawCode) ? +rawCode : null);
    if (numCode != null && GRPC_MAP[numCode]) {
      const m = GRPC_MAP[numCode];
      return { errClass: m.errClass, message: message || `gRPC ${numCode}`, code: rawCode, traceId };
    }

    // ③ 文本特征兜底（code 未知或缺失时）
    for (const h of TEXT_HINTS) {
      if (h.re.test(String(message))) {
        return { errClass: h.errClass, message: message || String(rawCode), code: rawCode, traceId };
      }
    }

    // ④ 有 error 壳但认不出 → 返回 TRANSIENT，由基类按 HTTP 状态纠正
    if (rawCode != null || message) {
      return { errClass: ErrClass.TRANSIENT, message: message || `上游错误 code=${rawCode}`, code: rawCode, traceId };
    }
    return null;
  }
}

export default new SensenovaAdapter();
