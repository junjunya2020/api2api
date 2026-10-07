/**
 * 请求流水仓储。写入量大，提供清理接口。
 */
import { all, one, run, scalar } from './index.mjs';

export function logRequest({ model, publicModel, channelId, keyUuid, status, errClass, upstreamTrace, latencyMs, ttfbMs, attempts, chain }) {
  try {
    run(`INSERT INTO request_log
      (ts, model, public_model, channel_id, key_uuid, status, err_class, upstream_trace, latency_ms, ttfb_ms, attempts, chain)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      Date.now(), model, publicModel, channelId, keyUuid, status, errClass,
      upstreamTrace ?? null, latencyMs ?? null, ttfbMs ?? null, attempts ?? null,
      chain ? JSON.stringify(chain) : null,
    );
  } catch { /* 流水失败不影响主流程 */ }
}

export function recentLogs(limit = 100, { model = null } = {}) {
  if (model) {
    return all('SELECT * FROM request_log WHERE model = ? ORDER BY id DESC LIMIT ?', model, Math.min(limit, 1000));
  }
  return all('SELECT * FROM request_log ORDER BY id DESC LIMIT ?', Math.min(limit, 1000));
}

/** 聚合统计：按渠道的成功率、延迟 */
export function statsByChannel() {
  return all(`
    SELECT c.name AS channel, c.display_name,
           COUNT(l.id) AS requests,
           SUM(CASE WHEN l.status >= 200 AND l.status < 300 THEN 1 ELSE 0 END) AS ok,
           CAST(AVG(CASE WHEN l.status >= 200 AND l.status < 300 THEN l.latency_ms END) AS INTEGER) AS avg_ok_latency,
           MAX(l.ts) AS last_ts
    FROM channel c LEFT JOIN request_log l ON l.channel_id = c.id
    GROUP BY c.id ORDER BY c.sort_order
  `);
}

/** 错误分类分布（最近 N 条） */
export function errClassDistribution(limit = 2000) {
  return all(`
    SELECT err_class, COUNT(*) AS n FROM (
      SELECT err_class FROM request_log ORDER BY id DESC LIMIT ?
    ) GROUP BY err_class ORDER BY n DESC
  `, limit);
}

/** 清理旧流水，保留最近 keep 条 */
export function pruneLogs(keep = 20000) {
  const total = scalar('SELECT COUNT(*) FROM request_log') ?? 0;
  if (total <= keep) return 0;
  const cut = scalar('SELECT id FROM request_log ORDER BY id DESC LIMIT 1 OFFSET ?', keep);
  if (!cut) return 0;
  const res = run('DELETE FROM request_log WHERE id <= ?', cut);
  return res.changes;
}

export function clearLogs() {
  return run('DELETE FROM request_log').changes;
}

export default { logRequest, recentLogs, statsByChannel, errClassDistribution, pruneLogs, clearLogs };
