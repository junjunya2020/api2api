/**
 * 视图：后台任务（「模型黑名单」页与「指纹测试」页共用的实时进度组件）。
 *
 * 用户要求（2026-10-08）：
 *   「可以挂后台 然后 还有一个 后台任务管理」
 *   「测试指纹……是在后台测试，但是前台只是实时看到，**关闭浏览器不影响进度**」
 *
 * 实现：任务状态在**服务端**（DB），前端只是 `setInterval` 拉 `/api/jobs/:id`。
 * 关掉浏览器 = 停止轮询；服务端的任务照跑，回来再看还在。
 */
import api from './api.js';
import { $, el, fmtAgo, fmtMs, toast, confirmDialog, openModal, closeModal } from './ui.js';

const KIND_LABEL = { probe: '测可用性', fingerprint: '测指纹' };
const STATUS_META = {
  queued: { label: '排队中', cls: 'pill-idle' },
  running: { label: '进行中', cls: 'pill-warn' },
  done: { label: '已完成', cls: 'pill-ok' },
  failed: { label: '失败', cls: 'pill-err' },
  cancelled: { label: '已取消', cls: 'pill-idle' },
};

export function statusPill(status) {
  const m = STATUS_META[status] || { label: status, cls: 'pill-idle' };
  return el('span', { class: `pill ${m.cls}`, text: m.label });
}

const STEP_CLS = {
  pending: 'muted', running: 'pill-warn', ok: 'pill-ok', fail: 'pill-err', skip: 'muted',
};

/** 挂载「后台任务管理」面板（黑名单页 / 指纹页都用） */
export function initJobsPanel({ hostId, kind = null, onJobClick = null }) {
  const host = $(`#${hostId}`);
  if (!host) return { refresh: async () => {} };

  async function refresh() {
    try {
      const r = await api.jobs({ kind: kind || undefined, limit: 60 });
      renderJobsInto(host, r.jobs || [], { onJobClick });
    } catch (e) {
      host.replaceChildren(el('div', { class: 'muted', text: `读取任务失败：${e.message}` }));
    }
  }
  return { refresh };
}

/** 把任务列表渲染进任意容器（多页共用） */
export function renderJobsInto(host, jobs, { onJobClick } = {}) {
  if (!host) return;
  if (!jobs.length) {
    host.replaceChildren(el('div', { class: 'muted', style: 'font-size:12.5px', text: '暂无任务。' }));
    return;
  }
  const table = el('table', { class: 'table' }, [
    el('thead', {}, [el('tr', {}, [
      el('th', { text: '类型' }), el('th', { text: '任务' }), el('th', { text: '状态' }),
      el('th', { text: '进度' }), el('th', { text: '结果' }), el('th', { text: '时间' }),
      el('th', { class: 'col-actions', text: '操作' }),
    ])]),
    el('tbody', {}, jobs.map((j) => jobRow(j, { onJobClick }))),
  ]);
  host.replaceChildren(el('div', { class: 'table-wrap' }, [table]));
}

function renderJobs(host, jobs, opts) { renderJobsInto(host, jobs, opts); }

function jobRow(j, { onJobClick }) {
  const meta = STATUS_META[j.status] || { label: j.status, cls: 'pill-idle' };
  const pct = j.total ? Math.round((j.done / j.total) * 100) : (j.status === 'done' ? 100 : 0);
  const summary = resultSummary(j);

  const actions = [];
  if (j.status === 'queued' || j.status === 'running') {
    actions.push(el('button', {
      class: 'btn btn-sm btn-danger', type: 'button', text: '取消',
      onclick: () => cancel(j),
    }));
  } else {
    actions.push(el('button', {
      class: 'btn btn-sm btn-danger', type: 'button', text: '删除',
      onclick: () => removeJob(j),
    }));
  }
  if (onJobClick) {
    actions.unshift(el('button', {
      class: 'btn btn-sm', type: 'button', text: '详情',
      onclick: () => onJobClick(j),
    }));
  }

  return el('tr', {}, [
    el('td', {}, [el('span', { class: 'pill pill-accent', text: KIND_LABEL[j.kind] || j.kind })]),
    el('td', { style: 'max-width:300px', text: j.title || '—' }),
    el('td', {}, [el('span', { class: `pill ${meta.cls}`, text: meta.label })]),
    el('td', { style: 'min-width:120px' }, [
      el('div', { class: 'muted', style: 'font-size:12px;margin-bottom:3px', text: `${j.done}/${j.total || '?'}${j.status === 'running' ? ` · ${pct}%` : ''}` }),
      el('div', {
        style: 'height:4px;background:var(--border,rgba(0,0,0,.08));border-radius:2px;overflow:hidden',
      }, [el('div', {
        style: `height:100%;width:${pct}%;background:${j.status === 'failed' ? 'var(--err)' : j.status === 'done' ? 'var(--ok)' : 'var(--accent)'}`,
      })]),
    ]),
    el('td', { style: 'font-size:12px;max-width:260px', text: summary }),
    el('td', { class: 'muted', style: 'font-size:12px;white-space:nowrap', text: fmtAgo(j.createdAt) }),
    el('td', { class: 'col-actions' }, actions),
  ]);
}

