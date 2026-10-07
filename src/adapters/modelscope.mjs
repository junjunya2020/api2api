/**
 * ModelScope 魔搭（modelscope.cn / 阿里云）适配器。
 *
 * 端点 `https://api-inference.modelscope.cn/v1`，OpenAI 兼容，Bearer = ms-…（Access Token）。
 *
 * 免费额度（2026-10 实测 + 官方口径）：**2000 次/天**（单模型 ≤500 次/天），无 token 计费。
 * 目录 35 个模型：DeepSeek-V4 系 / Qwen3.5-3.8 / GLM-4.7-Flash / Intern-S2 / MiniMax-M3 / Step-3.7-Flash 等。
 *
 * ⚠️ 关键门槛（实测）：
 *   token 本身**可列模型**（GET /v1/models → 200），但**任何 chat 调用**都会先撞一道账号门：
 *     401 `{"error":{"message":"Please bind your Alibaba Cloud account before use.","request_id":"..."}}`
 *   → 必须先在 ModelScope 上**绑定阿里云账号**，推理才放行。
 *   这是**账号级**门槛（不是模型级）→ 归类 AUTH（Key 在修好之前整体不可用）。
 *
 * 错误壳（实测）：标准 OpenAI 壳 + 顶层 `request_id`：
 *   - 401 `{"error":{"message":"Please bind your Alibaba Cloud account before use.",...}}` → AUTH
 *   - 401 `{"error":{"message":"Authentication failed...valid ModelScope token is supplied.","request_id":"..."}}` → AUTH
 *   - 429 `{"error":{"message":"...rate limit...","request_id":"..."}}` → QUOTA
 *   - 404 / 400 → CONFIG_FAULT / REQUEST_FAULT（按文本判定）
 */
import { BaseAdapter } from './base.mjs';
import { ErrClass } from '../util/errors.mjs';

export class ModelScopeAdapter extends BaseAdapter {
  constructor() {
    super({
      id: 'modelscope',
      displayName: '魔搭 ModelScope',
      defaultBaseUrl: 'https://api-inference.modelscope.cn/v1',
    });
  }

  tryParseError(bodyText) {
    if (!bodyText) return null;
    let json;
    try { json = JSON.parse(bodyText); } catch { return null; }

    // ① 标准 OpenAI 壳（ModelScope 唯一形态，request_id 挂在顶层）
    const e = json.error;
    if (e || json.message) {
      const err = typeof e === 'string' ? { message: e } : (e ?? json);
      const message = err.message ?? json.message ?? '';
      const code = err.code ?? null;
      const traceId = json.request_id ?? err.request_id ?? err.trace_id ?? null;

      let errClass = ErrClass.TRANSIENT;
      const s = `${code ?? ''} ${message}`.toLowerCase();
      if (/bind your alibaba cloud|invalid.?api.?key|authentication failed|unauthor|invalid_api_key|access token.*invalid/.test(s)) {
        errClass = ErrClass.AUTH;
      } else if (/rate.?limit|too many requests|quota|throttl/.test(s)) {
        errClass = ErrClass.QUOTA;
      } else if (/not found|no such model|model_not_found|does not exist/.test(s)) {
        errClass = ErrClass.CONFIG_FAULT;
      } else if (/context|invalid|max_tokens|unsupported/.test(s)) {
        errClass = ErrClass.REQUEST_FAULT;
      }
      return { errClass, message, code, traceId };
    }
    return null;
  }
}

export const modelscope = new ModelScopeAdapter();
export default modelscope;
