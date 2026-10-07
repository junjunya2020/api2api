/**
 * api2api —— 多渠道 × 多 Key 聚合路由服务
 *
 * 入口。只监听 127.0.0.1，外部访问走 SSH 隧道：
 *   ssh -N -L 3210:127.0.0.1:3210 root@<your-host>
 *
 * 设计约束（用户明确要求）：
 *   - 不做协议转换，只原样透传 + 识别错误码
 *   - 不做额度/配额窗口识别
 *   - cliproxy 只抄路由（优先级桶 / smooth-WRR / 冷却 / 状态机 / 错误分类）
 *   - 全渠道依次尝试，首个成功立即返回
 */
import http from 'node:http';
import config, { ensureDirs } from './src/config.mjs';
import log from './src/util/log.mjs';
import { getDb, closeDb } from './src/db/index.mjs';
import { ensureAdminToken } from './src/db/tokens.mjs';
import { verifyToken } from './src/db/tokens.mjs';
import { handleV1 } from './src/http/v1.mjs';
import { handleKeys } from './src/http/admin-keys.mjs';
import { handleAliases } from './src/http/admin-aliases.mjs';
import { handleMeta } from './src/http/admin-meta.mjs';
import { handleModelHealth } from './src/http/admin-model-health.mjs';
import { serveStatic } from './src/http/static.mjs';
import { extractToken, handleThrown, sendJson, sendError } from './src/http/util.mjs';

ensureDirs();
getDb();
const bootToken = ensureAdminToken();
if (bootToken) log.info(`[boot] admin token: ${bootToken}`);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const { pathname } = url;

  // CORS：仅本机使用，宽松处理便于本机 Web UI 与非浏览器客户端
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }

  try {
    // 存活探针
    if (pathname === '/healthz') {
      return sendJson(res, 200, { ok: true, service: 'api2api', ts: Date.now() });
    }

    // ---- 对外 /v1 ----
    if (pathname.startsWith('/v1/')) {
      const handled = await handleV1(req, res, url);
      if (handled !== false && !res.writableEnded) return;
      return;
    }

    // ---- 管理 API ----
    if (pathname.startsWith('/api/')) {
      // 管理面也需要 token（防止同机其他进程乱搞）
      const token = extractToken(req);
      if (!verifyToken(token)) {
        return sendError(res, 401, '管理 API 需要有效的 api2api token', { code: 'invalid_api_key' });
      }
      for (const handler of [handleKeys, handleAliases, handleModelHealth, handleMeta]) {
        const r = await handler(req, res, url);
        if (r !== false) return;
      }
      return sendError(res, 404, `未知的管理端点: ${pathname}`, { type: 'invalid_request_error' });
    }

    // ---- 静态 Web UI ----
    if (pathname === '/' || pathname === '/ui' || pathname.startsWith('/ui/') || pathname.startsWith('/css/') || pathname.startsWith('/js/')) {
      if (serveStatic(req, res, pathname)) return;
      return sendError(res, 404, `未找到: ${pathname}`);
    }

    return sendError(res, 404, `未找到: ${pathname}`);
  } catch (e) {
    // 业务性 4xx（参数错、重复、找不到）是预期内的，用 warn；5xx 才是真异常
    const status = e?.status && typeof e.status === 'number' ? e.status : 500;
    const line = `[http] ${req.method} ${pathname} → ${status}: ${e?.message}`;
    if (status >= 500) log.error(line, e?.stack ?? '');
    else log.warn(line);
    handleThrown(res, e);
  }
});

server.on('clientError', (err, socket) => {
  try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch { /* ignore */ }
});

server.listen(config.port, config.host, () => {
  log.info(`[boot] api2api 已启动 http://${config.host}:${config.port}`);
  log.info(`[boot] 仅监听本机；外部访问请建立 SSH 隧道`);
  log.info(`[boot] 数据文件: ${config.dbFile}`);
});

function shutdown(sig) {
  log.info(`[shutdown] 收到 ${sig}，正在关闭...`);
  server.close(() => {
    closeDb();
    log.info('[shutdown] 已关闭');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (e) => log.error('[unhandledRejection]', e?.stack ?? e));
