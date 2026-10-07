/**
 * 视图：设置（token 管理 / 访问说明 / 运行参数）。
 */
import api, { getToken, setToken } from './api.js';
import { $, el, fmtTime, fmtAgo, toast, openModal, field, confirmDialog } from './ui.js';

export async function loadSettings() {
  renderTokenInput();
  renderRunConfig();
  if (!getToken()) {
    renderTokens([]);
    return;
  }
  try {
    const res = await api.tokens();
    renderTokens(res.tokens || []);
  } catch (e) {
    toast(e.message, 'err');
  }
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
