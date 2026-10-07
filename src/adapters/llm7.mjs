/**
 * LLM7.io 适配器 —— 免费 LLM 聚合网关。
 *
 * 端点 `https://api.llm7.io/v1`（OpenAI 兼容），Bearer = `unused`（keyless）
 * 或注册后拿到的免费 token（更高限额）。
 *
 * 免费额度（实测 + 官方口径）：
 *   - 匿名/keyless：500,000 token/天，10 rpm / 60 rph
 *   - 免费邮箱 token：1,000,000 token/天，40 rpm / 250 rph / 2 rps
 *
 * 错误壳（2026-10-08 实测）：标准 OpenAI 壳 `{"error":{message,type,param,code,retry_after}}`，
 * 但 **code 是自定义字符串**，必须显式识别，否则会被通用适配器误判：
 *   - 401 `code=...`（invalid api key）                     → AUTH
 *   - 429 `code=rate_limit_exceeded`（带 retry_after）       → QUOTA
 *   - 402 `code=insufficient_balance`                       → CONFIG_FAULT
 *        “本模型是付费档、余额不足” —— 是**模型级不可用**，不是 Key 坏，
 *        也不是"稍后重试就好"。换 Key 无用（同一账号），应**跳过本渠道**。
 *   - 402 `code=pro_access_required`（Pro 订阅专属）          → CONFIG_FAULT
 *   - 400 `code=model_unavailable`（目录里有、当前下线）        → CONFIG_FAULT
 *   - 400 `does not support chat endpoints`（图像/语音模型）    → CONFIG_FAULT
 *
 * ⚠️ 为什么不用通用 `openai_compat`：它按文本含 `insufficient` 把 402 归成 QUOTA
 *    → 会对 Key 做冷却并反复重试无用的付费模型。这里必须归 CONFIG_FAULT（跳过）。
 */
import { BaseAdapter } from './base.mjs';
import { ErrClass } from '../util/errors.mjs';

export class Llm7Adapter extends BaseAdapter {
  constructor() {
    super({
      id: 'llm7',
      displayName: 'LLM7.io',
      defaultBaseUrl: 'https://api.llm7.io/v1',
    });
  }

  tryParseError(bodyText) {
    if (!bodyText) return null;
    let json;
    try { json = JSON.parse(bodyText); } catch { return null; }

    const e = json.error;
    if (!e && !json.message) return null;
    const err = typeof e === 'string' ? { message: e } : (e ?? json);
    const message = err.message ?? json.message ?? '';
    const code = err.code ?? null;
    const retryAfter = err.retry_after ?? json.retry_after ?? null;
    const traceId = json.request_id ?? err.request_id ?? null;

    let errClass = ErrClass.TRANSIENT;
    const s = `${code ?? ''} ${message}`.toLowerCase();

    if (/invalid.?api.?key|unauthor|authentication|missing api key/.test(s)) {
      errClass = ErrClass.AUTH;
    } else if (/rate.?limit|too many requests|rpm|exceeded/.test(s)) {
      errClass = ErrClass.QUOTA;
    } else if (/insufficient_balance|pro_access_required|balance|subscription/.test(s)) {
      // 付费档模型 / 余额不足 —— 本账号就是调不了，跳过渠道（别罚 Key）
      errClass = ErrClass.CONFIG_FAULT;
    } else if (/model_unavailable|not available|does not support|unsupported|not found|no such/.test(s)) {
      errClass = ErrClass.CONFIG_FAULT;
    } else if (/invalid_request|invalid_parameter|context/.test(s)) {
      errClass = ErrClass.REQUEST_FAULT;
    }
    return { errClass, message, code, traceId, retryAfterMs: retryAfter ? Number(retryAfter) * 1000 : null };
  }
}

export const llm7 = new Llm7Adapter();
export default llm7;
