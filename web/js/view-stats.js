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
  const [s, st, lg, mh, rates, ban] = await Promise.all([
    api.stats(),
    api.states($('#stateFilterChannel')?.value || undefined),
    api.logs(Number($('#logLimit')?.value) || 100),
    api.modelHealth({
      channel: $('#mhFilterChannel')?.value || undefined,
      state: $('#mhFilterState')?.value || undefined,
    }).catch(() => ({ models: [], summary: [] })),
    api.rates(Number($('#rateLimit')?.value) || 5000).catch(() => ({ byModel: [], byKey: [], byChannel: [] })),
    api.blacklist().catch(() => ({ banned: [] })),
  ]);
  renderStatCards(s);
  renderModelHealth(mh);
  renderRates(rates);
  renderBanSummary(ban);
  renderChannelStats(s);
  renderErrClasses(s);
  renderStates(st);
  renderLogs(lg);
  tickCountdowns();   // 共用倒计时器（ui.js）
}

/* ============================================================
 * ⭐ 模型黑名单概览（按渠道统计；明细在「模型黑名单」导航页）
 * ============================================================ */

function renderBanSummary(ban) {
  const host = $('#banStatBody');
  if (!host) return;
  const rows = ban?.banned || [];
  if (!rows.length) {
    host.replaceChildren(el('span', { class: 'muted', text: '黑名单为空。' }));
    return;
  }
  // 按渠道聚合
  const byCh = new Map();
  for (const b of rows) {
    const k = b.channel;
    if (!byCh.has(k)) byCh.set(k, { display: b.channelDisplay || b.channel, name: k, items: [] });
    byCh.get(k).items.push(b);
  }
  const chips = [...byCh.values()].map((g) => el('span', {
    class: 'chip chip-count',
    title: g.items.map((x) => `${x.model}（${x.sourceLabel}）`).join('\n'),
  }, [
    `${g.display} `,
    el('b', { class: 'chip-err', text: String(g.items.length) }),
  ]));
  host.replaceChildren(
    el('div', { style: 'display:flex;flex-wrap:wrap;gap:6px' }, chips),
    el('div', {
      class: 'muted',
      style: 'font-size:12px;margin-top:8px',
      text: `共 ${rows.length} 条被拉黑 —— 它们不会出现在下游模型清单里，也不会被尝试。`
        + '详情与解禁：「模型黑名单」导航页。',
    }),
  );
}

/* ============================================================
 * ⭐ 模型健康度（正常 / 降级 / 不可用）
 * ============================================================ */

const MH_STATE = {
  NORMAL: { label: '正常', cls: 'pill-ok' },
  DEGRADED: { label: '降级', cls: 'pill-warn' },
  UNAVAILABLE: { label: '不可用', cls: 'pill-err' },
};

function renderModelHealth(mh) {
  const host = $('#mhTbody');
  const empty = $('#mhEmpty');
  const rows = mh?.models || [];

  // 汇总条：各渠道降级 / 不可用计数
  const sumHost = $('#mhSummary');
  if (sumHost) {
    const sum = (mh?.summary || []).filter((x) => x.degraded || x.unavailable);
    const r = mh?.rules || {};
    if (!sum.length) {
      sumHost.replaceChildren(el('span', { class: 'muted', text: '所有模型健康度正常' }));
    } else {
      sumHost.replaceChildren(
        ...sum.map((x) => el('span', { class: 'chip chip-count', title: x.channel }, [
          `${x.channelDisplay || x.channel} `,
          x.degraded ? el('b', { class: 'chip-warn', text: `降级 ${x.degraded}` }) : null,
          document.createTextNode(' '),
          x.unavailable ? el('b', { class: 'chip-err', text: `不可用 ${x.unavailable}` }) : null,
        ])),
        el('span', {
          class: 'muted',
          style: 'font-size:12px;margin-left:8px',
          text: `规则：连续失败 ${r.degradeAfterFails ?? '?'} 次降级、${r.unavailableAfterFails ?? '?'} 次不可用；`
            + `不可用约 ${Math.round((r.recoverMs || 0) / 3600000)} 小时后降级观察`
            + `；单渠道最多试四分之一的 Key（${r.channelCircuitFraction ?? 4} 分之一）`,
        }),
      );
    }
  }

  if (!rows.length) {
    host.replaceChildren();
    if (empty) empty.hidden = false;
    return;
  }
  if (empty) empty.hidden = true;

  host.replaceChildren(...rows.map((m) => {
    const st = MH_STATE[m.state] || { label: m.state, cls: 'pill-idle' };
    const total = (m.totalOk || 0) + (m.totalFail || 0);
    const rateTxt = total ? `${m.totalOk}/${total}` : '—';

    // 恢复倒计时：UNAVAILABLE / DEGRADED 都有 untilAt
    const remaining = m.remainingMs || 0;
    const cdCell = remaining > 0
      ? el('span', {
        class: 'muted mono',
        'data-countdown-until': String(m.untilAt),
        text: fmtCountdown(remaining),
      })
      : el('span', { class: 'muted', text: '—' });

    return el('tr', {}, [
      el('td', {}, [el('span', { class: 'pill pill-accent', text: m.channelDisplay || m.channel })]),
      el('td', { class: 'uuid-cell', text: m.model, title: m.model }),
      el('td', {}, [el('span', { class: `pill ${st.cls}`, text: st.label })]),
      el('td', { text: String(m.failStreak ?? 0) }),
      el('td', { class: 'muted', text: rateTxt }),
      el('td', {}, [cdCell]),
      el('td', { class: 'muted', title: m.reason || m.lastError || '', text: (m.reason || m.lastError || '—').slice(0, 46) }),
      el('td', { class: 'col-actions' }, [
        el('button', {
          class: 'btn btn-sm', type: 'button', text: '重置',
          title: '清除该模型的熔断状态，立即恢复为正常',
          onclick: async () => {
            try {
              await api.resetModelHealth(m.channel, m.model);
              toast(`已重置 ${m.channel}/${m.model}`, 'ok');
              await loadStats();
            } catch (e) { toast(e.message, 'err'); }
          },
        }),
      ]),
    ]);
  }));
}

