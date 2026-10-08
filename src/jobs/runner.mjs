/**
 * 后台任务引擎（用户 2026-10-08）。
 *
 * 一个进程内的**串行队列**：同一时刻只跑一个任务（可用性测试会打很多上游请求，
 * 指纹测试要跑子进程 —— 并发只会互相干扰、把上游打成 429）。
 * 任务状态落库（`job` 表），所以：
 *   · 关浏览器 → 只是停止轮询，后台照跑
 *   · 进程重启 → `failOrphanJobs()` 把卡住的标成失败，不会假装"还在跑"
 *
 * 取消：`cancelJob(id)` 置一个内存标记，跑动的任务在每次迭代里查它。
 */
import * as jobsDb from '../db/jobs.mjs';
import { JobKind, JobStatus } from '../db/jobs.mjs';
import * as probe from './probe.mjs';
import * as fp from './fingerprint.mjs';
import { getChannel } from '../db/channels.mjs';
import { listKeys } from '../db/keys.mjs';
import config from '../config.mjs';
import log from '../util/log.mjs';

/** 内存里的取消标记（进程内有效；重启后任务本来就被标失败了） */
const cancelled = new Set();
const running = new Set();

let draining = false;

/** 入队：建库记录 + 触发 drain（后台异步跑，不阻塞 HTTP 响应） */
export function enqueueJob({ kind, title, spec, total = 0 }) {
  const job = jobsDb.createJob({ kind, title, spec, total });
  // 不 await —— 立刻返回给前端 jobId，前端去轮询进度
  setImmediate(() => drain().catch((e) => log.error('[jobs] drain 异常:', e?.stack ?? e)));
  return job;
}

export function cancelJob(id) {
  const j = jobsDb.getJob(id);
  if (!j) return false;
  if (j.status === JobStatus.QUEUED || j.status === JobStatus.RUNNING) {
    cancelled.add(id);
    // 排队中的直接标取消（跑动中的由 runJob 自己收尾）
    if (j.status === JobStatus.QUEUED) {
      jobsDb.patchJob(id, { status: JobStatus.CANCELLED, finishedAt: Date.now() });
    }
    return true;
  }
  return false;
}

export function isRunning(id) { return running.has(id); }

/** 串行消费队列 */
async function drain() {
  if (draining) return;
  draining = true;
  try {
    for (;;) {
      const next = jobsDb.listJobs({ limit: 1, status: JobStatus.QUEUED })[0];
      if (!next) break;
      if (cancelled.has(next.id)) { cancelled.delete(next.id); continue; }
      await runJob(next);
    }
  } finally {
    draining = false;
  }
}

async function runJob(job) {
  running.add(job.id);
  jobsDb.patchJob(job.id, { status: JobStatus.RUNNING, startedAt: Date.now() });
  const isCancelled = () => cancelled.has(job.id);
  try {
    if (job.kind === JobKind.PROBE) {
      await runProbeJob(job, isCancelled);
    } else if (job.kind === JobKind.FINGERPRINT) {
      await runFingerprintJob(job, isCancelled);
    } else {
      throw new Error(`未知任务类型: ${job.kind}`);
    }
    if (isCancelled()) {
      jobsDb.patchJob(job.id, { status: JobStatus.CANCELLED, finishedAt: Date.now() });
    } else {
      jobsDb.patchJob(job.id, { status: JobStatus.DONE, finishedAt: Date.now() });
    }
  } catch (e) {
    const cancelledNow = isCancelled();
    jobsDb.patchJob(job.id, {
      status: cancelledNow ? JobStatus.CANCELLED : JobStatus.FAILED,
      error: cancelledNow ? '已取消' : (e.message || String(e)),
      finishedAt: Date.now(),
    });
    if (!cancelledNow) log.warn(`[jobs] ${job.kind} 任务 ${job.id} 失败: ${e.message}`);
  } finally {
    running.delete(job.id);
    cancelled.delete(job.id);
  }
}

/* ------------------------------------------------------------ 可用性 */

