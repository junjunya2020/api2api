/**
 * DOM 与展示工具。
 */

export function $(sel, root = document) {
  return root.querySelector(sel);
}

export function $$(sel, root = document) {
  return [...root.querySelectorAll(sel)];
}

/** 创建元素 */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v);
  }
  const list = Array.isArray(children) ? children : [children];
  for (const c of list) {
    if (c === null || c === undefined || c === false) continue;
    node.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

/** HTML 转义，防止注入 */
export function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 时间戳 → 本地可读 */
export function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(Number(ts));
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 相对时间 */
export function fmtAgo(ts) {
  if (!ts) return '—';
  const diff = Date.now() - Number(ts);
  if (diff < 0) return fmtTime(ts);
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s} 秒前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

/** 毫秒 → 可读延迟 */
export function fmtMs(ms) {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/**
 * 毫秒 → 倒计时文案（"8 分 30 秒" / "6 小时 12 分" / "23 小时后"）。
 * 用于显示"冷却中 · 剩余多久"。
 */
export function fmtCountdown(ms) {
  if (ms === null || ms === undefined) return '—';
  const n = Math.max(0, Number(ms));
  if (n < 1000) return '不到 1 秒';
  const s = Math.floor(n / 1000);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs ? `${m} 分 ${rs} 秒` : `${m} 分钟`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return rm ? `${h} 小时 ${rm} 分` : `${h} 小时`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh ? `${d} 天 ${rh} 小时` : `${d} 天`;
}

/**
 * 倒计时自走器（全局单例）。
 *
 * 任何带 `data-countdown-until="<时间戳>"` 的元素，其文本会被每秒刷新为剩余时间。
 * 只改 textContent、不重建 DOM —— 否则用户的鼠标悬停 / 文本选择会被打断。
 *
 * 由 `view-keys` 与 `view-stats` 共用，避免两处各写一份定时器。
 */
let _countdownTimer = null;
export function tickCountdowns() {
  if (_countdownTimer) return;
  _countdownTimer = setInterval(() => {
    const nodes = document.querySelectorAll('[data-countdown-until]');
    if (!nodes.length) {
      // 当前视图没有倒计时 → 停表，不空转。切回时会被再次调用。
      clearInterval(_countdownTimer);
      _countdownTimer = null;
      return;
    }
    const now = Date.now();
    for (const node of nodes) {
      const until = Number(node.dataset.countdownUntil) || 0;
      const left = until - now;
      node.textContent = left > 0 ? fmtCountdown(left) : '即将恢复';
    }
  }, 1000);
}

/** 状态 → 徽标 class */
export function statePillClass(state) {
  switch (state) {
    case 'READY': return 'pill-ok';
    case 'COOLDOWN': return 'pill-warn';
    case 'DISABLED': return 'pill-err';
    default: return 'pill-idle';
  }
}

/** 错误分类 → 中文 + 徽标 */
export function errClassLabel(cls) {
  const map = {
    ok: ['正常', 'pill-ok'],
    quota: ['配额/限流', 'pill-warn'],
    auth: ['密钥无效', 'pill-err'],
    transient: ['上游抖动', 'pill-warn'],
    request_fault: ['请求有误', 'pill-idle'],
    config_fault: ['配置有误', 'pill-idle'],
    no_key: ['无可用 Key', 'pill-err'],
  };
  return map[cls] || [cls || '—', 'pill-idle'];
}

/** 状态码 → 徽标 */
export function statusPill(status) {
  if (!status) return { cls: 'pill-idle', text: '—' };
  if (status >= 200 && status < 300) return { cls: 'pill-ok', text: String(status) };
  if (status === 429) return { cls: 'pill-warn', text: String(status) };
  if (status >= 400 && status < 500) return { cls: 'pill-err', text: String(status) };
  if (status >= 500) return { cls: 'pill-warn', text: String(status) };
  return { cls: 'pill-idle', text: String(status) };
}

/* ---------- toast ---------- */
export function toast(message, kind = 'info', ms = 3200) {
  const host = $('#toasts');
  if (!host) return;
  const cls = kind === 'ok' ? 'toast toast-ok'
    : kind === 'err' ? 'toast toast-err'
      : kind === 'warn' ? 'toast toast-warn' : 'toast';
  const node = el('div', { class: cls, text: message });
  host.append(node);
  setTimeout(() => {
    node.style.transition = 'opacity .2s';
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 220);
  }, ms);
}

/* ---------- 对话框 ---------- */
let modalResolve = null;

export function openModal({ title, bodyNode, okText = '确定', cancelText = '取消', onOk }) {
  const back = $('#modalBackdrop');
  $('#modalTitle').textContent = title;
  const body = $('#modalBody');
  body.replaceChildren(...(Array.isArray(bodyNode) ? bodyNode : [bodyNode]));
  $('#modalOk').textContent = okText;
  $('#modalCancel').textContent = cancelText;
  back.hidden = false;

  return new Promise((resolve) => {
    modalResolve = { resolve, onOk };
  });
}

export function closeModal(result = null) {
  const back = $('#modalBackdrop');
  if (back) back.hidden = true;
  const r = modalResolve;
  modalResolve = null;
  if (r) r.resolve(result);
}

export function initModal() {
  $('#modalClose').addEventListener('click', () => closeModal(null));
  $('#modalCancel').addEventListener('click', () => closeModal(null));
  $('#modalBackdrop').addEventListener('click', (e) => {
    if (e.target === $('#modalBackdrop')) closeModal(null);
  });
  $('#modalOk').addEventListener('click', async () => {
    const cur = modalResolve;
    if (!cur) return;
    if (cur.onOk) {
      try {
        const out = await cur.onOk();
        if (out === false) return; // 校验失败，不关闭
      } catch (e) {
        toast(e.message || '操作失败', 'err');
        return;
      }
    }
    closeModal(true);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#modalBackdrop').hidden) closeModal(null);
  });
}

/** 表单字段工厂 */
export function field(label, inputNode, hint) {
  return el('label', { class: 'field' }, [
    el('span', { class: 'field-label', text: label }),
    inputNode,
    hint ? el('span', { class: 'field-hint', text: hint }) : null,
  ]);
}

export function confirmDialog(title, message) {
  return openModal({
    title,
    bodyNode: el('p', { text: message }),
    okText: '确认',
  });
}

export default {
  $, $$, el, esc, fmtTime, fmtAgo, fmtMs, fmtCountdown, tickCountdowns,
  statePillClass, errClassLabel, statusPill,
  toast, openModal, closeModal, initModal, field, confirmDialog,
};
