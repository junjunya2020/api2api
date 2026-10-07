/**
 * 视图：观测。
 * 统计卡 + 渠道维度 + 错误分类分布 + 调度状态 + 请求流水。
 */
import api from './api.js';
import {
  $, el, fmtTime, fmtAgo, fmtMs, fmtCountdown, tickCountdowns,
  statePillClass, errClassLabel, statusPill, toast,
} from './ui.js';

export async function loadStats() {
  const [s, st, lg] = await Promise.all([
    api.stats(),
    api.states($('#stateFilterChannel')?.value || undefined),
    api.logs(Number($('#logLimit')?.value) || 100),
  ]);
  renderStatCards(s);
  renderChannelStats(s);
  renderErrClasses(s);
  renderStates(st);
  renderLogs(lg);
  tickCountdowns();   // 共用倒计时器（ui.js）
}

function renderStatCards(s) {
  const chans = s.channels || [];
  const totalKeys = chans.reduce((a, c) => a + (c.keyCount || 0), 0);
  const enabledKeys = chans.reduce((a, c) => a + (c.keyEnabledCount || 0), 0);
  const byCh = s.byChannel || [];
  const totalReq = byCh.reduce((a, c) => a + (c.requests || 0), 0);
  const totalOk = byCh.reduce((a, c) => a + (c.ok || 0), 0);
  const rate = totalReq ? ((totalOk / totalReq) * 100).toFixed(1) + '%' : '—';

  // 两个口径都要显示，且**必须标注清楚**，否则会像"3 vs 4"那样自相矛盾：
  //   byKey  = 有几把 Key 不能用（与「Key 管理」页一致）
  //   byCell = key×模型 维度（同一个 Key 在多个模型上冷却会算多次）
  const sum = s.stateSummary || {};
  const byKey = sum.byKey || [];
  const byCell = sum.byCell || [];
  const keyCooling = byKey.find((x) => x.state === 'COOLDOWN')?.n || 0;
  const keyDisabled = byKey.find((x) => x.state === 'DISABLED')?.n || 0;
  const cellCooling = byCell.find((x) => x.state === 'COOLDOWN')?.n || 0;
  const cellDisabled = byCell.find((x) => x.state === 'DISABLED')?.n || 0;
  const unhealthy = (sum.unhealthyKeys ?? 0);

  const cards = [
    ['渠道数', String(chans.length), '内置渠道'],
    ['Key 总数', String(totalKeys), `启用 ${enabledKeys}`],
    ['累计请求', String(totalReq), `成功 ${totalOk}`],
    ['成功率', rate, totalReq ? '全部请求' : '暂无数据'],
    ['异常 Key', String(unhealthy), `冷却 ${keyCooling} · 禁用 ${keyDisabled}`],
    ['Key×模型', `${cellCooling}/${cellDisabled}`, '冷却 / 禁用（同 Key 多模型会重复计）'],
  ];

  // 单独的"对外模型"卡：需要 token 且可能较大，放最后
  cards.push(['对外模型', String(s.modelCount || 0), '映射条目去重']);

  $('#statCards').replaceChildren(...cards.map(([label, value, sub]) => el('div', { class: 'stat-card' }, [
    el('div', { class: 'stat-label', text: label }),
    el('div', { class: `stat-value${String(value).length > 8 ? ' sm' : ''}`, text: value }),
    el('div', { class: 'stat-sub', text: sub }),
  ])));
}

function renderChannelStats(s) {
  const byName = new Map((s.byChannel || []).map((x) => [x.channel, x]));
  const keyByName = new Map((s.keyStats || []).map((x) => [x.channel, x]));

  const rows = (s.channels || []).map((c) => {
    const b = byName.get(c.name) || {};
    const k = keyByName.get(c.name) || {};
    const req = b.requests || 0;
    const ok = b.ok || 0;
    const rate = req ? ((ok / req) * 100).toFixed(1) + '%' : '—';
    const rateCls = !req ? 'pill-idle' : (ok / req) >= 0.95 ? 'pill-ok' : (ok / req) >= 0.7 ? 'pill-warn' : 'pill-err';

    return el('tr', {}, [
      el('td', {}, [
        el('div', { style: 'display:flex;gap:8px;align-items:center' }, [
          el('span', { class: 'pill pill-accent', text: c.displayName }),
          el('span', { class: 'muted', text: c.name }),
        ]),
      ]),
      el('td', { text: String(k.total ?? c.keyCount ?? 0) }),
      el('td', { text: String(k.enabled ?? c.keyEnabledCount ?? 0) }),
      el('td', { text: String(req) }),
      el('td', { text: String(ok) }),
      el('td', {}, [el('span', { class: `pill ${rateCls}`, text: rate })]),
      el('td', { text: fmtMs(b.avg_ok_latency ?? null) }),
    ]);
  });

  $('#statsChannelTbody').replaceChildren(...rows);
}

