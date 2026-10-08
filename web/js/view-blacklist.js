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
        el('button', { class: 'btn btn-sm', type: 'button', text: '测试可用性', onclick: () => testAvailability(b) }),
        document.createTextNode(' '),
        el('button', { class: 'btn btn-sm', type: 'button', text: '测试指纹', onclick: () => testFingerprint(b) }),
        document.createTextNode(' '),
        el('button', { class: 'btn btn-sm', type: 'button', text: '解禁', onclick: () => unban(b) }),
      ]),
    ]))),
  ]);

  host.replaceChildren(el('div', { class: 'table-wrap' }, [table]));
}

/** 测可用性（黑名单条目）—— 默认后台跑，顺带会按结果决定是否重新拉黑 */
function testAvailability(b) {
  const toIn = el('input', { class: 'input', type: 'number', value: '10', min: '3' });
  const bgIn = el('input', { class: 'input', type: 'checkbox', checked: true });
  const bgWrap = el('label', { style: 'display:flex;align-items:center;gap:8px;font-size:13px' }, [
    bgIn, el('span', { text: '放到后台跑（可在「后台任务管理」看进度）' }),
  ]);
  openModal({
    title: `测试可用性：${b.channel} / ${b.model}`,
    bodyNode: [
      el('p', { class: 'muted', style: 'font-size:12.5px', text: '会把这个 (渠道, 模型) 在该渠道的所有 Key 上各打一次。' }),
      field('每个 Key 超时（秒）', toIn, '默认 10 秒'),
      bgWrap,
    ],
    okText: '开始',
    onOk: async () => {
      const timeoutMs = Math.max(3, Number(toIn.value) || 10) * 1000;
      if (bgIn.checked) {
        await api.enqueueProbe({ channel: b.channel, model: b.model, timeoutMs });
        toast('已提交后台任务（可在「后台任务管理」查看）', 'ok', 5000);
      } else {
        toast('正在测试，请稍候…', 'info', 2500);
        const r = await api.probeModel({ channel: b.channel, model: b.model, timeoutMs, autoBan: false });
        toast(r.allFailed ? `全部 ${r.total} 个 Key 失败` : `${r.okCount}/${r.total} 个 Key 成功`, r.allFailed ? 'warn' : 'ok', 6000);
        await loadBlacklist();
      }
    },
  });
}

/** 测指纹（黑名单条目）—— 只测，不解禁；结果反过来判断该不该解禁 */
function testFingerprint(b) {
  const apiSel = el('select', { class: 'input' }, [
    el('option', { value: 'cc', text: 'Chat Completions' }),
    el('option', { value: 'responses', text: 'Responses' }),
    el('option', { value: 'message', text: 'Anthropic Messages' }),
  ]);
  openModal({
    title: `测试模型指纹：${b.model}`,
    bodyNode: [
      el('p', { class: 'muted', style: 'font-size:12.5px', text: '用 lm-detector 让模型写随机数，识别它背后到底是不是这个名字对应的模型。' }),
      field('协议', apiSel, '多数渠道用 Chat Completions'),
    ],
    okText: '后台测试',
    onOk: async () => {
      try {
        await api.enqueueFingerprint({ model: b.model, api: apiSel.value });
        toast('已提交指纹测试任务，请到「指纹测试」页看结果', 'ok', 6000);
      } catch (e) { toast(e.message, 'err', 6000); return false; }
    },
  });
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
