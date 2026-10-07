/**
 * 对外 API（下游客户端用）：OpenAI 兼容形状。
 *
 *   POST /v1/chat/completions     原样透传，含流式
 *   POST /v1/images/generations   原样透传（商汤 u1-fast / u1.5-lite 走这个）
 *   POST /v1/messages             原样透传（Anthropic 协议，商汤支持）
 *   POST /v1/embeddings           原样透传
 *   GET  /v1/models               列出对外暴露的模型名
 *
 * 鉴权：Bearer <api2api 签发的 token>。客户端**永远拿不到上游 Key**。
 *
 * 设计：**不转换协议**。所有 POST 端点共用一条转发路径，
 * 只在转发时替换 body.model，其余字节级原样通过。
 */
import { relay, readBody, pipeResponse, passJson } from '../relay.mjs';
import { verifyToken } from '../db/tokens.mjs';
import { publicModelList } from '../db/aliases.mjs';
import { logRequest } from '../db/logs.mjs';
import { ErrClass, ApiError } from '../util/errors.mjs';
import { sendJson, sendError, extractToken, handleThrown } from './util.mjs';
import log from '../util/log.mjs';

/** 允许透传的上游路径（去掉 /v1 前缀后的尾部） */
const PASSTHROUGH = new Set([
  'chat/completions',
  'images/generations',
  'messages',
  'embeddings',
  'completions',
  'audio/speech',
  'audio/transcriptions',
]);

export async function handleV1(req, res, url) {
  const { pathname } = url;
  const token = extractToken(req);

  if (!verifyToken(token)) {
    return sendError(res, 401, 'api2api token 无效或缺失', {
      code: 'invalid_api_key', type: 'authentication_error',
    });
  }

  if (pathname === '/v1/models' && req.method === 'GET') {
    const models = publicModelList();
    return sendJson(res, 200, {
      object: 'list',
      data: models.map((m) => ({
        id: m.id,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'api2api',
        // 非标准字段，方便客户端了解这个模型挂在哪些渠道 / 是否改名而来
        channels: m.channels,
        source: m.kind,
        aliased_from: m.aliasedFrom,
      })),
    });
  }

  // 所有 POST 透传端点共用同一条路径
  if (req.method === 'POST' && pathname.startsWith('/v1/')) {
    const tail = pathname.slice(4).replace(/^\/+/, '');
    if (PASSTHROUGH.has(tail)) return handleRelay(req, res, tail);
  }

  return sendError(res, 404, `未知的 /v1 端点: ${pathname}`, { type: 'invalid_request_error' });
}

/** 通用转发：chat / images / messages / embeddings 共用 */
async function handleRelay(req, res, pathTail) {
  const raw = await readBody(req);
  let body;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    return sendError(res, 400, '请求体不是合法 JSON', { type: 'invalid_request_error' });
  }

  const publicModel = body?.model;
  if (!publicModel || typeof publicModel !== 'string') {
    return sendError(res, 400, '缺少 model 字段', { type: 'invalid_request_error', code: 'missing_model' });
  }

  const wantStream = !!body.stream;
  const t0 = Date.now();

  try {
    const { response, meta } = await relay({ publicModel, rawBody: raw, pathTail });

    // ✅ 首个成功 → 立即返回（流式不缓冲）
    if (wantStream) {
      const { ttfbMs } = await pipeResponse(response, res);
      logRequest({
        model: meta.channel?.upstreamName ?? null, publicModel,
        channelId: meta.channel?.channelId, keyUuid: meta.keyUuid,
        status: meta.status, errClass: ErrClass.OK,
        upstreamTrace: response.headers.get('x-request-id') ?? null,
        latencyMs: Date.now() - t0, ttfbMs, attempts: meta.attempts, chain: meta.chain,
      });
      log.req({ model: publicModel, ch: meta.channel?.channelName, status: meta.status, attempts: meta.attempts, ttfb: ttfbMs, stream: true });
    } else {
      await passJson(response, res);
      logRequest({
        model: meta.channel?.upstreamName ?? null, publicModel,
        channelId: meta.channel?.channelId, keyUuid: meta.keyUuid,
        status: meta.status, errClass: ErrClass.OK,
        upstreamTrace: response.headers.get('x-request-id') ?? null,
        latencyMs: Date.now() - t0, ttfbMs: null, attempts: meta.attempts, chain: meta.chain,
      });
      log.req({ model: publicModel, ch: meta.channel?.channelName, status: meta.status, attempts: meta.attempts, stream: false });
    }
  } catch (e) {
    // relay 在"全渠道耗尽"/"不可重试错误"时已经写过完整流水（含 chain），
    // 这里只补记那些没被记录过的（例如 404 无候选渠道、请求体过大）。
    if (e instanceof ApiError && !e.logged) {
      logRequest({
        model: null, publicModel, channelId: null, keyUuid: null,
        status: e.status, errClass: e.errClass,
        upstreamTrace: e.traceId, latencyMs: Date.now() - t0, ttfbMs: null, attempts: null, chain: null,
      });
    }
    log.req({
      model: publicModel,
      status: e?.status ?? 500,
      err: e?.errClass ?? null,
      msg: e?.message,
    });
    handleThrown(res, e);
  }
}

export default { handleV1 };
