/**
 * 视图：渠道优先级。
 *
 * 这是「渠道优先级」的唯一交互入口 —— 一个模型被多渠支持时，
 * 后端按 sort_order 从小到大**分层**尝试：先试完本渠道所有 Key，再降下一个。
 * 所以这个顺序直接决定：商汤优先还是 OpenRouter 优先。
 *
 * 实现：原生 HTML5 拖拽（不引第三方库），本地维护一份顺序，
 * 改动后置「未保存」态，点保存才一次性提交（避免拖一下就发一次请求）。
 */
import api from './api.js';
import { $, el, toast } from './ui.js';

/** 后端返回的渠道快照 */
let channels = [];
/** 本地编辑中的顺序（未保存时才与 channels 不同） */
let draftOrder = [];
/** 是否有未保存的改动 */
let dirty = false;

export async function loadChannels() {
  try {
    const res = await api.channels();
    channels = res.channels || [];
    draftOrder = channels.map((c) => c.name);
    dirty = false;
    renderList();
    renderDetail(res.builtinAdapters || []);
  } catch (e) {
    toast(e.message, 'err');
  }
}

/** 按 draftOrder 取出渠道对象（保证渲染顺序 = 用户看到的顺序） */
function orderedChannels() {
  const byName = new Map(channels.map((c) => [c.name, c]));
  const out = [];
  for (const n of draftOrder) {
    const c = byName.get(n);
    if (c) out.push(c);
  }
  // 兜底：draftOrder 里没有的（理论上不会发生）补在后面
  for (const c of channels) {
    if (!out.includes(c)) out.push(c);
  }
  return out;
}

function renderList() {
  const list = $('#chanList');
  if (!list) return;
  const items = orderedChannels();

  list.replaceChildren(...items.map((c, i) => {
    const li = el('li', {
      class: 'chan-item',
      draggable: 'true',
      dataset: { name: c.name },
    });

    // 序号：显式展示"第几个试"，比单纯拖拽更直观
    const idx = el('span', { class: 'chan-idx', text: String(i + 1) });
    const grip = el('span', { class: 'chan-grip', text: '⠿', title: '拖动调整顺序' });

    const main = el('div', { class: 'chan-main' }, [
      el('div', { class: 'chan-name-row' }, [
        el('span', { class: 'chan-name', text: c.displayName || c.name }),
        el('code', { class: 'chan-slug', text: c.name }),
        c.enabled
          ? el('span', { class: 'pill pill-ok', text: '启用' })
          : el('span', { class: 'pill pill-idle', text: '停用' }),
      ]),
      el('div', { class: 'chan-meta muted' }, [
        el('span', { text: `Key ${c.keyEnabledCount}/${c.keyCount}` }),
        el('span', { text: c.adapter }),
        el('span', { text: c.baseUrl || '' }),
      ]),
    ]);

    const right = el('div', { class: 'chan-right' }, [
      el('span', { class: 'chan-order muted', text: `优先级 ${i + 1}` }),
    ]);

    li.append(grip, idx, main, right);

    // ---- 拖拽 ----
    li.addEventListener('dragstart', (ev) => {
      ev.dataTransfer.effectAllowed = 'move';
      ev.dataTransfer.setData('text/plain', c.name);
      li.classList.add('is-dragging');
    });
    li.addEventListener('dragend', () => {
      li.classList.remove('is-dragging');
      document.querySelectorAll('.chan-item').forEach((x) => x.classList.remove('is-drop-target'));
    });
    li.addEventListener('dragover', (ev) => {
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'move';
      li.classList.add('is-drop-target');
    });
    li.addEventListener('dragleave', () => li.classList.remove('is-drop-target'));
    li.addEventListener('drop', (ev) => {
      ev.preventDefault();
      li.classList.remove('is-drop-target');
      const from = ev.dataTransfer.getData('text/plain');
      moveItem(from, c.name);
    });

    return li;
  }));

  updateSaveButton();
}

/** 把 from 渠道移动到 to 渠道所在位置 */
function moveItem(fromName, toName) {
  if (!fromName || !toName || fromName === toName) return;
  const arr = draftOrder.slice();
  const fi = arr.indexOf(fromName);
  const ti = arr.indexOf(toName);
  if (fi < 0 || ti < 0) return;
  arr.splice(fi, 1);
  arr.splice(ti, 0, fromName);
  draftOrder = arr;
  dirty = true;
  renderList();
}

function updateSaveButton() {
  const btn = $('#btnChannelSave');
  if (btn) {
    btn.disabled = !dirty;
    btn.textContent = dirty ? '保存顺序 *' : '保存顺序';
  }
}

async function save() {
  if (!dirty) return;
  try {
    await api.reorderChannels(draftOrder);
    toast('渠道优先级已保存', 'ok');
    await loadChannels();
  } catch (e) {
    toast(e.message, 'err');
  }
}

function renderDetail(adapters) {
  const host = $('#chanDetail');
  if (!host) return;
  const items = orderedChannels();

  host.replaceChildren(
    el('p', { class: 'muted', style: 'margin:0 0 12px', text:
      '路由规则：按上面的顺序逐个渠道尝试 —— 本渠道的 Key 全部失败（或该渠道没有这个模型）才降级到下一个。'
      + '所有渠道都试完仍失败，才把错误返回给客户端。' }),
    el('div', { class: 'kv-list' }, items.flatMap((c) => [
      el('div', { class: 'kv-row' }, [
        el('span', { class: 'kv-k', text: c.displayName || c.name }),
        el('span', { class: 'kv-v', text: `第 ${items.indexOf(c) + 1} 位 · ${c.keyEnabledCount} 把可用 Key · ${c.adapter}` }),
      ]),
    ])),
    el('p', { class: 'muted', style: 'margin:12px 0 0;font-size:12px', text:
      `已注册适配器：${(adapters || []).join('、') || '—'}` }),
  );
}

export function initChannelsView() {
  const btnSave = $('#btnChannelSave');
  if (btnSave) btnSave.addEventListener('click', save);

  const btnReset = $('#btnChannelReset');
  if (btnReset) {
    btnReset.addEventListener('click', () => {
      draftOrder = channels.map((c) => c.name);
      dirty = false;
      renderList();
      toast('已恢复为服务端顺序', 'ok');
    });
  }
}

export default { loadChannels, initChannelsView };
