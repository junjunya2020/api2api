/**
 * 后台任务（用户 2026-10-08）。
 *
 * 需求原话：
 *   「测试模型可用性……可以挂后台」「有后台任务管理」
 *   「测试指纹……也是在后台测试，但是前台只是实时看到，**关闭浏览器不影响进度**」
 *
 * 因此：任务状态**落库**（不是内存），进程重启后仍可查；前端轮询 `/api/jobs/:id`
 * 看进度，关浏览器只是停止轮询，后台照跑。
 *
 * 两类任务（`kind`）：
 *   · probe       测模型可用性（渠道 × 模型，在**该渠道所有 Key** 上各打一次）
 *   · fingerprint 测模型指纹（调 vendor/lm-detector 的 fpd CLI）
 */
import { all, one, run, tx } from './index.mjs';
import { uuid } from '../util/crypto.mjs';

export const JobStatus = {
  QUEUED: 'queued',
  RUNNING: 'running',
  DONE: 'done',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

export const JobKind = {
  PROBE: 'probe',
  FINGERPRINT: 'fingerprint',
};

function parse(s, dflt = null) {
  if (!s) return dflt;
  try { return JSON.parse(s); } catch { return dflt; }
}

export function shape(r) {
  if (!r) return null;
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    spec: parse(r.spec, {}),
    status: r.status,
    total: r.total,
    done: r.done,
    okCount: r.ok_count,
    failCount: r.fail_count,
    progress: parse(r.progress, { steps: [] }),
    result: parse(r.result, null),
    error: r.error,
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

/** 建任务（返回完整记录）。spec 是任意 JSON。 */
export function createJob({ kind, title = null, spec = {}, total = 0 }) {
  const id = uuid();
  const now = Date.now();
  run(`INSERT INTO job (id, kind, title, spec, status, total, done, ok_count, fail_count, progress, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?)`,
  id, kind, title, JSON.stringify(spec), JobStatus.QUEUED, Math.max(0, Math.trunc(total)),
  JSON.stringify({ steps: [] }), now);
  return getJob(id);
}

export function getJob(id) {
  return shape(one('SELECT * FROM job WHERE id = ?', id));
}

export function listJobs({ limit = 50, kind = null, status = null } = {}) {
  const where = [];
  const params = [];
  if (kind) { where.push('kind = ?'); params.push(kind); }
  if (status) { where.push('status = ?'); params.push(status); }
  let sql = 'SELECT * FROM job';
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(Math.min(Math.max(Number(limit) || 50, 1), 500));
  return all(sql, ...params).map(shape);
}

/** 启动时把"卡在 running 的历史任务"标成失败（进程重启导致它们已经死了） */
export function failOrphanJobs() {
  const n = run(`UPDATE job SET status = ?, error = COALESCE(error, '进程重启，任务中断'),
                          finished_at = ? WHERE status IN (?, ?)`,
  JobStatus.FAILED, Date.now(), JobStatus.QUEUED, JobStatus.RUNNING).changes;
  return n;
}

/**
 * 通用的"任务执行器"：负责状态落库 + 节流写进度。
 * spec.run 由 runJob 注入（见 src/jobs/runner.mjs）。
 */
export function patchJob(id, patch = {}) {
  const sets = [];
  const params = [];
  const map = {
    status: 'status', total: 'total', done: 'done',
    okCount: 'ok_count', failCount: 'fail_count', error: 'error',
    startedAt: 'started_at', finishedAt: 'finished_at', title: 'title',
  };
  for (const [k, col] of Object.entries(map)) {
    if (patch[k] !== undefined) { sets.push(`${col} = ?`); params.push(patch[k]); }
  }
  if (patch.progress !== undefined) { sets.push('progress = ?'); params.push(JSON.stringify(patch.progress)); }
  if (patch.result !== undefined) { sets.push('result = ?'); params.push(JSON.stringify(patch.result)); }
  if (!sets.length) return;
  params.push(id);
  run(`UPDATE job SET ${sets.join(', ')} WHERE id = ?`, ...params);
}

/** 进度写入器：合并 steps，并按 minIntervalMs 节流（避免高频写爆 SQLite） */
export function makeProgressWriter(id, { minIntervalMs = 400, initialTotal = 0 } = {}) {
  let steps = [];
  let total = initialTotal;
  let done = 0;
  let ok = 0;
  let fail = 0;
  let lastFlush = 0;
  let dirty = false;

  const flush = (force = false) => {
    const now = Date.now();
    if (!force && !dirty) return;
    if (!force && now - lastFlush < minIntervalMs) return;
    lastFlush = now;
    dirty = false;
    patchJob(id, { progress: { steps }, total, done, okCount: ok, failCount: fail });
  };

  return {
    setTotal(n) { total = n; dirty = true; flush(true); },
    setSteps(next) { steps = next; dirty = true; flush(true); },
    /**
     * 标记某一步的状态。
     * @param {number} i 步骤下标（超出自动补齐）
     * @param {{state:'pending'|'running'|'ok'|'fail'|'skip', detail?:string, ms?:number, extra?:object}} s
     */
    step(i, s) {
      while (steps.length <= i) steps.push({ label: steps.length ? `步骤 ${steps.length + 1}` : '', state: 'pending' });
      steps[i] = { ...steps[i], ...s, at: Date.now() };
      dirty = true;
      flush(s.state === 'ok' || s.state === 'fail');
    },
    bump({ doneDelta = 0, okDelta = 0, failDelta = 0 } = {}) {
      done += doneDelta; ok += okDelta; fail += failDelta;
      dirty = true;
      flush();
    },
    flush,
    snapshot: () => ({ steps, total, done, ok, fail }),
  };
}

export default {
  JobStatus, JobKind, createJob, getJob, listJobs, patchJob,
  makeProgressWriter, failOrphanJobs, shape,
};
