/**
 * 视图：后台任务管理（独立导航页）。
 *
 * 用户要求（2026-10-08）：
 *   「还有一个 后台任务管理 …… 也是放在顶部 根之前黑名单一样独立」「可以挂后台」
 *
 * 本页只管"看 / 取消 / 删除 / 看详情"。发起任务的入口在模型页、模型黑名单页、指纹测试页。
 */
import api from './api.js';
import { $, el, toast } from './ui.js';
import { renderJobsInto, watchJob, renderJobDetail, stopWatch } from './view-jobs.js';

let detailWatcher = null;
let autoTimer = null;

export async function loadJobs() {
  await refresh();
  startAuto();
}

async function refresh() {
  const host = $('#jobsBody');
  if (!host) return;
  try {
    const r = await api.jobs({
      kind: $('#jobsFilterKind')?.value || undefined,
      status: $('#jobsFilterStatus')?.value || undefined,
      limit: 80,
    });
    renderJobsInto(host, r.jobs || [], { onJobClick: openDetail });
    // 若有任务在跑 → 顺便刷新一次详情
    if (detailWatcher) {
      const running = (r.jobs || []).find((j) => j.status === 'running' || j.status === 'queued');
      if (!running) { detailWatcher(); detailWatcher = null; }
    }
  } catch (e) {
    host.replaceChildren(el('div', { class: 'muted', text: `读取任务失败：${e.message}` }));
  }
}

/** 每 4 秒自动刷新列表（有跑动任务时；没有则自动停） */
function startAuto() {
  stopAuto();
  autoTimer = setInterval(async () => {
    const host = $('#jobsBody');
    if (!host || !host.offsetParent) { stopAuto(); return; }   // 页面被切走 → 停
    await refresh();
  }, 4000);
}
function stopAuto() { if (autoTimer) { clearInterval(autoTimer); autoTimer = null; } }

async function openDetail(j) {
  const wrap = $('#jobDetailPanel');
  const host = $('#jobDetailBody');
  if (!wrap || !host) return;
  wrap.hidden = false;
  host.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
  if (detailWatcher) { detailWatcher(); detailWatcher = null; }
  if (j.status === 'running' || j.status === 'queued') {
    detailWatcher = watchJob(j.id, host, { onDone: () => { refresh(); } });
  } else {
    try {
      const { job } = await api.job(j.id);
      renderJobDetail(host, job);
    } catch (e) { toast(e.message, 'err'); }
  }
}

export function initJobsView() {
  $('#jobsFilterKind')?.addEventListener('change', refresh);
  $('#jobsFilterStatus')?.addEventListener('change', refresh);
  $('#btnJobsRefresh')?.addEventListener('click', async () => { await refresh(); toast('已刷新', 'ok', 1000); });
  $('#btnJobDetailClose')?.addEventListener('click', () => {
    $('#jobDetailPanel').hidden = true;
    if (detailWatcher) { detailWatcher(); detailWatcher = null; }
  });
  window.addEventListener('a2a:jobs-changed', () => refresh());
  window.addEventListener('beforeunload', () => stopWatch());
}

export function leaveJobs() { stopAuto(); }

export default { loadJobs, initJobsView, leaveJobs };
