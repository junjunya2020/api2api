/**
 * NVIDIA NIM（build.nvidia.com）适配器。
 *
 * 端点 `https://integrate.api.nvidia.com/v1`，OpenAI 兼容，Bearer = nvapi-…
 *
 * 错误壳实测（2026-10-07，真 key）：
 *   - 401 `{"error":{"message":"Invalid API key",...}}`            → AUTH
 *   - 402/429 `{"error":{"message":"...rate limit..."}}`           → QUOTA
 *   - 404 `{"status":404,"title":"Not Found","detail":"Function ..."}` → CONFIG_FAULT
 *     （NVIDIA 特有的**顶层不套 error 壳**的 404 —— 目录里有、本账号没订阅）
 *   - 410 `{"type":"about:blank","title":"Gone","detail":"...end of life..."}` → CONFIG_FAULT
 *     （模型已退役，永久）
 *   - 400 `{"object":"error","message":"Content cannot be a plain string..."}` → REQUEST_FAULT
 *
 * ⚠️ NVIDIA 的 404/410 **不套 `error` 对象**，基类的通用解析拿不到东西，
 *    只能靠 HTTP 状态码兜底 —— 所以这里显式解析顶层 title/detail。
 */
import { BaseAdapter } from './base.mjs';
import { ErrClass } from '../util/errors.mjs';

export class NvidiaAdapter extends BaseAdapter {
  constructor() {
    super({
      id: 'nvidia',
      displayName: 'NVIDIA NIM',
      defaultBaseUrl: 'https://integrate.api.nvidia.com/v1',
    });
  }

  tryParseError(bodyText) {
    if (!bodyText) return null;
    let json;
    try { json = JSON.parse(bodyText); } catch { return null; }

    // ① 标准 OpenAI 壳
    if (json.error) {
      const e = typeof json.error === 'string' ? { message: json.error } : json.error;
      const message = e.message ?? json.message ?? '';
      const code = e.code ?? null;
      return { errClass: this._classifyText(message, code), message, code,
        traceId: e.trace_id ?? json.request_id ?? null };
    }

    // ② NVIDIA 顶层壳（404 Not Found / 410 Gone / 400 object:error）
    const title = json.title ?? json.status_text ?? null;
    const detail = json.detail ?? json.message ?? null;
    if (title || detail) {
      const message = [title, detail].filter(Boolean).join(': ');
      let errClass = ErrClass.TRANSIENT;
      if (json.status === 410 || /end of life|deprecated|no longer available/i.test(message)) {
        errClass = ErrClass.CONFIG_FAULT;          // 退役 = 永久没有
      } else if (json.status === 404 || /not found/i.test(String(title))) {
        errClass = ErrClass.CONFIG_FAULT;          // 本账号没订阅这个"Function"
      } else if (json.status === 400 || json.object === 'error') {
        errClass = ErrClass.REQUEST_FAULT;
      } else if (json.status === 401 || json.status === 403) {
        errClass = ErrClass.AUTH;
      } else if (json.status === 429) {
        errClass = ErrClass.QUOTA;
      }
      return { errClass, message: message.slice(0, 400), code: json.status ?? title, traceId: null };
    }
    return null;
  }

  /** 文本特征分类（error 壳内没有明确 code 时） */
  _classifyText(message, code) {
    const s = `${code ?? ''} ${message ?? ''}`.toLowerCase();
    if (/invalid.?api.?key|unauthor|authentication|forbidden|permission/.test(s)) return ErrClass.AUTH;
    if (/rate.?limit|too many requests|quota|capacity|overloaded/.test(s)) return ErrClass.QUOTA;
    if (/not found|unknown model|no longer available|end of life|deprecated/.test(s)) return ErrClass.CONFIG_FAULT;
    if (/context|invalid|max_tokens|content cannot|unsupported/.test(s)) return ErrClass.REQUEST_FAULT;
    return ErrClass.TRANSIENT;
  }
}

export const nvidia = new NvidiaAdapter();
export default nvidia;
