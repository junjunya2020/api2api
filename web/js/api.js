/**
 * API 客户端。
 * token 存放于 localStorage（本机使用，仅监听 127.0.0.1）。
 */

const TOKEN_KEY = 'api2api_token';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}

export function setToken(t) {
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
}

class ApiError extends Error {
  constructor(status, message, payload) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload;
  }
}

async function request(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  const tk = getToken();
  if (tk) headers.Authorization = `Bearer ${tk}`;

  const res = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }

  if (!res.ok) {
    const msg = json?.error?.message || json?.message || text.slice(0, 300) || `HTTP ${res.status}`;
    throw new ApiError(res.status, msg, json);
  }
  return json;
}

export const api = {
  // 基础
  health: () => request('GET', '/healthz'),

  // 渠道
  channels: () => request('GET', '/api/channels'),
  /** 一次性提交完整渠道顺序（渠道优先级） */
  reorderChannels: (order) => request('POST', '/api/channels/reorder', { order }),
  patchChannel: (id, patch) => request('PATCH', `/api/channels/${encodeURIComponent(id)}`, patch),

  // 运行设置（控制台可切，立即生效）
  settings: () => request('GET', '/api/settings'),
  patchSettings: (patch) => request('PATCH', '/api/settings', patch),

  // Key
  listKeys: (channel) => request('GET', `/api/keys${channel ? `?channel=${encodeURIComponent(channel)}` : ''}`),
  getKey: (uuid) => request('GET', `/api/keys/${encodeURIComponent(uuid)}`),
  addKey: (payload) => request('POST', '/api/keys', payload),
  bulkAddKeys: (channel, keys) => request('POST', '/api/keys/bulk', { channel, keys }),
  patchKey: (uuid, patch) => request('PATCH', `/api/keys/${encodeURIComponent(uuid)}`, patch),
  deleteKey: (uuid) => request('DELETE', `/api/keys/${encodeURIComponent(uuid)}`),
  resetKey: (uuid, model) => request('POST', `/api/keys/${encodeURIComponent(uuid)}/reset`, { model: model ?? null }),

  // 测活
  checkChannel: (channel) => request('POST', '/api/keys/check', { scope: 'channel', channel }),
  checkModel: (model, channel) => request('POST', '/api/keys/check', { scope: 'model', model, channel: channel || null }),

  // 模型映射
  listAliases: (channel) => request('GET', `/api/aliases${channel ? `?channel=${encodeURIComponent(channel)}` : ''}`),
  addAlias: (payload) => request('POST', '/api/aliases', payload),
  patchAlias: (id, patch) => request('PATCH', `/api/aliases/${id}`, patch),
  deleteAlias: (id) => request('DELETE', `/api/aliases/${id}`),
  models: () => request('GET', '/api/models'),
  upstreamModels: () => request('GET', '/api/models/upstream'),
  fetchUpstreamModels: (channel) => request('POST', '/api/models/fetch', { channel }),
  clearUpstreamModels: (channel) => request('DELETE', channel ? `/api/models/upstream?channel=${encodeURIComponent(channel)}` : '/api/models/upstream?all=true'),

  // 观测
  stats: () => request('GET', '/api/stats'),
  states: (channel) => request('GET', `/api/stats/states${channel ? `?channel=${encodeURIComponent(channel)}` : ''}`),
  logs: (limit) => request('GET', `/api/logs?limit=${limit || 100}`),

  // ⭐ 模型黑名单（原始渠道名 + 原始上游模型名）
  blacklist: ({ channel, source } = {}) => {
    const q = new URLSearchParams();
    if (channel) q.set('channel', channel);
    if (source) q.set('source', source);
    const s = q.toString();
    return request('GET', `/api/blacklist${s ? `?${s}` : ''}`);
  },
  banModel: (payload) => request('POST', '/api/blacklist', payload),
  unbanModel: (channel, model) => request('POST', '/api/blacklist/unban', { channel, model }),
  syncFastBans: () => request('POST', '/api/blacklist/sync-fast', {}),

  // ⭐ 模型归并（别名 → 规范名）
  synonyms: () => request('GET', '/api/synonyms'),
  addSynonym: (payload) => request('POST', '/api/synonyms', payload),
  deleteSynonym: (name) => request('DELETE', `/api/synonyms/${encodeURIComponent(name)}`),

  // ⭐ 模型健康度（正常 / 降级 / 不可用）
  modelHealth: ({ channel, state } = {}) => {
    const q = new URLSearchParams();
    if (channel) q.set('channel', channel);
    if (state) q.set('state', state);
    const s = q.toString();
    return request('GET', `/api/model-health${s ? `?${s}` : ''}`);
  },
  resetModelHealth: (channel, model) => request('POST', '/api/model-health/reset', { channel, model: model ?? null }),
  modelRules: () => request('GET', '/api/model-rules'),

  // ⭐ 成功率
  rates: (limit) => request('GET', `/api/stats/rates?limit=${limit || 5000}`),
  ratesByModel: (limit) => request('GET', `/api/stats/rates/model?limit=${limit || 5000}`),

  // token
  tokens: () => request('GET', '/api/tokens'),
  newToken: (name) => request('POST', '/api/tokens', { name }),
  deleteToken: (name) => request('DELETE', `/api/tokens/${encodeURIComponent(name)}`),
};

export { ApiError };
export default api;
