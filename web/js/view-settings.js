/**
 * 视图：设置（token 管理 / 访问说明 / 运行参数 / 调度与黑名单开关）。
 */
import api, { getToken, setToken } from './api.js';
import { $, el, fmtTime, fmtAgo, toast, openModal, field, confirmDialog } from './ui.js';

export async function loadSettings() {
  renderTokenInput();
  renderRunConfig();
  if (!getToken()) {
    renderTokens([]);
    renderToggles(null);
    renderBlacklistPanel(null);
    return;
  }
  try {
    const res = await api.tokens();
    renderTokens(res.tokens || []);
  } catch (e) {
    toast(e.message, 'err');
  }
  let settingsRes = null;
  try {
    settingsRes = await api.settings();
  } catch (e) { /* 下面按 null 渲染 */ }
  renderToggles(settingsRes);
  renderBlacklistPanel(settingsRes);
}

/**
 * ⭐ 总开关区（两部分）：
 *   ① 只接快速模型（2026-10-07）
 *   ② 模型黑名单（2026-10-08）—— 总开关 + 是否自动加入
 * 改了**立即生效**（落 meta 表，无需重启）。
 */
function renderToggles(res) {
  const host = $('#settingsBody');
  if (!host) return;

  if (!res) {
    host.replaceChildren(el('div', { class: 'muted', text: '登录后可见' }));
    return;
  }

  const on = !!res.settings?.fastModelsOnly;
  const bkOn = !!res.settings?.blacklistEnabled;
  const autoOn = !!res.settings?.autoBlacklistEnabled;

  host.replaceChildren(
    toggleRow({
      key: 'fastModelsOnly',
      label: '只接快速模型',
      hint: '对目录严重虚胖的渠道（如 NVIDIA：80 个模型里真能用的个位数，其余 404/410/挂死），'
        + '拉取目录时只收录实测可用的快速模型。默认打开。（该渠道未收录的模型会自动拉黑）',
      on,
      onText: '已开启',
      offText: '已关闭',
      patch: { fastModelsOnly: !on },
      toastOn: '已开启：只接快速模型（并拉黑该渠道未收录的模型）',
      toastOff: '已关闭：收录该渠道全部模型（并解除"快速模式"拉黑）',
      extra: fastInfo(res),
    }),
    el('hr', { style: 'border:none;border-top:1px solid var(--border);margin:16px 0' }),
    toggleRow({
      key: 'blacklistEnabled',
      label: '是否开启模型黑名单',
      hint: '总开关。黑名单里的 (原始渠道 × 原始上游模型) 会被**从下游模型清单里隐藏**，'
        + '且转发时**一次请求都不会发**。关闭后只保留记录、不产生任何拦截。',
      on: bkOn,
      onText: '已开启',
      offText: '已关闭',
      patch: { blacklistEnabled: !bkOn },
      toastOn: '已开启模型黑名单',
      toastOff: '已关闭模型黑名单（仅保留记录，不再拦截）',
    }),
    el('hr', { style: 'border:none;border-top:1px solid var(--border);margin:16px 0' }),
    toggleRow({
      key: 'autoBlacklistEnabled',
      label: '连续失败自动加入黑名单',
      hint: `某 (渠道, 模型) **从未成功过**且累计失败 ≥ ${res.settings?.autoBanAfterFails ?? 10} 次时，`
        + '自动把它加入黑名单（不再尝试、不再列出）。'
        + '⚠️ 只要成功过 1 次就不会被自动拉黑 —— 高失败率的模型交给「模型健康度」的自动熔断（会自己恢复）。',
      on: autoOn,
      onText: '已开启',
      offText: '已关闭',
      patch: { autoBlacklistEnabled: !autoOn },
      toastOn: '已开启：连续失败（从未成功）自动加入黑名单',
      toastOff: '已关闭：不再自动加入黑名单',
    }),
  );
}

