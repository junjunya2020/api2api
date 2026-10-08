/**
 * 视图：模型黑名单（独立标签页）。
 *
 * ⭐ 用户 2026-10-08 明确要求：黑名单要**自己一个导航页**，
 *    与「Key 管理 / 模型 / 渠道 / 测活 / 观测 / 设置」并列 —— 不要塞进设置页。
 *
 * 语义（用户原话）：
 *   「连续失败过多的模型+渠道自动禁用」「从来没成功过、每次调用都失败 → 不在模型列表出现」
 *   「加入的是**原始渠道名称 + 原始上游模型名称**，不是转换后的名称」
 *   「之前确定用不了的模型就直接拉黑了，**让用户能看到为什么拉黑**」
 *   「nvidia 那些模型开启了快速模式后就默认拉黑」
 *
 * 所以这一页 = **开关 + 理由可读的明细表 + 解禁 / 手动加入**。
 */
import api from './api.js';
import { $, el, toast, openModal, field, confirmDialog } from './ui.js';
import { openJobModal } from './view-jobs.js';

const state = {
  banned: [],
  sources: [],
  settings: null,
};

export async function loadBlacklist() {
  renderToggles(null);
  renderList(null, '登录后可见');
  if (!api) return;

  const [s, b] = await Promise.all([
    api.settings().catch(() => null),
    api.blacklist().catch(() => null),
  ]);

  if (!b) {
    renderToggles(null);
    renderList(null, '读取黑名单失败（可能是 token 未设置或已失效）');
    return;
  }
  state.settings = s;
  state.banned = b.banned || [];
  state.sources = b.sources || [];
  renderToggles(s);
  renderList();
}

/* ---------------------------------------------------------------- 开关 */

async function renderToggles(res) {
  const host = $('#blacklistToggles');
  if (!host) return;

  if (!res) {
    host.replaceChildren(el('div', { class: 'muted', text: '登录后可见' }));
    return;
  }
  const s = res.settings || {};
  const bkOn = !!s.blacklistEnabled;
  const autoOn = !!s.autoBlacklistEnabled;

  host.replaceChildren(
    toggleRow({
      label: '是否开启模型黑名单',
      hint: '总开关。黑名单里的 (原始渠道 × 原始上游模型) 会被从下游模型清单里**隐藏**，'
        + '转发时**一次请求都不会发**。关闭后只保留记录、不产生任何拦截。',
      on: bkOn,
      patch: { blacklistEnabled: !bkOn },
      toastOn: '已开启模型黑名单',
      toastOff: '已关闭模型黑名单（仅保留记录，不再拦截）',
    }),
    el('hr', { style: 'border:none;border-top:1px solid var(--border);margin:14px 0' }),
    toggleRow({
      label: '是否自动加入',
      hint: `某 (渠道, 模型) **从未成功过**且累计失败 ≥ ${s.autoBanAfterFails ?? 10} 次时，`
        + '自动把它加入黑名单（不再尝试、不再列出）。'
        + '⚠️ 只要成功过 1 次就不会被自动拉黑 —— 高失败率的模型交给「观测 → 模型健康度」自动熔断（会自己恢复）。',
      on: autoOn,
      patch: { autoBlacklistEnabled: !autoOn },
      toastOn: '已开启：连续失败（从未成功）自动加入黑名单',
      toastOff: '已关闭：不再自动加入黑名单',
    }),
  );
}

function toggleRow({ label, hint, on, patch, toastOn, toastOff }) {
  const btn = el('button', {
    class: on ? 'btn btn-primary' : 'btn',
    type: 'button',
    text: on ? '已开启' : '已关闭',
    onclick: async () => {
      try {
        const r = await api.patchSettings(patch);
        toast(r.settings?.[Object.keys(patch)[0]] ? toastOn : toastOff, 'ok');
        await loadBlacklist();
      } catch (e) { toast(e.message, 'err'); }
    },
  });
  return el('div', { style: 'display:flex;justify-content:space-between;align-items:flex-start;gap:16px' }, [
    el('div', { style: 'flex:1' }, [
      el('div', { style: 'font-weight:500;margin-bottom:4px', text: label }),
      el('div', { class: 'field-hint', text: hint }),
    ]),
    btn,
  ]);
}

/* ---------------------------------------------------------------- 明细 */

const SOURCE_PILL = {
  builtin: 'pill-err',
  auto: 'pill-warn',
  'fast-mode': 'pill-idle',
  manual: 'pill-accent',
};