function renderErrClasses(s) {
  const list = s.errClasses || [];
  const host = $('#errClassChips');
  if (!list.length) {
    host.replaceChildren(el('span', { class: 'muted', text: '暂无流水' }));
    return;
  }
  host.replaceChildren(...list.map((x) => {
    const [label, cls] = errClassLabel(x.err_class);
    return el('span', { class: `chip chip-count`, title: `${label}` }, [
      `${label} `, el('b', { text: String(x.n) }),
    ]);
  }));
}

function renderStates(st) {
  const tbody = $('#stateTbody');
  const empty = $('#stateEmpty');
  const rows = st.states || [];
  if (!rows.length) {
    tbody.replaceChildren();
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  tbody.replaceChildren(...rows.map((s) => el('tr', {}, [
    el('td', {}, [el('span', { class: 'pill pill-accent', text: s.channel })]),
    el('td', { class: 'uuid-cell', text: s.keyUuid, title: s.keyName || '' }),
    el('td', { class: 'uuid-cell', text: s.model, title: s.model }),
    el('td', {}, [stateCell(s)]),
    el('td', { text: String(s.failStreak) }),
    el('td', { class: 'muted', text: s.nextRetryAt ? fmtTime(s.nextRetryAt) : '—' }),
    el('td', { class: 'muted', text: (s.lastError || '—').slice(0, 60), title: s.lastError || '' }),
  ])));
}

/** 状态列：中文 + 剩余倒计时（与 Key 列表口径一致，避免两处说法不同） */
function stateCell(s) {
  const label = s.state === 'READY' ? '正常' : s.state === 'COOLDOWN' ? '冷却中' : s.state === 'DISABLED' ? '已禁用' : s.state;
  const parts = [el('span', { class: `pill ${statePillClass(s.state)}`, text: label })];
  if (s.remainingMs > 0) {
    const until = s.state === 'DISABLED' ? s.disabledUntil : s.nextRetryAt;
    parts.push(
      el('span', { class: 'muted', text: '剩余' }),
      el('span', { class: 'muted mono', 'data-countdown-until': String(until), text: fmtCountdown(s.remainingMs) }),
    );
  }
  return el('div', { class: 'state-cell' }, parts);
}

function renderLogs(lg) {
  const rows = lg.logs || [];
  const tbody = $('#logTbody');
  if (!rows.length) {
    tbody.replaceChildren(el('tr', {}, [el('td', { colspan: '7', class: 'empty', text: '暂无请求记录' })]));
    return;
  }
  tbody.replaceChildren(...rows.map((l) => {
    const sp = statusPill(l.status);
    const [clsText, clsPill] = errClassLabel(l.err_class);
    return el('tr', {}, [
      el('td', { class: 'muted', text: fmtTime(l.ts), title: fmtAgo(l.ts) }),
      el('td', { class: 'uuid-cell', text: l.public_model || l.model || '—' }),
      el('td', { class: 'uuid-cell', text: l.channel_id ? String(l.channel_id).slice(0, 8) : '—' }),
      el('td', {}, [el('span', { class: `pill ${sp.cls}`, text: sp.text })]),
      el('td', {}, [el('span', { class: `pill ${clsPill}`, text: clsText })]),
      el('td', { text: fmtMs(l.latency_ms) }),
      el('td', { text: l.attempts != null ? String(l.attempts) : '—' }),
    ]);
  }));
}

export function initStatsView() {
  $('#stateFilterChannel').addEventListener('change', () => {
    loadStats().catch((e) => toast(e.message, 'err'));
  });
  $('#logLimit').addEventListener('change', () => {
    loadStats().catch((e) => toast(e.message, 'err'));
  });
}

export default { loadStats, initStatsView };