function fastInfo(res) {
  const wrap = el('div', { style: 'margin-top:10px' });
  const chs = res.fast?.channels || [];
  const models = res.fast?.models || [];
  if (chs.length) {
    wrap.replaceChildren(
      el('div', { class: 'muted', style: 'font-size:12.5px', text: `快速渠道：${chs.join('、')}` }),
      el('pre', { class: 'codeblock', text: models.join('\n') }),
    );
  }
  return wrap;
}

/** 一行开关：左文案 + 右按钮 */
function toggleRow({ label, hint, on, onText, offText, patch, toastOn, toastOff, extra }) {
  const btn = el('button', {
    class: on ? 'btn btn-primary' : 'btn',
    type: 'button',
    text: on ? onText : offText,
    onclick: async () => {
      try {
        const r = await api.patchSettings(patch);
        toast(r.settings?.[Object.keys(patch)[0]] ? toastOn : toastOff, 'ok');
        await loadSettings();
      } catch (e) { toast(e.message, 'err'); }
    },
  });
  return el('div', { style: 'display:flex;justify-content:space-between;align-items:flex-start;gap:16px' }, [
    el('div', { style: 'flex:1' }, [
      el('div', { style: 'font-weight:500;margin-bottom:4px', text: label }),
      el('div', { class: 'field-hint', text: hint }),
      extra || null,
    ]),
    btn,
  ]);
}

/**
 * ⭐ 模型黑名单面板（用户 2026-10-08）。
 *
 * 「之前确定用不了的模型就直接拉黑了 **让用户能看到 为什么拉黑**」
 * 所以列表里每条都必须带**原因**（reason）与**来源**（内置 / 自动 / 手动 / 快速模式）。
 * 键 = 原始渠道名 + 原始上游模型名（不是对外名 / 不是转换后的名字）。
 */
async function renderBlacklistPanel(res) {
  const host = $('#blacklistBody');
  if (!host) return;

  if (!res) {
    host.replaceChildren(el('div', { class: 'muted', text: '登录后可见' }));
    return;
  }

  let data;
  try {
    data = await api.blacklist();
  } catch (e) {
    host.replaceChildren(el('div', { class: 'muted', text: `读取黑名单失败：${e.message}` }));
    return;
  }
  const rows = data.banned || [];

  const addBtn = el('button', {
    class: 'btn btn-sm', type: 'button', text: '+ 手动加入',
    onclick: () => addBanDialog(),
  });
  const syncBtn = el('button', {
    class: 'btn btn-sm', type: 'button', text: '重算「快速模式」拉黑',
    onclick: async () => {
      try {
        const r = await api.syncFastBans();
        toast(`已重算：新增 ${r.added ?? 0} / 移除 ${r.removed ?? 0}`, 'ok');
        await renderBlacklistPanel(res);
      } catch (e) { toast(e.message, 'err'); }
    },
  });

  const head = el('div', {
    style: 'display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:10px',
  }, [
    el('span', { class: 'muted', style: 'font-size:12.5px', text: `共 ${rows.length} 条 ·（原始渠道名 + 原始上游模型名）` }),
    el('div', { style: 'display:flex;gap:8px' }, [syncBtn, addBtn]),
  ]);

  if (!rows.length) {
    host.replaceChildren(head, el('div', { class: 'muted', style: 'font-size:12.5px', text: '黑名单为空。' }));
    return;
  }

  const table = el('table', { class: 'table' }, [
    el('thead', {}, [el('tr', {}, [
      el('th', { text: '渠道（原始）' }), el('th', { text: '模型（原始上游名）' }),
      el('th', { text: '来源' }), el('th', { text: '失败/成功' }),
      el('th', { text: '为什么拉黑' }), el('th', { class: 'col-actions', text: '操作' }),
    ])]),
    el('tbody', {}, rows.map((b) => el('tr', {}, [
      el('td', {}, [el('span', { class: 'pill pill-idle', text: `${b.channelDisplay}（${b.channel}）` })]),
      el('td', {}, [el('span', { class: 'uuid-cell', text: b.model })]),
      el('td', {}, [el('span', { class: sourcePill(b.source), text: b.sourceLabel })]),
      el('td', { class: 'muted', text: `${b.failCount ?? 0} / ${b.okCount ?? 0}` }),
      el('td', { style: 'max-width:420px;font-size:12px;line-height:1.5', text: b.reason || '—' }),
      el('td', { class: 'col-actions' }, [
        el('button', {
          class: 'btn btn-sm', type: 'button', text: '解禁',
          onclick: () => unban(b),
        }),
      ]),
    ]))),
  ]);

  host.replaceChildren(head, el('div', { class: 'table-wrap' }, [table]));
}

