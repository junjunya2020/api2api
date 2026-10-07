/**
 * 视图：Key 管理。
 * 渠道卡片 + Key 表格 + 加/改/删/重置。
 */
import api from './api.js';
import {
  $, el, esc, fmtAgo, fmtCountdown, tickCountdowns, statePillClass,
  toast, openModal, field, confirmDialog,
} from './ui.js';

const state = {
  channels: [],
  keys: [],
  filterChannel: '',
  /** 后端返回的调度策略/限速配置，用于表头提示 */
  scheduler: null,
};

export function selectedChannel() {
  return state.filterChannel || '';
}

export async function loadChannels() {
  const res = await api.channels();
  state.channels = res.channels || [];
  renderChannelCards();
  renderChannelSelects();
}

export async function loadKeys() {
  const res = await api.listKeys(state.filterChannel || undefined);
  state.keys = res.keys || [];
  state.scheduler = res.scheduler || null;
  renderKeyTable();
  renderPolicyHint();
  tickCountdowns();   // 共用倒计时器（ui.js），让"剩余 X 分 Y 秒"每秒自走
}

/** 表头下方一行提示：当前策略 + 限速 + 冷却规则，让用户不用翻文档 */
function renderPolicyHint() {
  const host = $('#keyPolicyHint');
  if (!host) return;
  const s = state.scheduler;
  if (!s) { host.hidden = true; return; }
  const policy = s.policy === 'weighted' ? '加权轮询' : '填满优先';
  const rpm = s.keyRpmLimit > 0 ? `${s.keyRpmLimit} 次/分` : '不限速';
  const stepMin = Math.round((s.cooldownStepMs || 0) / 60000);
  const recoverH = Math.round((s.disabledRecoverMs || 0) / 3600000);
  host.hidden = false;
  host.replaceChildren(
    el('span', { class: 'pill pill-info', text: policy }),
    el('span', {
      class: 'muted',
      text: s.keyRpmLimit > 0
        ? `每把 Key 最多 ${rpm}，用满即换下一把`
        : '不限制每 Key 频率',
    }),
    el('span', {
      class: 'muted',
      text: `失败冷却 ${stepMin} 分钟 × 连续失败次数，第 ${s.disableAfterFails} 次禁用 ${recoverH} 小时`,
    }),
  );
}

function renderChannelCards() {
  const host = $('#channelCards');
  const cards = state.channels.map((c) => {
    const sel = state.filterChannel === c.name;
    return el('div', {
      class: `channel-card${sel ? ' is-selected' : ''}`,
      onclick: () => {
        state.filterChannel = state.filterChannel === c.name ? '' : c.name;
        renderChannelCards();
        syncFilterSelect();
        loadKeys().catch((e) => toast(e.message, 'err'));
      },
    }, [
      el('div', { class: 'cc-top' }, [
        el('span', { class: 'cc-name', text: c.displayName }),
        el('span', {
          class: c.enabled ? 'pill pill-ok' : 'pill pill-idle',
          text: c.enabled ? '启用' : '停用',
        }),
      ]),
      el('div', { class: 'cc-id', text: c.name }),
      el('div', { class: 'cc-url', text: c.baseUrl, title: c.baseUrl }),
      el('div', { class: 'cc-meta' }, [
        el('span', {}, ['Key ', el('b', { text: String(c.keyCount) })]),
        el('span', {}, ['启用 ', el('b', { text: String(c.keyEnabledCount) })]),
        el('span', { class: 'muted', text: c.adapter }),
      ]),
    ]);
  });
  host.replaceChildren(...cards);
}

function renderChannelSelects() {
  const chOpts = () => state.channels.map((c) => el('option', { value: c.name, text: `${c.displayName}（${c.name}）` }));

  for (const id of ['#keyFilterChannel', '#probeChannel', '#probeModelChannel', '#stateFilterChannel']) {
    const sel = $(id);
    if (!sel) continue;
    const cur = sel.value;
    // #probeChannel 是「模式A · 测整个渠道」的必选目标，不能有空选项
    const required = id === '#probeChannel';
    sel.replaceChildren(...(required ? [] : [el('option', { value: '', text: '全部渠道' })]), ...chOpts());
    sel.value = cur && [...sel.options].some((o) => o.value === cur) ? cur : (required ? (sel.options[0]?.value ?? '') : '');
  }
  syncFilterSelect();
}

function syncFilterSelect() {
  const sel = $('#keyFilterChannel');
  if (sel) sel.value = state.filterChannel || '';
}