function renderList(_ignored, errorText) {
  const host = $('#blacklistBody');
  const empty = $('#blacklistEmpty');
  const summary = $('#blacklistSummary');
  if (!host) return;

  if (errorText) {
    host.replaceChildren(el('div', { class: 'muted', text: errorText }));
    if (empty) empty.hidden = true;
    if (summary) summary.replaceChildren();
    return;
  }

  const rows = state.banned;
  // 按渠道聚合的小结
  if (summary) {
    const byCh = new Map();
    for (const b of rows) {
      if (!byCh.has(b.channel)) byCh.set(b.channel, { display: b.channelDisplay || b.channel, items: [] });
      byCh.get(b.channel).items.push(b);
    }
    summary.replaceChildren(
      ...(byCh.size
        ? [...byCh.values()].map((g) => el('span', {
          class: 'chip chip-count', title: g.items.map((x) => `${x.model}（${x.sourceLabel}）`).join('\n'),
        }, [`${g.display} `, el('b', { class: 'chip-err', text: String(g.items.length) })]))
        : [el('span', { class: 'muted', text: '黑名单为空' })]),
      el('span', {
        class: 'muted', style: 'font-size:12px;margin-left:8px',
        text: `共 ${rows.length} 条被拉黑 —— 它们不会出现在下游模型清单里，也不会被尝试`,
      }),
    );
  }

  if (!rows.length) {
    host.replaceChildren();
    if (empty) empty.hidden = false;
    return;
  }
  if (empty) empty.hidden = true;

  const table = el('table', { class: 'table' }, [
    el('thead', {}, [el('tr', {}, [
      el('th', { text: '渠道（原始）' }),
      el('th', { text: '模型（原始上游名）' }),
      el('th', { text: '来源' }),
      el('th', { text: '失败/成功' }),
      el('th', { text: '为什么拉黑' }),
      el('th', { class: 'col-actions', text: '操作' }),
    ])]),
    el('tbody', {}, rows.map((b) => el('tr', {}, [
      el('td', {}, [el('span', { class: 'pill pill-idle', text: `${b.channelDisplay}（${b.channel}）` })]),
      el('td', {}, [el('span', { class: 'uuid-cell', text: b.model })]),
      el('td', {}, [el('span', { class: SOURCE_PILL[b.source] || 'pill-idle', text: b.sourceLabel })]),
      el('td', { class: 'muted', text: `${b.failCount ?? 0} / ${b.okCount ?? 0}` }),
      el('td', { style: 'max-width:440px;font-size:12px;line-height:1.5', text: b.reason || '—' }),
      el('td', { class: 'col-actions' }, [
        // ⭐ 左键 = 立刻开始测（实时进度框）；右键 = 设置超时
        el('button', {
          class: 'btn btn-sm', type: 'button', text: '测试可用性',
          title: '左键：立即测试（实时进度）；右键：设置超时',
          onclick: () => testAvailability(b),
          oncontextmenu: (e) => openTimeoutMenu(e, 'probe'),
        }),
        document.createTextNode(' '),
        el('button', {
          class: 'btn btn-sm', type: 'button', text: '测试指纹',
          title: '左键：立即测试；右键：设置超时',
          onclick: () => testFingerprint(b),
          oncontextmenu: (e) => openTimeoutMenu(e, 'fingerprint'),
        }),
        document.createTextNode(' '),
        el('button', { class: 'btn btn-sm', type: 'button', text: '解禁', onclick: () => unban(b) }),
      ]),
    ]))),
  ]);

  host.replaceChildren(el('div', { class: 'table-wrap' }, [table]));
}

/** 当前生效的超时（秒），按"操作类型"记在 localStorage */
function timeoutSec(kind) {
  const d = kind === 'fingerprint' ? 120 : 10;
  const v = Number(localStorage.getItem(`a2a.timeout.${kind}`));
  return Number.isFinite(v) && v >= (kind === 'fingerprint' ? 5 : 3) ? v : d;
}
function setTimeoutSec(kind, sec) { localStorage.setItem(`a2a.timeout.${kind}`, String(sec)); }

function openTimeoutMenu(e, kind) {
  e.preventDefault();
  e.stopPropagation();
  const isFp = kind === 'fingerprint';
  const in_ = el('input', { class: 'input', type: 'number', min: isFp ? '5' : '3', value: String(timeoutSec(kind)) });
  openModal({
    title: `设置${isFp ? '指纹测试' : '可用性测试'}超时`,
    bodyNode: [
      el('p', { class: 'muted', style: 'font-size:12.5px', text: isFp
        ? '指纹要模型写几百个随机数，推理模型会慢一些，建议 120 秒以上。'
        : '每个 Key 等"首字"的最长时间。默认 10 秒。' }),
      field(`${isFp ? '单次' : '每个 Key '}超时（秒）`, in_, '保存后立即用于下一次左键测试'),
    ],
    okText: '保存',
    onOk: () => {
      const v = Number(in_.value);
      if (!Number.isFinite(v) || v < (isFp ? 5 : 3)) { toast('超时太短', 'warn'); return false; }
      setTimeoutSec(kind, v);
      toast(`已设置：${v} 秒`, 'ok');
    },
  });
}

