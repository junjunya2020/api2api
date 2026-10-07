/**
 * 极简 HTTP 路由与工具。
 * 不引入框架：node:http 的 req/res 直接够用。
 */
import config from '../config.mjs';
import { ApiError } from '../util/errors.mjs';

/** 读取 JSON body */
export async function readJson(req, limit = config.maxBodyBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, '请求体过大');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'JSON 解析失败');
  }
}

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.extra = extra;
  }
}

/** 统一 JSON 响应 */
export function sendJson(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

export function sendError(res, status, message, { code = null, type = 'api_error', traceId = null } = {}) {
  sendJson(res, status, {
    error: { message, type, param: null, code, ...(traceId ? { trace_id: traceId } : {}) },
  });
}

/** 从 Authorization / x-api-key 里取 token */
export function extractToken(req) {
  const auth = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (m) return m[1].trim();
  if (req.headers['x-api-key']) return String(req.headers['x-api-key']).trim();
  if (req.headers['api-key']) return String(req.headers['api-key']).trim();
  return null;
}

/** 极简 path 匹配：/api/keys/:uuid */
export function matchPath(pattern, pathname) {
  const p = pattern.split('/').filter(Boolean);
  const a = pathname.split('/').filter(Boolean);
  if (p.length !== a.length) return null;
  const params = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(':')) params[p[i].slice(1)] = decodeURIComponent(a[i]);
    else if (p[i] !== a[i]) return null;
  }
  return params;
}

/** 把 parse 出来的 query 转成普通对象 */
export function queryObj(url) {
  const out = {};
  for (const [k, v] of url.searchParams.entries()) out[k] = v;
  return out;
}

/** 从 ApiError / HttpError / 未知异常生成响应 */
export function handleThrown(res, e, fallbackMessage = '内部错误') {
  if (res.headersSent) {
    try { res.end(); } catch { /* ignore */ }
    return;
  }
  if (e instanceof ApiError) {
    sendJson(res, e.status, e.toOpenAI(), e.toHeaders());
    return;
  }
  if (e instanceof HttpError) {
    sendError(res, e.status, e.message, e.extra);
    return;
  }
  if (e && e.status && typeof e.status === 'number') {
    sendError(res, e.status, e.message ?? fallbackMessage);
    return;
  }
  sendError(res, 500, e?.message ?? fallbackMessage);
}

export default { readJson, sendJson, sendError, extractToken, matchPath, queryObj, handleThrown, HttpError };