function sourcePill(source) {
  switch (source) {
    case 'builtin': return 'pill-err';
    case 'auto': return 'pill-warn';
    case 'fast-mode': return 'pill-idle';
    default: return 'pill-accent';
  }
}

async function unban(b) {
  const ok = await confirmDialog('解除拉黑',
    `确认解除「${b.channel} / ${b.model}」的拉黑？\n解除后它会重新参与路由（若确实是坏的，连续失败会自动再拉黑）。`);
  if (!ok) return;
  try {
    await api.unbanModel(b.channel, b.model);
    toast('已解禁', 'ok');
    await loadSettings();
  } catch (e) { toast(e.message, 'err'); }
}

function addBanDialog() {
  const chSel = el('select', { class: 'input' }, [
    el('option', { value: '', text: '（请选择渠道）' }),
  ]);
  api.channels().then((r) => {
    for (const c of r.channels || []) {
      chSel.append(el('option', { value: c.name, text: `${c.displayName}（${c.name}）` }));
    }
  }).catch(() => {});

  const modelList = el('datalist', { id: 'banModelHints' });
  const modelInBound = el('input', {
    class: 'input', placeholder: '原始上游模型名，例如 deepseek-v4-pro',
    autocomplete: 'off', list: 'banModelHints',
  });
  // 选渠道后把该渠道的上游模型名灌进 datalist
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

  const reasonIn = el('input', { class: 'input', placeholder: '为什么拉黑（用户可见）', autocomplete: 'off' });

  openModal({
    title: '手动加入黑名单',
    bodyNode: [
      modelList,
      field('渠道（原始渠道名）', chSel, '拉黑的是「渠道 × 原始上游模型名」，不是对外名'),
      field('模型（原始上游名）', modelInBound, '下游用到的对外名不受影响，只影响这条渠道上的这个上游模型'),
      field('原因', reasonIn, '会展示给用户，说明为什么拉黑'),
    ],
    okText: '加入黑名单',
    onOk: async () => {
      if (!chSel.value) { toast('请选择渠道', 'warn'); return false; }
      if (!modelInBound.value.trim()) { toast('模型名必填', 'warn'); return false; }
      await api.banModel({
        channel: chSel.value,
        model: modelInBound.value.trim(),
        reason: reasonIn.value.trim() || '手动加入',
      });
      toast('已加入黑名单', 'ok');
      await loadSettings();
    },
  });
}

function renderTokenInput() {
  const current = getToken();
  const input = el('input', {
    class: 'input', type: 'text', value: current,
    placeholder: 'sk-api2api-...',
    autocomplete: 'off',
  });
  const status = el('span', {
    class: current ? 'pill pill-ok' : 'pill pill-warn',
    text: current ? '已设置' : '未设置',
  });

  const save = el('button', {
    class: 'btn btn-primary', type: 'button', text: '保存到本机浏览器',
    onclick: () => {
      setToken(input.value.trim());
      toast('已保存，刷新页面生效', 'ok');
      setTimeout(() => location.reload(), 600);
    },
  });

  const clear = el('button', {
    class: 'btn', type: 'button', text: '清除',
    onclick: () => {
      setToken('');
      toast('已清除', 'ok');
      setTimeout(() => location.reload(), 600);
    },
  });

  const host = $('#tokenInputHost');
  if (!host) return;
  host.replaceChildren(...[
    field('当前使用的 token', input, '首次部署时明文写在服务端 /opt/api2api/data/admin_token'),
    el('div', { style: 'display:flex;gap:9px;align-items:center;margin-bottom:14px' }, [status, save, clear]),
  ]);
}

