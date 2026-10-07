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

/**
 * ⭐ 成功率统计（2026-10-07 用户要求「统计一下成功率」）。
 *
 * 口径说明（**必须与前端标注一致，否则会像"3 vs 4"那样自相矛盾**）：
 *   - 统计的是 **request_log 流水**，即"一次下游请求最终是否成功"，
 *     **不是**"每次上游尝试"。所以 attempts=5 才成功的那条，算 1 次成功。
 *   - `req`   = 该维度下的请求数
 *   - `ok`    = 最终 2xx 的请求数
 *   - `rate`  = ok / req
 *
 * 三个维度各自有用：
 *   byModel   —— 哪个模型最不稳（找"上游就是喜欢 429"的元凶）
 *   byKey     —— 哪把 Key 在拖后腿（找"该换掉"的 Key）
 *   byChannel —— 哪个渠道整体差
 *
 * @param {number} limit 只看最近 N 条流水（默认 5000，避免全表扫描）
 */
export function successRates({ limit = 5000 } = {}) {
  const scope = `(SELECT * FROM request_log ORDER BY id DESC LIMIT ?)`;

  const byModel = all(`
    SELECT COALESCE(public_model, model, '(未知)') AS model,
           COUNT(*) AS req,
           SUM(CASE WHEN status >= 200 AND status < 300 THEN 1 ELSE 0 END) AS ok,
           CAST(AVG(CASE WHEN status >= 200 AND status < 300 THEN latency_ms END) AS INTEGER) AS avg_ok_latency,
           MAX(ts) AS last_ts
    FROM ${scope}
    GROUP BY COALESCE(public_model, model, '(未知)')
    ORDER BY req DESC
  `, limit);

  const byKey = all(`
    SELECT l.key_uuid, k.name AS key_name, c.name AS channel, c.display_name AS channel_display,
           COUNT(*) AS req,
           SUM(CASE WHEN l.status >= 200 AND l.status < 300 THEN 1 ELSE 0 END) AS ok,
           MAX(l.ts) AS last_ts
    FROM ${scope} l
    LEFT JOIN channel_key k ON k.uuid = l.key_uuid
    LEFT JOIN channel c ON c.id = k.channel_id
    WHERE l.key_uuid IS NOT NULL
    GROUP BY l.key_uuid
    ORDER BY req DESC
  `, limit);

  const byChannel = all(`
    SELECT l.channel_id, c.name AS channel, c.display_name AS channel_display,
           COUNT(*) AS req,
           SUM(CASE WHEN l.status >= 200 AND status < 300 THEN 1 ELSE 0 END) AS ok,
           CAST(AVG(CASE WHEN l.status >= 200 AND status < 300 THEN l.latency_ms END) AS INTEGER) AS avg_ok_latency,
           MAX(l.ts) AS last_ts
    FROM ${scope} l
    LEFT JOIN channel c ON c.id = l.channel_id
    WHERE l.channel_id IS NOT NULL
    GROUP BY l.channel_id
    ORDER BY req DESC
  `, limit);

  const shape = (rows, key) => rows.map((r) => {
    const req = r.req ?? 0;
    const ok = r.ok ?? 0;
    return {
      ...r,
      ok,
      fail: req - ok,
      rate: req > 0 ? ok / req : null,
      ratePct: req > 0 ? +(ok / req * 100).toFixed(1) : null,
      avgOkLatency: r.avg_ok_latency ?? null,
    };
  });

  return {
    sampleLimit: limit,
    byModel: shape(byModel, 'model'),
    byKey: shape(byKey, 'key_uuid'),
    byChannel: shape(byChannel, 'channel_id'),
  };
}

/**
 * ⭐ 「模型 × 渠道」的成功率 —— 用于找出**特定渠道的特定模型**总是失败。
 *
 * 这是用户真正想要的：不是"这个模型不行"，而是"这个模型**在商汤**不行"。
 * 结合 `model_health` 的熔断状态，就能回答"哪些是被我熔断的、哪些是真的差"。
 */
export function modelChannelRates({ limit = 5000 } = {}) {
  return all(`
    SELECT COALESCE(l.model, '(未知)') AS upstream_model,
           l.channel_id,
           c.name AS channel, c.display_name AS channel_display,
           COUNT(*) AS req,
           SUM(CASE WHEN l.status >= 200 AND l.status < 300 THEN 1 ELSE 0 END) AS ok,
           -- 各错误分类的计数，用来识别"这个模型是不是就是爱 429"
           SUM(CASE WHEN l.err_class = 'quota' THEN 1 ELSE 0 END) AS quota_fail,
           SUM(CASE WHEN l.err_class = 'auth' THEN 1 ELSE 0 END) AS auth_fail,
           SUM(CASE WHEN l.err_class = 'transient' THEN 1 ELSE 0 END) AS transient_fail,
           SUM(CASE WHEN l.err_class = 'config_fault' THEN 1 ELSE 0 END) AS config_fault_fail,
           MAX(l.ts) AS last_ts
    FROM (SELECT * FROM request_log ORDER BY id DESC LIMIT ?) l
    LEFT JOIN channel c ON c.id = l.channel_id
    WHERE l.model IS NOT NULL AND l.model <> '__probe__'
    GROUP BY l.model, l.channel_id
    HAVING req > 0
    ORDER BY req DESC
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

export default {
  logRequest, recentLogs, statsByChannel, errClassDistribution,
  successRates, modelChannelRates, pruneLogs, clearLogs,
};