function renderKeyTable() {
  const tbody = $('#keyTbody');
  const empty = $('#keyEmpty');
  const title = $('#keyPanelTitle');

  const rows = state.keys;
  title.textContent = state.filterChannel
    ? `Key 列表 · ${state.channels.find((c) => c.name === state.filterChannel)?.displayName || state.filterChannel}`
    : `Key 列表 · 全部渠道`;

  if (!rows.length) {
    tbody.replaceChildren();
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  tbody.replaceChildren(...rows.map((k) => {
    const lastOkPill = k.lastOk === null
      ? el('span', { class: 'pill pill-idle', text: '未测' })
      : k.lastOk
        ? el('span', { class: 'pill pill-ok', text: '通过' })
        : el('span', { class: 'pill pill-err', text: '失败', title: k.lastError || '' });

    return el('tr', {}, [
      el('td', { class: 'uuid-cell' }, [
        el('span', { text: k.uuid, title: k.uuid }),
      ]),
      el('td', { text: k.name || '—' }),
      el('td', {}, [el('span', { class: 'pill pill-accent', text: k.channelDisplay || k.channel })]),
      el('td', { text: String(k.priority) }),
      el('td', { text: String(k.weight) }),
      el('td', {}, [runtimeStateCell(k)]),
      el('td', {}, [recentRateCell(k)]),
      el('td', {}, [
        el('span', { class: k.enabled ? 'pill pill-ok' : 'pill pill-idle', text: k.enabled ? '启用' : '停用' }),
      ]),
      el('td', {}, [
        el('div', { style: 'display:flex;align-items:center;gap:6px' }, [
          lastOkPill,
          el('span', { class: 'muted', text: k.lastChecked ? fmtAgo(k.lastChecked) : '—' }),
        ]),
      ]),
      el('td', { class: 'col-actions' }, [
        el('button', {
          class: 'btn btn-sm', type: 'button', text: '编辑',
          onclick: () => editKeyDialog(k),
        }),
        document.createTextNode(' '),
        el('button', {
          class: 'btn btn-sm', type: 'button', text: '重置',
          title: '清除该 Key 的冷却 / 禁用 / 限速状态',
          onclick: async () => {
            try {
              await api.resetKey(k.uuid);
              toast(`已重置 ${k.uuid}`, 'ok');
              await loadKeys();
            } catch (e) { toast(e.message, 'err'); }
          },
        }),
        document.createTextNode(' '),
        el('button', {
          class: 'btn btn-sm btn-danger', type: 'button', text: '删除',
          onclick: () => removeKey(k),
        }),
      ]),
    ]);
  }));
}

/**
 * ⭐ 「近期成功率」单元格（2026-10-07 用户要求「统计一下成功率」）。
 *
 * 口径：后端 dailySummaryByKey 给出的**窗口内**（默认 3 天）成功/失败计数，
 *   rate = ok / (ok + fail)。**没被调用过不算 0%** —— 那是"无数据"，不是"差"，
 *   否则新绑的 Key 一上来就显示 0% 会被误判成坏 Key。
 *
 * 颜色阈值：≥95% 绿 / ≥70% 黄 / 其余红。
 */
function recentRateCell(k) {
  const ok = k.recentOk || 0;
  const fail = k.recentFail || 0;
  const total = ok + fail;

  if (!total) {
    return el('div', { class: 'state-cell' }, [
      el('span', { class: 'pill pill-idle', text: '无数据' }),
      el('span', { class: 'muted', text: '窗口内未被调用' }),
    ]);
  }

  const rate = ok / total;
  const pct = (rate * 100).toFixed(rate >= 0.995 || rate === 0 ? 0 : 1);
  const cls = rate >= 0.95 ? 'pill-ok' : rate >= 0.7 ? 'pill-warn' : 'pill-err';

  return el('div', { class: 'state-cell' }, [
    el('div', { class: 'state-line' }, [
      el('span', { class: `pill ${cls}`, text: `${pct}%` }),
      el('span', {
        class: 'muted',
        text: `${ok} 成功 / ${fail} 失败`,
        title: `统计窗口内（默认最近 ${state.scheduler?.noSuccessDays ?? 3} 天）`,
      }),
    ]),
    k.noSuccess
      ? el('div', { class: 'last-model' }, [
        el('span', { class: 'pill pill-err', text: '调用过但零成功' }),
      ])
      : null,
  ]);
}

/**
 * 「运行状态」单元格。
 *
 * 语义（用户要求）：显示 **正常 / 冷却中 剩余多久 / 已禁用**。
 * 另外把每 Key RPM 限速也一并展示 —— 它同样是"此刻能不能用"的一部分。
 * 优先级：人工停用 > 自动禁用 > 冷却中 > 限速中 > 正常。
 *
 * ⭐ 2026-10-07 用户要求：「冷却中 要显示最后调用什么模型」——
 *    因为冷却本身不说明问题，**是哪个模型把它打挂的**才是排查线索。
 */
function runtimeStateCell(k) {
  const box = el('div', { class: 'state-cell' });

  if (!k.enabled) {
    box.replaceChildren(el('span', { class: 'pill pill-idle', text: '已停用' }));
    return box;
  }

  const remaining = k.remainingMs || 0;
  const cd = el('span', {
    class: 'muted mono',
    'data-countdown-until': remaining > 0 ? String(k.untilAt) : null,
    text: remaining > 0 ? fmtCountdown(remaining) : '',
  });

  // 「最后调用的模型」小行 —— 冷却/禁用时一定显示（这是排查的钥匙）
  const lastModelNode = () => {
    if (!k.lastModel) return null;
    return el('div', { class: 'last-model' }, [
      el('span', { class: 'muted', text: '最后调用 ' }),
      el('span', {
        class: k.lastModelBad ? 'pill pill-warn mono' : 'pill pill-idle mono',
        text: k.lastModel,
        title: k.lastModelAt ? `最后调用于 ${fmtAgo(k.lastModelAt)}` : k.lastModel,
      }),
      k.lastModelAt
        ? el('span', { class: 'muted', text: ` · ${fmtAgo(k.lastModelAt)}` })
        : null,
    ]);
  };

  if (k.state === 'DISABLED') {
    box.replaceChildren(
      el('div', { class: 'state-line' }, [
        el('span', { class: 'pill pill-err', text: '已禁用' }),
        remaining > 0
          ? el('span', { class: 'muted', text: '剩余' })
          : el('span', { class: 'muted', text: '已到期' }),
        cd,
        el('span', {
          class: 'muted',
          text: `· 连续失败 ${k.failStreak} 次，到期自动恢复`,
        }),
      ]),
      lastModelNode(),
    );
    return box;
  }

  if (k.state === 'COOLDOWN') {
    box.replaceChildren(
      el('div', { class: 'state-line' }, [
        el('span', { class: 'pill pill-warn', text: '冷却中' }),
        el('span', { class: 'muted', text: '剩余' }),
        cd,
        el('span', {
          class: 'muted',
          text: k.failStreak > 1 ? `· 连续失败 ${k.failStreak} 次` : '· 成功一次即恢复',
        }),
      ]),
      lastModelNode(),
    );
    return box;
  }

  if (k.rpmLimited) {
    const rpmCd = el('span', { class: 'muted mono', text: fmtCountdown(k.rpmRemainingMs || 0) });
    box.replaceChildren(
      el('div', { class: 'state-line' }, [
        el('span', { class: 'pill pill-info', text: '限速中' }),
        el('span', { class: 'muted', text: `本轮已用 ${k.rpmUsed}/${k.rpmLimit}，` }),
        rpmCd,
        el('span', { class: 'muted', text: '后轮换' }),
      ]),
      lastModelNode(),
    );
    return box;
  }

  box.replaceChildren(
    el('div', { class: 'state-line' }, [
      el('span', { class: 'pill pill-ok', text: '正常' }),
      k.rpmLimit > 0
        ? el('span', { class: 'muted mono', text: `本轮 ${k.rpmUsed}/${k.rpmLimit}` })
        : el('span', {}),
      k.failStreak > 0
        ? el('span', { class: 'muted', text: `· 失败 ${k.failStreak} 次未清零` })
        : el('span', {}),
    ]),
    lastModelNode(),
  );
  return box;
}

async function removeKey(k) {
  const ok = await confirmDialog('删除 Key', `确认删除 uuid = "${k.uuid}"？此操作不可撤销。`);
  if (!ok) return;
  try {
    await api.deleteKey(k.uuid);
    toast('已删除', 'ok');
    await loadKeys();
    await loadChannels();
  } catch (e) {
    toast(e.message, 'err');
  }
}

/** 加 Key 对话框 */
export function addKeyDialog(presetChannel = '') {
  const chSel = el('select', { class: 'input' },
    state.channels.map((c) => el('option', { value: c.name, text: `${c.displayName}（${c.name}）` })));
  if (presetChannel) chSel.value = presetChannel;

  const uuidIn = el('input', { class: 'input', placeholder: '外部系统传入的唯一标识', autocomplete: 'off' });
  const nameIn = el('input', { class: 'input', placeholder: '可留空', autocomplete: 'off' });
  const keyIn = el('input', { class: 'input', placeholder: 'sk-...', autocomplete: 'off' });

  openModal({
    title: '添加 Key',
    bodyNode: [
      field('渠道', chSel),
      field('uuid', uuidIn, '必填，全局唯一。同渠道内相同密钥也会被拒绝。'),
      field('名称', nameIn, '可空，便于辨认'),
      field('密钥', keyIn, '明文不会落盘，使用 AES-256-GCM 加密存储'),
    ],
    okText: '添加',
    onOk: async () => {
      if (!uuidIn.value.trim()) { toast('uuid 必填', 'warn'); return false; }
      if (!keyIn.value.trim()) { toast('密钥必填', 'warn'); return false; }
      const res = await api.addKey({
        channel: chSel.value,
        uuid: uuidIn.value.trim(),
        name: nameIn.value.trim() || null,
        key: keyIn.value.trim(),
      });
      toast(`已添加 ${res.key.uuid}`, 'ok');
      await loadKeys();
      await loadChannels();
    },
  });
}

/** 批量导入 */
export function bulkKeyDialog(presetChannel = '') {
  const chSel = el('select', { class: 'input' },
    state.channels.map((c) => el('option', { value: c.name, text: `${c.displayName}（${c.name}）` })));
  if (presetChannel) chSel.value = presetChannel;

  const ta = el('textarea', {
    class: 'input',
    placeholder: '每行一个，格式：uuid<TAB或逗号或空格>密钥[<TAB>名称]\n例如：\nu001,sk-abc123,小号1\nu002,sk-def456',
  });

  openModal({
    title: '批量导入 Key',
    bodyNode: [
      field('渠道', chSel),
      field('Key 列表', ta, '支持逗号 / Tab / 空格分隔。名称可选。'),
    ],
    okText: '导入',
    onOk: async () => {
      const lines = ta.value.split('\n').map((l) => l.trim()).filter(Boolean);
      if (!lines.length) { toast('没有可导入的内容', 'warn'); return false; }
      const items = lines.map((line, i) => {
        const parts = line.split(/[,\t]+|\s{2,}/).map((s) => s.trim()).filter(Boolean);
        if (parts.length === 1) {
          // 只给了密钥 —— 自动生成 uuid
          return { uuid: `auto-${Date.now()}-${i}`, key: parts[0] };
        }
        return { uuid: parts[0], key: parts[1], name: parts[2] || null };
      });
      const res = await api.bulkAddKeys(chSel.value, items);
      if (res.failCount === 0) toast(`全部导入成功（${res.okCount} 条）`, 'ok');
      else toast(`成功 ${res.okCount} 条，失败 ${res.failCount} 条`, 'warn', 5000);
      await loadKeys();
      await loadChannels();
    },
  });
}

/** 编辑 Key */
function editKeyDialog(k) {
  const nameIn = el('input', { class: 'input', value: k.name || '' });
  const priIn = el('input', { class: 'input', type: 'number', value: String(k.priority) });
  const wIn = el('input', { class: 'input', type: 'number', value: String(k.weight), min: '1' });
  const enSel = el('select', { class: 'input' }, [
    el('option', { value: '1', text: '启用' }),
    el('option', { value: '0', text: '停用' }),
  ]);
  enSel.value = k.enabled ? '1' : '0';

  openModal({
    title: `编辑 ${k.uuid}`,
    bodyNode: [
      field('名称', nameIn),
      field('优先级', priIn, '数值大的优先被选中；高优先级桶打满才降级'),
      field('权重', wIn, '同优先级内按权重做平滑加权轮询'),
      field('状态', enSel),
    ],
    okText: '保存',
    onOk: async () => {
      await api.patchKey(k.uuid, {
        name: nameIn.value.trim(),
        priority: Number(priIn.value) || 0,
        weight: Number(wIn.value) || 1,
        enabled: enSel.value === '1',
      });
      toast('已保存', 'ok');
      await loadKeys();
    },
  });
}

export function initKeysView() {
  $('#keyFilterChannel').addEventListener('change', (e) => {
    state.filterChannel = e.target.value;
    renderChannelCards();
    loadKeys().catch((err) => toast(err.message, 'err'));
  });
  $('#btnAddKey').addEventListener('click', () => addKeyDialog(state.filterChannel));
  $('#btnBulkKey').addEventListener('click', () => bulkKeyDialog(state.filterChannel));
}

export function getChannels() {
  return state.channels;
}

export default {
  loadChannels, loadKeys, initKeysView, addKeyDialog, bulkKeyDialog,
  getChannels, selectedChannel,
};
