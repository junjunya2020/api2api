/**
 * 管理 API · 后台任务（用户 2026-10-08）。
 *
 *   GET    /api/jobs              列任务（?kind= &status= &limit=）
 *   GET    /api/jobs/:id          单任务（含实时进度 / 结果）—— 前端轮询这个
 *   POST   /api/jobs/probe        建「测模型可用性」任务 {channel, model, timeoutMs?, gapMs?}
 *   POST   /api/jobs/fingerprint  建「测模型指纹」任务 {model, api?, repeat?, timeoutSec?}
 *   POST   /api/jobs/:id/cancel   取消
 *   DELETE /api/jobs/:id          删除（终态才可删）
 *   GET    /api/detector/status   指纹检测器（lm-detector）是否就绪
 *
 * 可用性测试**同步版**（黑名单页上的「测试可用性」按钮用，快、不用等后台）：
 *   POST   /api/probe/model       {channel, model, timeoutMs?, gapMs?} → 直接返回结果
 */
import * as jobsDb from '../db/jobs.mjs';
import { JobKind } from '../db/jobs.mjs';
import { enqueueJob, cancelJob, isRunning } from '../jobs/runner.mjs';
import * as fp from '../jobs/fingerprint.mjs';
import { probeModelAvailability } from '../jobs/probe.mjs';
import { getChannel } from '../db/channels.mjs';
import { readJson, sendJson, matchPath, HttpError } from './util.mjs';

export async function handleJobs(req, res, url) {
  const { pathname } = url;
  const method = req.method;

  // ---- 指纹检测器状态 ----
  if (pathname === '/api/detector/status' && method === 'GET') {
    return sendJson(res, 200, {
      ready: fp.detectorReady(),
      dir: fp.detectorDir(),
    });
  }

  // ---- 列表 ----
  if (pathname === '/api/jobs' && method === 'GET') {
    const jobs = jobsDb.listJobs({
      limit: url.searchParams.get('limit') || 50,
      kind: url.searchParams.get('kind') || null,
      status: url.searchParams.get('status') || null,
    }).map((j) => ({ ...j, running: isRunning(j.id) }));
    return sendJson(res, 200, { jobs });
  }

  // ---- 建任务：可用性 ----
  if (pathname === '/api/jobs/probe' && method === 'POST') {
    const body = await readJson(req);
    const chRef = body?.channel;
    const model = String(body?.model ?? '').trim();
    if (!chRef) throw new HttpError(400, '需要 channel');
    if (!model) throw new HttpError(400, '需要 model');
    const ch = getChannel(chRef);
    if (!ch) throw new HttpError(404, `渠道不存在: ${chRef}`);
    const job = enqueueJob({
      kind: JobKind.PROBE,
      title: `测可用性：${ch.display_name} / ${model}`,
      spec: {
        channel: ch.name, model,
        timeoutMs: body?.timeoutMs ?? null,
        gapMs: body?.gapMs ?? null,
      },
      total: 0,
    });
    return sendJson(res, 202, { ok: true, job });
  }

  // ---- 建任务：指纹 ----
  if (pathname === '/api/jobs/fingerprint' && method === 'POST') {
    const body = await readJson(req);
    const model = String(body?.model ?? '').trim();
    if (!model) throw new HttpError(400, '需要 model');
    if (!fp.detectorReady()) {
      throw new HttpError(503, `指纹检测器（lm-detector）未就绪：${fp.detectorDir()}/cli/fpd.ts 不存在`);
    }
    const job = enqueueJob({
      kind: JobKind.FINGERPRINT,
      title: `测指纹：${model}`,
      spec: {
        model,
        api: body?.api || 'cc',
        repeat: body?.repeat ?? 1,
        timeoutSec: body?.timeoutSec ?? 120,
      },
      total: 1,
    });
    return sendJson(res, 202, { ok: true, job });
  }

  // ---- 同步版可用性（黑名单页的即时按钮）----
  if (pathname === '/api/probe/model' && method === 'POST') {
    const body = await readJson(req);
    if (!body?.channel) throw new HttpError(400, '需要 channel');
    if (!body?.model) throw new HttpError(400, '需要 model');
    try {
      const out = await probeModelAvailability({
        channel: body.channel,
        model: body.model,
        timeoutMs: body?.timeoutMs ?? undefined,
        gapMs: body?.gapMs ?? undefined,
        autoBan: body?.autoBan ?? null,
      });
      return sendJson(res, 200, { ok: true, ...out });
    } catch (e) {
      throw new HttpError(e.status ?? 500, e.message);
    }
  }

  // ---- 单任务 / 取消 / 删除 ----
  // ⚠️ 先匹配带 `/cancel` 的两段式，再匹配 `/:id`（否则 `:id` 只吃一段、不会吞 cancel，
  //    但把 cancel 放前面读起来更清楚）。
  const pc = matchPath('/api/jobs/:id/cancel', pathname);
  if (pc && method === 'POST') {
    const ok = cancelJob(pc.id);
    const job = jobsDb.getJob(pc.id);
    if (!job) throw new HttpError(404, `任务不存在: ${pc.id}`);
    return sendJson(res, 200, { ok, job, running: isRunning(pc.id) });
  }

  const p = matchPath('/api/jobs/:id', pathname);
  if (p) {
    const id = p.id;
    if (method === 'GET') {
      const job = jobsDb.getJob(id);
      if (!job) throw new HttpError(404, `任务不存在: ${id}`);
      return sendJson(res, 200, { job: { ...job, running: isRunning(id) } });
    }
    if (method === 'DELETE') {
      const job = jobsDb.getJob(id);
      if (!job) throw new HttpError(404, `任务不存在: ${id}`);
      if (isRunning(id)) throw new HttpError(409, '任务正在运行，先取消再删除');
      const { run } = await import('../db/index.mjs');
      run('DELETE FROM job WHERE id = ?', id);
      return sendJson(res, 200, { ok: true, deleted: true });
    }
  }

  return false;
}

export default { handleJobs };