function resultSummary(j) {
  if (j.error) return `⚠ ${j.error}`;
  const r = j.result;
  if (!r) return '—';
  if (j.kind === 'probe') {
    return `${r.okCount}/${r.total} 个 Key 成功` + (r.banned ? ' · 已自动拉黑' : '');
  }
  if (j.kind === 'fingerprint') {
    if (r.prediction) return `判定：${r.prediction.name || r.prediction.id}`;
    return r.error || '—';
  }
  return '—';
}

async function cancel(j) {
  try {
    await api.cancelJob(j.id);
    toast('已请求取消', 'ok');
    // 触发一次刷新（具体由所在视图的 poller 负责）
    window.dispatchEvent(new CustomEvent('a2a:jobs-changed'));
  } catch (e) { toast(e.message, 'err'); }
}

async function removeJob(j) {
  const ok = await confirmDialog('删除任务', `确认删除任务「${j.title || j.id}」？`);
  if (!ok) return;
  try {
    await api.deleteJob(j.id);
    toast('已删除', 'ok');
    window.dispatchEvent(new CustomEvent('a2a:jobs-changed'));
  } catch (e) { toast(e.message, 'err'); }
}

/* -------------------------------------------------- 实时进度（可多路） */

/**
 * 轮询表：`jobId → {timer, host}`。
 * ⚠️ 必须支持**多路** —— 进度模态框、后台任务页、指纹页可能同时在看任务。
 *    早期单例实现会出现"打开 B 就把 A 的轮询停掉"。
 */
const watchers = new Map();

/** 在一个容器里实时渲染某个任务的进度（自动轮询）@returns {Function} 停止函数 */
export function watchJob(jobId, host, { onDone = null, onTick = null } = {}) {
  stopWatch(jobId);
  const rec = { host, timer: null, stopped: false };
  watchers.set(jobId, rec);

  const tick = async () => {
    if (rec.stopped) return;
    try {
      const { job } = await api.job(jobId);
      if (rec.stopped) return;
      renderJobDetail(host, job);
      if (onTick) onTick(job);
      if (job.status === 'running' || job.status === 'queued') {
        rec.timer = setTimeout(tick, 1200);
      } else {
        rec.timer = null;
        if (onDone) onDone(job);
      }
    } catch (e) {
      if (rec.stopped) return;
      host.replaceChildren(el('div', { class: 'muted', text: `读取任务失败：${e.message}` }));
      rec.timer = setTimeout(tick, 2500);
    }
  };
  tick();

  return () => stopWatch(jobId);
}

/** 停止某任务的轮询；不传 id 则停全部 */
export function stopWatch(jobId = undefined) {
  const stop = (id) => {
    const rec = watchers.get(id);
    if (!rec) return;
    rec.stopped = true;
    if (rec.timer) clearTimeout(rec.timer);
    watchers.delete(id);
  };
  if (jobId === undefined) { for (const id of [...watchers.keys()]) stop(id); return; }
  stop(jobId);
}