async function runProbeJob(job, isCancelled) {
  const spec = job.spec || {};
  // 支持两种形态：
  //   {channel, model}                    单目标（黑名单条目用）
  //   {targets:[{channel,model}, ...]}    多目标（模型页"点一下全测"用）
  const targets = Array.isArray(spec.targets) && spec.targets.length
    ? spec.targets
    : [{ channel: spec.channel, model: spec.model }];

  const timeoutMs = Math.max(1000, Number(spec.timeoutMs) || config.probeModelTimeoutMs);
  const gapMs = Math.max(0, Number(spec.gapMs) ?? 1200);

  // 先把所有目标的 Key 摊平，算出总步数（进度条才有意义）
  const plan = targets.map((t) => {
    const ch = getChannel(t.channel);
    if (!ch) throw new Error(`渠道不存在: ${t.channel}`);
    const model = String(t.model || '').trim();
    if (!model) throw new Error('model 必填');
    return { ch, model, keys: listKeys({ channel: ch.id, enabledOnly: true }) };
  }).filter((p) => p.keys.length);
  if (!plan.length) throw new Error('没有可测的 (渠道,模型) 目标（渠道下没有启用的 Key）');

  const totalKeys = plan.reduce((n, p) => n + p.keys.length, 0);
  jobsDb.patchJob(job.id, { total: totalKeys });

  const steps = [];
  const indexOf = new Map();   // `${channel}::${model}::${keyUuid}` → step index
  for (const p of plan) {
    for (const k of p.keys) {
      indexOf.set(`${p.ch.name}::${p.model}::${k.uuid}`, steps.length);
      steps.push({ label: `${p.ch.display_name} · ${k.name || k.uuid}`, state: 'pending' });
    }
  }
  const writer = jobsDb.makeProgressWriter(job.id, { initialTotal: totalKeys });
  writer.setTotal(totalKeys);
  writer.setSteps(steps);

  const perTarget = [];
  for (const p of plan) {
    if (isCancelled()) break;
    const out = await probe.probeModelAvailability({
      channel: p.ch.name,
      model: p.model,
      timeoutMs,
      gapMs,
      cancel: isCancelled,
      onKey: (info) => {
        const idx = indexOf.get(`${p.ch.name}::${p.model}::${info.key}`);
        if (idx !== undefined) {
          steps[idx] = {
            label: `${p.ch.display_name} · ${info.keyName || info.key} · ${p.model}`,
            state: info.state === 'ok' ? 'ok' : (info.state === 'skip' ? 'skip' : 'fail'),
            detail: info.state === 'ok'
              ? `HTTP ${info.httpStatus} · ${info.ms}ms`
              : `${info.message} · ${info.ms}ms`,
            ms: info.ms,
          };
          writer.setSteps(steps);
        }
        writer.bump({
          doneDelta: 1,
          okDelta: info.state === 'ok' ? 1 : 0,
          failDelta: info.state === 'fail' ? 1 : 0,
        });
      },
    });
    perTarget.push({
      channel: p.ch.name, channelDisplay: p.ch.display_name, model: p.model,
      total: out.total, okCount: out.okCount, failCount: out.failCount,
      allFailed: out.allFailed, banned: out.banned,
      results: out.results.map((r) => ({
        key: r.key, keyName: r.keyName, state: r.state, httpStatus: r.httpStatus ?? null,
        ms: r.ms ?? null, errClass: r.errClass ?? null, message: r.message ?? null,
      })),
    });
  }

  writer.setSteps(steps);
  writer.flush(true);
  const okCount = perTarget.reduce((n, t) => n + t.okCount, 0);
  const failCount = perTarget.reduce((n, t) => n + t.failCount, 0);
  const banned = perTarget.filter((t) => t.banned).map((t) => ({ channel: t.channel, model: t.model }));

  // 单目标时保持扁平结构（前端/黑名单页按单目标渲染），多目标时给 targets[]
  const result = perTarget.length === 1
    ? { ...perTarget[0] }
    : {
      multi: true, targets: perTarget, okCount, failCount,
      allFailed: perTarget.every((t) => t.allFailed), banned,
    };
  jobsDb.patchJob(job.id, { result, okCount, failCount });
}

/* ------------------------------------------------------------ 指纹 */

async function runFingerprintJob(job, isCancelled) {
  const spec = job.spec || {};
  const model = String(spec.model || '').trim();
  if (!model) throw new Error('spec.model 必填');

  const steps = [
    { label: `指纹请求：${model}`, state: 'running' },
  ];
  const writer = jobsDb.makeProgressWriter(job.id, { initialTotal: 1 });
  writer.setTotal(1);
  writer.setSteps(steps);

  const started = Date.now();
  const res = await fp.fingerprintModel({
    model,
    api: spec.api || 'cc',
    repeat: Math.min(Math.max(Number(spec.repeat) || 1, 1), 3),
    timeoutSec: Math.max(5, Number(spec.timeoutSec) || 120),
    cancel: isCancelled,
    onProgress: (p) => {
      steps[0] = {
        label: `指纹请求：${model}`,
        state: 'running',
        detail: p.rounds ? `已收集 ${p.rounds} 轮输出…` : `接收中（${Math.round((p.bytes || 0) / 1024)} KB）`,
      };
      writer.setSteps(steps);
    },
  });

  steps[0] = {
    label: `指纹请求：${model}`,
    state: res.ok ? 'ok' : 'fail',
    detail: res.ok
      ? `判定 ${res.prediction?.name || res.prediction?.id}（${fmtPct(res.prediction?.probability)}）`
      : (res.error || '失败'),
    ms: res.ms,
  };
  writer.setSteps(steps);
  writer.bump({ doneDelta: 1, okDelta: res.ok ? 1 : 0, failDelta: res.ok ? 0 : 1 });
  writer.flush(true);

  jobsDb.patchJob(job.id, {
    okCount: res.ok ? 1 : 0,
    failCount: res.ok ? 0 : 1,
    result: res.ok
      ? {
        model, format: res.format, prediction: res.prediction,
        ranking: res.ranking, rounds: res.rounds, bank: res.bank, ms: res.ms,
      }
      : { model, error: res.error, ms: res.ms },
    error: res.ok ? null : (res.error || '指纹检测失败'),
  });
}

function fmtPct(p) {
  if (p === null || p === undefined || !Number.isFinite(p)) return '置信度未知';
  return `${(p * 100).toFixed(1)}%`;
}

export default { enqueueJob, cancelJob, isRunning };