/* ============================================================
 * ⭐ 成功率（按模型 / Key / 渠道）
 * ============================================================ */

function renderRates(rates) {
  const dim = $('#rateDim')?.value || 'byModel';
  const rows = rates?.[dim] || [];
  const thead = $('#rateThead');
  const tbody = $('#rateTbody');
  const empty = $('#rateEmpty');
  if ($('#rateScope')) {
    $('#rateScope').textContent = rates?.scope || `抽样：最近 ${rates?.sampleLimit ?? '-'} 条流水`;
  }

  if (!rows.length) {
    thead.replaceChildren();
    tbody.replaceChildren();
    if (empty) empty.hidden = false;
    return;
  }
  if (empty) empty.hidden = true;

  /** 维度 → 首列表头 */
  const firstCol = { byModel: '模型', byKey: 'Key', byChannel: '渠道' }[dim] || '维度';
  thead.replaceChildren(
    ...['', firstCol, '请求数', '成功', '失败', '成功率', '平均成功延迟']
      .slice(1).map((h) => el('th', { text: h })),
  );

  tbody.replaceChildren(...rows.map((r) => {
    const rate = r.rate;
    const pct = r.ratePct == null ? '—' : `${r.ratePct}%`;
    const cls = rate == null ? 'pill-idle' : rate >= 0.95 ? 'pill-ok' : rate >= 0.7 ? 'pill-warn' : 'pill-err';

    let nameNode;
    if (dim === 'byModel') {
      nameNode = el('td', { class: 'uuid-cell', text: r.model || '—', title: r.model || '' });
    } else if (dim === 'byKey') {
      nameNode = el('td', { class: 'uuid-cell' }, [
        el('div', { style: 'display:flex;gap:8px;align-items:center' }, [
          el('span', { text: r.key_uuid || '—', title: r.key_uuid || '' }),
          r.channel
            ? el('span', { class: 'pill pill-accent', text: r.channel_display || r.channel })
            : null,
        ]),
      ]);
    } else {
      nameNode = el('td', {}, [
        el('span', { class: 'pill pill-accent', text: r.channel_display || r.channel || r.channel_id || '—' }),
      ]);
    }

    return el('tr', {}, [
      nameNode,
      el('td', { text: String(r.req ?? 0) }),
      el('td', { text: String(r.ok ?? 0) }),
      el('td', { text: String(r.fail ?? 0) }),
      el('td', {}, [el('span', { class: `pill ${cls}`, text: pct })]),
      el('td', { class: 'muted', text: fmtMs(r.avgOkLatency ?? null) }),
    ]);
  }));
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
  $('#mhFilterChannel')?.addEventListener('change', () => {
    loadStats().catch((e) => toast(e.message, 'err'));
  });
  $('#mhFilterState')?.addEventListener('change', () => {
    loadStats().catch((e) => toast(e.message, 'err'));
  });
  $('#rateDim')?.addEventListener('change', () => {
    loadStats().catch((e) => toast(e.message, 'err'));
  });
  $('#rateLimit')?.addEventListener('change', () => {
    loadStats().catch((e) => toast(e.message, 'err'));
  });
}

export default { loadStats, initStatsView };