/** 测可用性（黑名单条目）—— 左键立即开始，弹实时进度框；关掉也在后台继续 */
async function testAvailability(b) {
  let jr;
  try {
    jr = await api.enqueueProbe({ channel: b.channel, model: b.model, timeoutMs: timeoutSec('probe') * 1000 });
  } catch (e) { toast(e.message, 'err', 6000); return; }
  openJobModal({ title: `测试可用性：${b.channel} / ${b.model}（超时 ${timeoutSec('probe')}s/Key）`, jobId: jr.job.id });
  toast('已开始测试（关掉进度框也会在后台继续）', 'ok', 4000);
}

/** 测指纹（黑名单条目）—— 左键立即开始，弹实时进度框 */
async function testFingerprint(b) {
  let jr;
  try {
    jr = await api.enqueueFingerprint({ model: b.model, api: 'cc', timeoutSec: timeoutSec('fingerprint') });
  } catch (e) { toast(e.message, 'err', 6000); return; }
  openJobModal({ title: `测试指纹：${b.model}`, jobId: jr.job.id });
}

async function unban(b) {
  const ok = await confirmDialog('解除拉黑',
    `确认解除「${b.channel} / ${b.model}」的拉黑？\n解除后它会重新参与路由（若确实是坏的，连续失败会自动再拉黑）。`);
  if (!ok) return;
  try {
    await api.unbanModel(b.channel, b.model);
    toast('已解禁', 'ok');
    await loadBlacklist();
  } catch (e) { toast(e.message, 'err'); }
}

/* ---------------------------------------------------------- 手动加入 */

function addBanDialog() {
  const chSel = el('select', { class: 'input' }, [el('option', { value: '', text: '（请选择渠道）' })]);
  const modelList = el('datalist', { id: 'banModelHints' });
  const modelIn = el('input', {
    class: 'input', placeholder: '原始上游模型名，例如 deepseek-v4-pro',
    autocomplete: 'off', list: 'banModelHints',
  });
  const reasonIn = el('input', { class: 'input', placeholder: '为什么拉黑（用户可见）', autocomplete: 'off' });

  // 选渠道后把该渠道的上游模型名灌进 datalist，省得手打错
  async function refreshModels() {
    modelList.replaceChildren();
    if (!chSel.value) return;
    try {
      const u = await api.upstreamModels();
      const g = (u.groups || []).find((x) => x.channel === chSel.value);
      for (const m of g?.models || []) modelList.append(el('option', { value: m }));
    } catch { /* ignore */ }
  }
  chSel.addEventListener('change', refreshModels);

  api.channels().then((r) => {
    for (const c of r.channels || []) {
      chSel.append(el('option', { value: c.name, text: `${c.displayName}（${c.name}）` }));
    }
  }).catch(() => {});

  openModal({
    title: '手动加入黑名单',
    bodyNode: [
      modelList,
      field('渠道（原始渠道名）', chSel, '拉黑的是「渠道 × 原始上游模型名」，不是对外名'),
      field('模型（原始上游名）', modelIn, '只影响这条渠道上的这个上游模型，其他渠道的同名模型不受影响'),
      field('原因', reasonIn, '会展示给用户，说明为什么拉黑'),
    ],
    okText: '加入黑名单',
    onOk: async () => {
      if (!chSel.value) { toast('请选择渠道', 'warn'); return false; }
      if (!modelIn.value.trim()) { toast('模型名必填', 'warn'); return false; }
      await api.banModel({
        channel: chSel.value,
        model: modelIn.value.trim(),
        reason: reasonIn.value.trim() || '手动加入',
      });
      toast('已加入黑名单', 'ok');
      await loadBlacklist();
    },
  });
}

export function initBlacklistView() {
  const add = $('#btnAddBan');
  if (add) add.addEventListener('click', () => addBanDialog());
  const sync = $('#btnSyncFastBans');
  if (sync) {
    sync.addEventListener('click', async () => {
      try {
        const r = await api.syncFastBans();
        toast(`已重算「快速模式」拉黑：新增 ${r.added ?? 0} / 移除 ${r.removed ?? 0}`, 'ok');
        await loadBlacklist();
      } catch (e) { toast(e.message, 'err'); }
    });
  }
}

export default { loadBlacklist, initBlacklistView };