/**
 * ⭐ 打开一个**实时进度模态框**（用户 2026-10-08 要求）：
 *   「点击测试可用性应该马上开始测试啊 模态框实时显示进度 …… 关闭后仍然在后台测试」
 *
 * 关闭模态框只停轮询 —— 任务本身在服务端照跑，可去「后台任务管理」继续看。
 */
export function openJobModal({ title, jobId, onClose = null }) {
  const host = el('div');
  const hint = el('div', {
    class: 'field-hint',
    style: 'margin-top:12px',
    text: '关闭这个窗口不影响测试 —— 任务继续在服务端跑，可随时到「任务管理」查看。',
  });
  const p = openModal({
    title,
    bodyNode: [host, hint],
    okText: '收起',
    cancelText: '关闭',
    onOk: () => { /* 只是收起 */ },
  });
  watchJob(jobId, host);
  // 模态框关闭 → 停轮询（任务继续）
  p.then(() => { stopWatch(jobId); if (onClose) onClose(); });
  return () => { stopWatch(jobId); closeModal(true); };
}

/** 渲染任务详情：进度条 + 每个步骤的状态 + 最终结果 */
export function renderJobDetail(host, job) {
  if (!host) return;
  const meta = STATUS_META[job.status] || { label: job.status, cls: 'pill-idle' };
  const pct = job.total ? Math.round((job.done / job.total) * 100) : (job.status === 'done' ? 100 : 0);

  const head = el('div', { style: 'display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px' }, [
    el('strong', { text: job.title || job.id }),
    el('span', { class: `pill ${meta.cls}`, text: meta.label }),
    el('span', { class: 'muted', style: 'font-size:12px', text: `${job.done}/${job.total || '?'}${job.status === 'running' ? ` · ${pct}%` : ''}` }),
    (job.status === 'queued' || job.status === 'running')
      ? el('button', { class: 'btn btn-sm btn-danger', type: 'button', text: '取消', onclick: () => cancel(job) })
      : null,
  ].filter(Boolean));

  const bar = el('div', {
    style: 'height:6px;background:var(--border,rgba(0,0,0,.08));border-radius:3px;overflow:hidden;margin-bottom:12px',
  }, [el('div', { style: `height:100%;width:${pct}%;background:${job.status === 'failed' ? 'var(--err)' : job.status === 'done' ? 'var(--ok)' : 'var(--accent)'}` })]);

  const steps = (job.progress?.steps || []).map((s) => el('div', {
    style: 'display:flex;gap:8px;align-items:baseline;padding:4px 0;border-bottom:1px solid var(--border);font-size:12.5px',
  }, [
    el('span', { class: `pill ${STEP_CLS[s.state] || 'pill-idle'}`, text: ({ pending: '待', running: '跑', ok: '✓', fail: '✗', skip: '跳' })[s.state] || s.state }),
    el('span', { style: 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap', text: s.label || '' }),
    s.ms ? el('span', { class: 'muted', style: 'white-space:nowrap', text: fmtMs(s.ms) }) : null,
    s.detail ? el('span', { class: 'muted', style: 'max-width:46%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap', text: s.detail }) : null,
  ].filter(Boolean)));

  const out = [head, bar];
  if (steps.length) out.push(el('div', {}, steps));
  if (job.error && job.status !== 'running') {
    out.push(el('div', { class: 'field-hint', style: 'margin-top:10px;color:var(--err)', text: `⚠ ${job.error}` }));
  }
  if (job.result) out.push(renderResult(job));

  host.replaceChildren(...out);
}

function renderResult(job) {
  const r = job.result;
  if (job.kind === 'fingerprint') return renderFingerprintResult(r);
  if (job.kind === 'probe') return renderProbeResult(r);
  return el('pre', { class: 'codeblock', text: JSON.stringify(r, null, 2) });
}

/* -------------------------------------------------- 结果渲染 */

export function renderFingerprintResult(r) {
  if (r.error) return el('div', { class: 'field-hint', style: 'color:var(--err)', text: `⚠ ${r.error}` });

  const wrap = el('div', { style: 'margin-top:14px' });
  const p = r.prediction || {};
  const conf = p.probability === null || p.probability === undefined ? '置信度未知' : `${(p.probability * 100).toFixed(1)}%`;

  wrap.append(
    el('div', {
      style: 'padding:12px 14px;border-radius:10px;background:var(--accent-soft,rgba(59,130,246,.10));margin-bottom:12px',
    }, [
      el('div', { class: 'muted', style: 'font-size:12px;margin-bottom:4px', text: '指纹判定（最接近的候选）' }),
      el('div', { style: 'font-size:18px;font-weight:600' }, [
        document.createTextNode(p.name || p.id || '未知'),
        el('span', { class: 'muted', style: 'font-size:13px;font-weight:400;margin-left:8px', text: `置信度 ${conf}` }),
      ]),
      el('div', { class: 'muted', style: 'font-size:12px;margin-top:4px', text: `家族：${p.family || '—'}${p.reason ? ` · ${p.reason}` : ''}` }),
    ]),
  );

  const rows = (r.ranking || []).map((x, i) => el('tr', {}, [
    el('td', { class: 'muted', text: `#${i + 1}` }),
    el('td', {}, [el('span', { class: i === 0 ? 'pill pill-accent' : 'pill pill-idle', text: x.displayName || x.model })]),
    el('td', { class: 'muted', style: 'font-size:12px', text: x.family || '—' }),
    el('td', { text: x.probability === null || x.probability === undefined ? '—' : `${(x.probability * 100).toFixed(1)}%` }),
    el('td', { class: 'muted', style: 'font-size:12px', text: x.score === null || x.score === undefined ? '—' : Number(x.score).toFixed(3) }),
  ]));
  if (rows.length) {
    wrap.append(el('div', { class: 'table-wrap' }, [el('table', { class: 'table' }, [
      el('thead', {}, [el('tr', {}, [
        el('th', { text: '#' }), el('th', { text: '候选模型' }), el('th', { text: '家族' }),
        el('th', { text: '置信度' }), el('th', { text: '分数' }),
      ])]),
      el('tbody', {}, rows),
    ])]));
  }
  wrap.append(el('div', {
    class: 'field-hint', style: 'margin-top:8px',
    text: '⚠ 结果是参考库内的封闭集合排序；不在库中的模型也会得到"最像"的候选，排名与置信度都不是身份证明。',
  }));
  return wrap;
}

export function renderProbeResult(r) {
  const wrap = el('div', { style: 'margin-top:14px' });
  wrap.append(el('div', {
    style: 'padding:10px 12px;border-radius:8px;margin-bottom:10px;'
      + `background:${r.allFailed ? 'var(--err-soft,rgba(239,68,68,.10))' : 'var(--ok-soft,rgba(34,197,94,.10))'}`,
  }, [
    el('strong', { text: r.allFailed ? `全部 ${r.total} 个 Key 都失败` : `${r.okCount}/${r.total} 个 Key 成功` }),
    r.banned ? el('span', { class: 'pill pill-err', style: 'margin-left:8px', text: '已自动拉黑' }) : null,
  ].filter(Boolean)));

  wrap.append(el('div', { class: 'table-wrap' }, [el('table', { class: 'table' }, [
    el('thead', {}, [el('tr', {}, [
      el('th', { text: 'Key' }), el('th', { text: '结果' }), el('th', { text: 'HTTP' }),
      el('th', { text: '延迟' }), el('th', { text: '说明' }),
    ])]),
    el('tbody', {}, (r.results || []).map((x) => el('tr', {}, [
      el('td', {}, [el('span', { class: 'uuid-cell', text: x.keyName || x.key })]),
      el('td', {}, [el('span', {
        class: x.state === 'ok' ? 'pill pill-ok' : x.state === 'skip' ? 'pill pill-idle' : 'pill pill-err',
        text: x.state === 'ok' ? '成功' : x.state === 'skip' ? '跳过' : '失败',
      })]),
      el('td', { class: 'muted', text: x.httpStatus ?? '—' }),
      el('td', { class: 'muted', text: fmtMs(x.ms) }),
      el('td', { class: 'muted', style: 'font-size:12px', text: x.message || '—' }),
    ]))),
  ])]));
  return wrap;
}

export default {
  initJobsPanel, renderJobsInto, watchJob, stopWatch, renderJobDetail,
  renderFingerprintResult, renderProbeResult, statusPill, openJobModal,
};
