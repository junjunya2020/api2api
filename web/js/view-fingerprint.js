/**
 * 视图：指纹测试（独立导航页）。
 *
 * 用户要求（2026-10-08）：
 *   「还有单独指纹测试页面 也是放到顶部 单独的页面进行测试模型指纹
 *     也是在后台测试 但是前台只是实时看到 关闭浏览器不影响进度」
 *
 * 发起 → 到后台任务 → 本页只轮询**实时进度**；
 * 任务在服务端跑，关浏览器只是停止轮询。
 */
import api from './api.js';
import { $, el, fmtAgo, fmtMs, toast } from './ui.js';
import { watchJob, stopWatch, renderJobsInto } from './view-jobs.js';

let activeWatcher = null;
let activeJobId = null;
let autoTimer = null;

export async function loadFingerprint() {
  fillModelHints();
  fillChannels();
  detectStatus();
  await refreshHistory();
  startAuto();
}

/** ⭐ 渠道下拉：默认"全部渠道"（用户 2026-10-08） */
async function fillChannels() {
  const sel = $('#fpChannel');
  if (!sel) return;
  try {
    const r = await api.channels();
    const opts = [el('option', { value: '', text: '全部渠道（默认）' })];
    for (const c of (r.channels || [])) {
      opts.push(el('option', { value: c.name, text: c.displayName || c.name }));
    }
    sel.replaceChildren(...opts);
    sel.value = localStorage.getItem('a2a.fp.channel') || '';
    sel.addEventListener('change', () => {
      localStorage.setItem('a2a.fp.channel', sel.value);
      refreshHistory();          // 历史列表按渠道过滤
      fillModelHints();          // 模型候选也换成该渠道的
    });
  } catch { /* ignore */ }
}

/** 当前选中的渠道（'' = 全部） */
function currentChannel() { return $('#fpChannel')?.value || null; }

async function detectStatus() {
  const host = $('#detectorStatus');
  if (!host) return;
  try {
    const s = await api.detectorStatus();
    host.textContent = s.ready ? '检测器就绪 ✓' : `检测器未就绪（缺 ${s.dir}/cli/fpd.ts）`;
    host.style.color = s.ready ? 'var(--ok)' : 'var(--err)';
  } catch { host.textContent = ''; }
}

/**
 * 模型候选 —— ⭐ 选了渠道就**只列该渠道的模型**（用户 2026-10-08）。
 * 用渠道作用域 token 去问 `/v1/models`，与"这个渠道实际能用什么"完全一致。
 */
async function fillModelHints() {
  const dl = $('#fpModelHints');
  const box = $('#fpModelBox');
  const chips = $('#fpModelChips');
  if (box) box.hidden = true;
  if (chips) chips.replaceChildren();
  if (!dl) return;
  const channel = currentChannel();
  try {
    let ids = [];
    if (channel) {
      const r = await api.scopedModels(channel);
      ids = [...new Set((r.models || []).map((m) => m.id))];
      if (box) {
        box.hidden = false;
        box.textContent = ids.length
          ? `该渠道可用模型 ${ids.length} 个（点下方模型名填入）：`
          : '该渠道暂无模型（可直接手填上游模型名）。';
      }
      // 渠道模型做成可点的 chip —— 比 datalist 更直观
      if (chips && ids.length) {
        chips.replaceChildren(...ids.sort().map((id) => el('button', {
          class: 'btn btn-sm', type: 'button', text: id,
          onclick: () => { const inp = $('#fpModel'); if (inp) inp.value = id; },
        })));
      }
    } else {
      const m = await api.models();
      ids = [...new Set((m.models || []).map((x) => x.id))];
    }
    dl.replaceChildren(...ids.sort().map((id) => el('option', { value: id })));
  } catch { /* ignore */ }
}

async function refreshHistory() {
  const host = $('#fpJobsBody');
  if (!host) return;
  try {
    const r = await api.jobs({ kind: 'fingerprint', limit: 40 });
    let list = r.jobs || [];
    // 选了具体渠道 → 只显示该渠道的指纹任务
    const ch = currentChannel();
    if (ch) list = list.filter((j) => (j.spec?.channel || null) === ch);
    renderJobsInto(host, list, { onJobClick: showResult });
  } catch (e) {
    host.replaceChildren(el('div', { class: 'muted', text: `读取历史失败：${e.message}` }));
  }
}

function startAuto() {
  stopAuto();
  autoTimer = setInterval(async () => {
    const host = $('#fpJobsBody');
    if (!host || !host.offsetParent) { stopAuto(); return; }
    await refreshHistory();
  }, 5000);
}
function stopAuto() { if (autoTimer) { clearInterval(autoTimer); autoTimer = null; } }

/** 开始测试：建后台任务 → 立刻进入实时进度 */
async function run() {
  const model = $('#fpModel')?.value.trim();
  if (!model) { toast('请填模型名', 'warn'); return; }
  const btn = $('#btnRunFingerprint');
  btn.disabled = true;
  try {
    const r = await api.enqueueFingerprint({
      model,
      channel: currentChannel(),
      api: $('#fpApi')?.value || 'cc',
      repeat: Number($('#fpRepeat')?.value) || 1,
      timeoutSec: Number($('#fpTimeout')?.value) || 120,
    });
    toast('已开始测试', 'ok');
    activeJobId = r.job.id;
    $('#fpActivePanel').hidden = false;
    watchActive(r.job.id);
    await refreshHistory();
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

function watchActive(jobId) {
  const host = $('#fpActiveBody');
  if (!host) return;
  if (activeWatcher) { activeWatcher(); activeWatcher = null; }
  activeWatcher = watchJob(jobId, host, {
    onDone: () => { refreshHistory(); },
  });
}

/** 点历史任务 → 在「本次测试实时进度」面板里展示（跑动中的继续实时跟） */
async function showResult(j) {
  activeJobId = j.id;
  $('#fpActivePanel').hidden = false;
  const host = $('#fpActiveBody');
  host.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
  if (j.status === 'running' || j.status === 'queued') {
    watchActive(j.id);
  } else {
    if (activeWatcher) { activeWatcher(); activeWatcher = null; }
    try {
      const { job } = await api.job(j.id);
      const mod = await import('./view-jobs.js');
      mod.renderJobDetail(host, job);
    } catch (e) { toast(e.message, 'err'); }
  }
}

export function initFingerprintView() {
  $('#btnRunFingerprint')?.addEventListener('click', run);
  $('#btnFpRefresh')?.addEventListener('click', async () => { await refreshHistory(); toast('已刷新', 'ok', 1000); });
  window.addEventListener('a2a:jobs-changed', () => refreshHistory());
  window.addEventListener('beforeunload', () => stopWatch());
}

export function leaveFingerprint() { stopAuto(); }

export default { loadFingerprint, initFingerprintView, leaveFingerprint };
