/**
 * 视图：设置（token 管理 / 访问说明 / 运行参数）。
 *
 * ⚠️ 「模型黑名单」的开关与明细**不在这里** —— 用户 2026-10-08 明确要求它
 *    是**独立导航页**（`view-blacklist.js` / `#view-blacklist`）。
 *    本页只留「只接快速模型」这一类运行设置。
 */
import api, { getToken, setToken } from './api.js';
import { $, el, fmtTime, fmtAgo, toast, openModal, field, confirmDialog } from './ui.js';

export async function loadSettings() {
  renderTokenInput();
  renderRunConfig();
  if (!getToken()) {
    renderTokens([]);
    renderToggles(null);
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
}

/**
 * 运行开关 —— 目前只有「只接快速模型」。
 * （模型黑名单的两个开关已挪到独立的「模型黑名单」导航页。）
 */
function renderToggles(res) {
  const host = $('#settingsBody');
  if (!host) return;

  if (!res) {
    host.replaceChildren(el('div', { class: 'muted', text: '登录后可见' }));
    return;
  }

  const on = !!res.settings?.fastModelsOnly;

  host.replaceChildren(
    toggleRow({
      label: '只接快速模型',
      hint: '对目录严重虚胖的渠道（如 NVIDIA：80 个模型里真能用的个位数，其余 404/410/挂死），'
        + '拉取目录时只收录实测可用的快速模型。默认打开。'
        + '（该渠道未收录的模型会**自动拉黑**，见「模型黑名单」页）',
      on,
      onText: '已开启',
      offText: '已关闭',
      patch: { fastModelsOnly: !on },
      toastOn: '已开启：只接快速模型（并拉黑该渠道未收录的模型）',
      toastOff: '已关闭：收录该渠道全部模型（并解除"快速模式"拉黑）',
      extra: fastInfo(res),
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
