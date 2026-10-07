/**
 * 视图：测活。
 * 两种模式：整渠道（GET /models）/ 指定模型（POST chat, max_tokens=1）。
 */
import api from './api.js';
import { $, el, fmtMs, toast, errClassLabel } from './ui.js';
import { getChannels } from './view-keys.js';

function renderResults(res) {
  const panel = $('#probeResultPanel');
  const tbody = $('#probeTbody');
  const summary = $('#probeSummary');

  panel.hidden = false;
  summary.textContent = `${res.probe || ''} · 共 ${res.total} 项，通过 ${res.okCount}，失败 ${res.failCount}`;

  const rows = (res.results || []).map((r) => {
    const [clsText, clsPill] = errClassLabel(r.errClass);
    const resultPill = r.ok
      ? el('span', { class: 'pill pill-ok', text: '✓ 通过' })
      : el('span', { class: 'pill pill-err', text: '✗ 失败' });
    return el('tr', {}, [
      el('td', {}, [el('span', { class: 'pill pill-accent', text: r.channelDisplay || r.channel || '—' })]),
      el('td', { class: 'uuid-cell', text: r.uuid || '—', title: r.keyName || '' }),
      el('td', {}, [resultPill]),
      el('td', { text: r.httpStatus ? String(r.httpStatus) : '—' }),
      el('td', { text: fmtMs(r.latencyMs) }),
      el('td', {}, [
        el('div', { style: 'display:flex;gap:6px;align-items:center;flex-wrap:wrap' }, [
          el('span', { class: `pill ${clsPill}`, text: clsText }),
          r.error ? el('span', { class: 'muted', text: r.error.slice(0, 120), title: r.error }) : null,
        ]),
      ]),
    ]);
  });

  if (!rows.length) {
    tbody.replaceChildren(el('tr', {}, [el('td', { colspan: '6', class: 'empty', text: '没有结果' })]));
  } else {
    tbody.replaceChildren(...rows);
  }
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function setBusy(btn, busy, textWhileBusy) {
  if (busy) {
    btn.dataset._text = btn.textContent;
    btn.textContent = textWhileBusy;
    btn.disabled = true;
  } else {
    btn.textContent = btn.dataset._text || btn.textContent;
    btn.disabled = false;
  }
}

export function initProbeView() {
  const btnChannel = $('#btnProbeChannel');
  const btnModel = $('#btnProbeModel');

  btnChannel.addEventListener('click', async () => {
    const channel = $('#probeChannel').value;
    if (!channel) { toast('请先选择渠道', 'warn'); return; }
    setBusy(btnChannel, true, '测活中…');
    try {
      const res = await api.checkChannel(channel);
      renderResults(res);
      toast(`测活完成：通过 ${res.okCount} / ${res.total}`, res.failCount ? 'warn' : 'ok');
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      setBusy(btnChannel, false);
    }
  });

  btnModel.addEventListener('click', async () => {
    const model = $('#probeModel').value.trim();
    if (!model) { toast('请填写模型名', 'warn'); return; }
    const channel = $('#probeModelChannel').value || null;
    setBusy(btnModel, true, '测活中…');
    try {
      const res = await api.checkModel(model, channel);
      renderResults(res);
      toast(`测活完成：通过 ${res.okCount} / ${res.total}`, res.failCount ? 'warn' : 'ok');
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      setBusy(btnModel, false);
    }
  });
}

export default { initProbeView };
