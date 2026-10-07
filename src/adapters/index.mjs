/**
 * 适配器注册表 + 通用 OpenAI 兼容适配器（备用，供后续扩展渠道）。
 */
import { BaseAdapter } from './base.mjs';
import { ErrClass } from '../util/errors.mjs';
import sensenova from './sensenova.mjs';
import intern from './intern.mjs';
import openrouter from './openrouter.mjs';

/** 通用 OpenAI 兼容渠道（错误壳标准） */
class OpenAICompatAdapter extends BaseAdapter {
  tryParseError(bodyText) {
    if (!bodyText) return null;
    let json;
    try { json = JSON.parse(bodyText); } catch { return null; }
    const err = json.error;
    if (!err) return null;
    const message = err.message ?? '';
    const code = err.code ?? null;
    let errClass = ErrClass.TRANSIENT;
    const s = `${code} ${message}`.toLowerCase();
    if (/invalid_api_key|unauthor|authentication/.test(s)) errClass = ErrClass.AUTH;
    else if (/quota|rate_limit|insufficient/.test(s)) errClass = ErrClass.QUOTA;
    else if (/model_not_found|not_found/.test(s)) errClass = ErrClass.CONFIG_FAULT;
    else if (/context_length|invalid_request|invalid_parameter/.test(s)) errClass = ErrClass.REQUEST_FAULT;
    return { errClass, message, code, traceId: err.trace_id ?? json.request_id ?? null };
  }
}

export const openaiCompat = new OpenAICompatAdapter({
  id: 'openai_compat',
  displayName: '通用 OpenAI 兼容',
  defaultBaseUrl: '',
});

const registry = new Map([
  [sensenova.id, sensenova],
  [intern.id, intern],
  [openrouter.id, openrouter],
  [openaiCompat.id, openaiCompat],
]);

/** 按 adapter 名取适配器；未知则回落到通用 OpenAI 兼容 */
export function getAdapter(name) {
  return registry.get(name) ?? openaiCompat;
}

export function adapterIds() {
  return [...registry.keys()];
}

export default { getAdapter, adapterIds, openaiCompat, openrouter };