/** 运行参数 */
function renderRunConfig() {
  const host = $('#configBody');
  if (!host) return;
  host.replaceChildren(...[
    ['监听地址', '0.0.0.0:3210'],
    ['单次最大尝试次数', '12'],
    ['上游超时', '120 秒'],
    ['存储', 'SQLite（node:sqlite，WAL）'],
    ['依赖', '零第三方依赖'],
  ].map(([k, v]) => el('div', { style: 'display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--border)' }, [
    el('span', { class: 'muted', text: k }),
    el('span', { style: 'font-weight:500;font-family:var(--mono);font-size:12.5px', text: v }),
  ])));
}

function renderTokens(tokens) {
  const tbody = $('#tokenTbody');
  if (!tokens.length) {
    tbody.replaceChildren(el('tr', {}, [el('td', { colspan: '6', class: 'empty', text: '暂无 token' })]));
    return;
  }
  tbody.replaceChildren(...tokens.map((t) => el('tr', {}, [
    el('td', { text: t.name || '—' }),
    el('td', { class: 'uuid-cell', text: t.hashPrefix + '…' }),
    el('td', {}, [el('span', { class: t.enabled ? 'pill pill-ok' : 'pill pill-idle', text: t.enabled ? '启用' : '停用' })]),
    el('td', { class: 'muted', text: fmtTime(t.createdAt) }),
    el('td', { class: 'muted', text: t.lastUsedAt ? fmtAgo(t.lastUsedAt) : '从未使用' }),
    el('td', { class: 'col-actions' }, [
      el('button', {
        class: 'btn btn-sm btn-danger', type: 'button', text: '删除',
        onclick: () => removeToken(t),
      }),
    ]),
  ])));
}

async function removeToken(t) {
  if (!t.name) { toast('无名 token 无法按名字删除', 'warn'); return; }
  const ok = await confirmDialog('删除 Token', `确认删除 token「${t.name}」？使用它的客户端将立即失效。`);
  if (!ok) return;
  try {
    await api.deleteToken(t.name);
    toast('已删除', 'ok');
    await loadSettings();
  } catch (e) { toast(e.message, 'err'); }
}

function newTokenDialog() {
  const nameIn = el('input', { class: 'input', placeholder: '例如：我的笔记本', autocomplete: 'off' });
  const outBox = el('div');

  openModal({
    title: '新建下游 Token',
    bodyNode: [
      field('名称', nameIn, '便于识别用途'),
      outBox,
    ],
    okText: '生成',
    onOk: async () => {
      const res = await api.newToken(nameIn.value.trim() || null);
      outBox.replaceChildren(
        el('div', { class: 'field-hint', style: 'margin-top:8px;color:var(--err);font-weight:500', text: '⚠ 明文只显示这一次，请立即复制保存' }),
        el('pre', { class: 'codeblock', text: res.token }),
        el('button', {
          class: 'btn btn-sm', type: 'button', text: '复制',
          onclick: () => navigator.clipboard?.writeText(res.token)
            .then(() => toast('已复制', 'ok')).catch(() => toast('复制失败，请手动选中', 'warn')),
        }),
      );
      await loadSettings();
      return false; // 保持对话框打开，让用户复制
    },
  });
}

export function initSettingsView() {
  $('#btnNewToken').addEventListener('click', () => newTokenDialog());
}

export default { loadSettings, initSettingsView };
