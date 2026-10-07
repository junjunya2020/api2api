/**
 * 管理 API · 模型健康度 + 成功率。
 *
 * ⭐ 为什么单独一个模块（2026-10-07 用户要求）：
 *   「分多级才行，不然全池子死了：正常 → 降级 → 不可用」
 *   「ban 的话只 ban 模型，不 ban key」
 *   「统计一下成功率」
 *
 *   Key 列表回答的是"哪把 Key 不能用"，但真正会烧穿池子的是**坏模型**。
 *   所以必须有一页专门看"哪些模型被我熔断了、为什么"。
 *
 *   GET    /api/model-health            列模型健康度（可按 channel / state 过滤）
 *   GET    /api/model-health/summary    按渠道汇总（降级/不可用各几个）
 *   POST   /api/model-health/reset      重置（channel + model，或整渠道）
 *   GET    /api/model-rules             内置问题模型规则（看看都预置了什么）
 *   GET    /api/stats/rates             成功率（按模型 / Key / 渠道）
 *   GET    /api/stats/rates/model       成功率（模型 × 渠道，含错误分类分解）
 */
import * as mh from '../db/model-health.mjs';
import * as logs from '../db/logs.mjs';
import { listRules } from '../db/model-rules.mjs';
import { readJson, sendJson, HttpError } from './util.mjs';
import config from '../config.mjs';

export async function handleModelHealth(req, res, url) {
  const { pathname } = url;
  const method = req.method;

  // ---- 模型健康度明细 ----
  if (pathname === '/api/model-health' && method === 'GET') {
    const rows = mh.listModelHealth({ channel: url.searchParams.get('channel') });
    const stateFilter = url.searchParams.get('state');
    const filtered = stateFilter ? rows.filter((r) => r.state === stateFilter) : rows;
    return sendJson(res, 200, {
      models: filtered,
      summary: mh.modelHealthSummary(),
      /** 熔断规则，便于页面直接说明"连续失败几次会降级/停用" */
      rules: {
        degradeAfterFails: config.modelDegradeAfterFails,
        unavailableAfterFails: config.modelUnavailableAfterFails,
        recoverMs: config.modelDisabledRecoverMs,
        channelCircuitFraction: config.channelCircuitFraction,
        builtinRulesEnabled: !!config.builtinModelRules,
      },
    });
  }

  if (pathname === '/api/model-health/summary' && method === 'GET') {
    return sendJson(res, 200, { summary: mh.modelHealthSummary() });
  }

  // ---- 内置规则（只读展示：用户能确认"预置了什么判断"）----
  if (pathname === '/api/model-rules' && method === 'GET') {
    return sendJson(res, 200, listRules(config));
  }

  // ---- 重置：手动放行一个被熔断的模型（运维用）----
  if (pathname === '/api/model-health/reset' && method === 'POST') {
    const body = await readJson(req).catch(() => ({}));
    const channel = body?.channel;
    const model = body?.model ?? null;
    if (!channel) throw new HttpError(400, '需要 channel 参数');
    const n = mh.resetModelHealth(channel, model);
    return sendJson(res, 200, { ok: true, resetRows: n, channel, model });
  }

  // ---- 成功率 ----
  if (pathname === '/api/stats/rates' && method === 'GET') {
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 5000, 100), 50000);
    return sendJson(res, 200, {
      ...logs.successRates({ limit }),
      /** 口径说明随数据一起下发 —— 前端不用猜 */
      scope: 'request_log：一次下游请求最终是否成功（不是每次上游尝试）',
    });
  }

  if (pathname === '/api/stats/rates/model' && method === 'GET') {
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 5000, 100), 50000);
    const rows = logs.modelChannelRates({ limit }).map((r) => {
      const req = r.req ?? 0;
      const ok = r.ok ?? 0;
      return {
        upstreamModel: r.upstream_model,
        channel: r.channel,
        channelDisplay: r.channel_display,
        req,
        ok,
        fail: req - ok,
        ratePct: req > 0 ? +(ok / req * 100).toFixed(1) : null,
        /** 错误分类分解 —— 用户最关心的"它是不是就是爱 429"看这里 */
        quotaFail: r.quota_fail ?? 0,
        authFail: r.auth_fail ?? 0,
        transientFail: r.transient_fail ?? 0,
        configFaultFail: r.config_fault_fail ?? 0,
        lastTs: r.last_ts,
      };
    });
    // 顺带带上这些模型的当前熔断状态，一眼看出"是它真差、还是被我熔断了"
    const health = new Map(
      mh.listModelHealth().map((h) => [`${h.channel}::${h.model}`, h]),
    );
    for (const r of rows) {
      const h = health.get(`${r.channel}::${r.upstreamModel}`);
      r.healthState = h?.state ?? 'NORMAL';
      r.healthReason = h?.reason ?? null;
    }
    return sendJson(res, 200, { limit, models: rows });
  }

  return false;
}

export default { handleModelHealth };
