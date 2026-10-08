/**
 * 视图：模型。
 *
 *   ① 下游可用模型 —— 上游目录 + 映射叠加后，下游 /v1/models 实际能看到的东西
 *      ⭐ 两种视图（用户 2026-10-08）：
 *         · 「全部合并」= 不按渠道分，同一模型合并成一行（名字去重）
 *         · 「按渠道」  = 按渠道分组显示，**只列该渠道的模型**；
 *                        此模式下"拉黑/测试"都**只作用于该渠道**，不会牵连别家
 *   ② 上游模型目录 —— 各渠道 GET /models 拉回来的原始清单（按渠道分组）
 *   ③ 额外映射     —— 可选的改名层
 */
import api from './api.js';
import {
  $, el, fmtAgo, toast, openModal, closeModal, field, confirmDialog,
} from './ui.js';
import { openJobModal } from './view-jobs.js';
import { getChannels } from './view-keys.js';

const LS_MODE = 'a2a.models.mode';      // 'merged' | 'channel'
const LS_CH = 'a2a.models.channel';     // 选中的渠道名

const state = {
  aliases: [],
  downstream: [],
  upstreamGroups: [],
  synonyms: [],
  channels: [],          // [{name, displayName}]
  mode: localStorage.getItem(LS_MODE) || 'merged',
  channel: localStorage.getItem(LS_CH) || null,
};

export async function loadAliases() {
  const [a, m, u, s, ch] = await Promise.all([
    api.listAliases(),
    api.models(),
    api.upstreamModels ? api.upstreamModels() : Promise.resolve({ groups: [] }),
    api.synonyms ? api.synonyms() : Promise.resolve({ synonyms: [] }),
    api.channels ? api.channels() : Promise.resolve({ channels: [] }),
  ]);
  state.aliases = a.aliases || [];
  state.downstream = m.models || [];
  state.upstreamGroups = u.groups || [];
  state.synonyms = s.synonyms || [];
  state.channels = (ch.channels || []).map((c) => ({ name: c.name, displayName: c.displayName || c.name }));
  if (!state.channel || !state.channels.some((c) => c.name === state.channel)) {
    state.channel = state.channels[0]?.name || null;
  }
  renderModeBar();
  render();
  renderCatalog();
  renderAliases();
  renderSynonyms();
}

/* ---------------- 视图模式：全部合并 / 按渠道 ---------------- */

function renderModeBar() {
  const host = $('#modelModeBar');
  if (!host) return;
  const mk = (mode, label) => el('button', {
    class: 'btn btn-sm' + (state.mode === mode ? ' btn-primary' : ''),
    type: 'button', text: label,
    onclick: () => { state.mode = mode; localStorage.setItem(LS_MODE, mode); renderModeBar(); render(); },
  });
  const sel = el('select', { class: 'input input-sm' }, state.channels.map((c) => el('option', {
    value: c.name, text: c.displayName, selected: c.name === state.channel,
  })));
  sel.value = state.channel || '';
  sel.addEventListener('change', () => {
    state.channel = sel.value; localStorage.setItem(LS_CH, sel.value); render();
  });

  host.replaceChildren(
    el('span', { class: 'muted', style: 'font-size:12px;margin-right:6px', text: '视图：' }),
    mk('merged', '全部合并'),
    document.createTextNode(' '),
    mk('channel', '按渠道'),
    state.mode === 'channel'
      ? el('span', { style: 'margin-left:10px;display:inline-flex;align-items:center;gap:6px' }, [sel])
      : el('span'),
    state.mode === 'channel'
      ? el('span', { class: 'muted', style: 'font-size:12px;margin-left:10px', text: '只列该渠道的模型；拉黑/测试也只作用于该渠道' })
      : el('span', { class: 'muted', style: 'font-size:12px;margin-left:10px', text: '同名模型合并成一行' }),
  );
}

/** 当前视图下要显示的行（按渠道时只留该渠道的模型，并把 targets 收敛到该渠道） */
function visibleModels() {
  if (state.mode !== 'channel' || !state.channel) return state.downstream;
  const ch = state.channels.find((c) => c.name === state.channel);
  const disp = ch?.displayName || state.channel;
  const hit = (c) => c === disp || c === state.channel;
  const out = [];
  for (const m of state.downstream) {
    const channels = (m.channels || []).filter(hit);
    const targets = (m.targets || []).filter((t) => hit(t.channel));
    if (!channels.length && !targets.length) continue;
    out.push({ ...m, channels: channels.length ? channels : [disp], targets });
  }
  return out;
}

/** 当前视图的模型行对应的 (渠道, 上游模型名) 目标 */
function rowTargets(m) {
  if (state.mode === 'channel' && state.channel) {
    return (m.targets || []).filter((t) => t.channel === state.channel);
  }
  return m.targets || [];
}

/* ---------------- ① 下游可用模型 ---------------- */

function render() {
  const tbody = $('#downstreamTbody');
  const empty = $('#downstreamEmpty');
  if (!tbody) return;
  const rows = visibleModels();

  if (!rows.length) {
    tbody.replaceChildren();
    if (empty) {
      empty.hidden = false;
      empty.textContent = state.mode === 'channel'
        ? '该渠道暂无模型。' : '暂无模型（先去「上游模型目录」拉取）。';
    }
    return;
  }
  if (empty) empty.hidden = true;

  tbody.replaceChildren(...rows.map((m) => el('tr', {}, [
    el('td', {}, [el('span', { class: 'uuid-cell', text: m.id })]),
    el('td', {}, [sourceBadge(m.kind, m.aliasedFrom, m)]),
    el('td', {}, (m.channels || []).length
      ? (m.channels || []).map((c) => el('span', { class: 'pill pill-idle', text: c, style: 'margin-right:4px' }))
      : [el('span', { class: 'muted', text: '—' })]),
    el('td', { class: 'col-actions' }, [
      el('button', { class: 'btn btn-sm', type: 'button', text: '复制',
        onclick: () => navigator.clipboard?.writeText(m.id).then(() => toast(`已复制 ${m.id}`, 'ok')).catch(() => toast('复制失败', 'err')) }),
      document.createTextNode(' '),
      el('button', { class: 'btn btn-sm', type: 'button', text: '拉黑模型', onclick: () => banModelDialog(m) }),
      document.createTextNode(' '),
      // ⭐ 左键 = 立刻开始测（弹实时进度框）；右键 = 设置超时
      el('button', {
        class: 'btn btn-sm', type: 'button', text: '测试可用性', title: '左键：立即测试（实时进度）；右键：设置超时',
        onclick: () => testAvailability(m),
        oncontextmenu: (e) => openTimeoutMenu(e, 'probe'),
      }),
      document.createTextNode(' '),
      el('button', {
        class: 'btn btn-sm', type: 'button', text: '测试指纹', title: '左键：立即测试；右键：设置超时',
        onclick: () => testFingerprint(m),
        oncontextmenu: (e) => openTimeoutMenu(e, 'fingerprint'),
      }),
    ]),
  ])));
}

/* ---------------- 行操作：拉黑 / 测可用性 / 测指纹 ---------------- */

/** 当前视图下该行对应的 (原始渠道, 原始上游模型名) 目标 */
function targetsOf(m) {
  return rowTargets(m).filter((t) => t && t.channel && t.upstream);
}

/** 当前生效的超时（秒）。右键可改，存 localStorage，按"操作类型"记。 */
function timeoutSec(kind) {
  const d = kind === 'fingerprint' ? 120 : 10;
  const v = Number(localStorage.getItem(`a2a.timeout.${kind}`));
  return Number.isFinite(v) && v >= (kind === 'fingerprint' ? 5 : 3) ? v : d;
}
function setTimeoutSec(kind, sec) { localStorage.setItem(`a2a.timeout.${kind}`, String(sec)); }

/** 在当前模型上选一个渠道目标（多于一个时才弹；只有一个直接用） */
function chooseTarget(m, { title, intro }, onPick) {
  const targets = targetsOf(m);
  if (!targets.length) { toast('这个模型没有可用的渠道目标（可能全被拉黑了）', 'warn'); return; }
  if (targets.length === 1) return onPick(targets[0]);

  const list = el('div', { style: 'display:flex;flex-direction:column;gap:6px' }, targets.map((t) => el('button', {
    class: 'btn', type: 'button',
    style: 'justify-content:flex-start;text-align:left',
    text: `${t.channel}  ×  ${t.upstream}`,
    onclick: () => { closeModal(true); onPick(t); },
  })));
  openModal({ title, bodyNode: [el('p', { class: 'muted', style: 'font-size:12.5px', text: intro }), list], okText: '取消', cancelText: '关闭' });
}

/* -------- 左键：立即测试（后台任务 + 实时进度模态框） -------- */

function testAvailability(m) {
  const targets = targetsOf(m);
  if (!targets.length) { toast('没有可测试的渠道目标', 'warn'); return; }
  // ⭐「按渠道」模式下**只测当前渠道**（用户 2026-10-08：不然会牵连别家）
  const spec = (state.mode === 'channel' && state.channel)
    ? { channel: state.channel, model: m.id }
    : (targets.length === 1
      ? { channel: targets[0].channel, model: targets[0].upstream }
      : { model: m.id });   // 全部渠道 → 后端展开成所有渠道
  startProbeJob(spec, spec.channel ? `${m.id} @${spec.channel}` : m.id);
}

async function startProbeJob(spec, label) {
  // 立刻开始（不等任何弹窗）；随后弹实时进度框
  let jr;
  try {
    jr = await api.enqueueProbe({
      ...spec,
      timeoutMs: timeoutSec('probe') * 1000,
    });
  } catch (e) { toast(e.message, 'err', 6000); return; }

  openJobModal({
    title: `测试可用性：${label}（超时 ${timeoutSec('probe')}s/Key）`,
    jobId: jr.job.id,
  });
  toast('已开始测试（关闭进度框也会在后台继续）', 'ok', 4000);
}

function testFingerprint(m) {
  // ⭐「按渠道」模式下指纹也**只走该渠道**（用户 2026-10-08）
  const channel = (state.mode === 'channel' && state.channel) ? state.channel : null;
  startFingerprintJob(m.id, 'cc', channel);
}

async function startFingerprintJob(model, api = 'cc', channel = null) {
  let jr;
  try {
    jr = await api.enqueueFingerprint({ model, api, channel, timeoutSec: timeoutSec('fingerprint') });
  } catch (e) { toast(e.message, 'err', 6000); return; }
  openJobModal({ title: `测试指纹：${channel ? `[${channel}] ` : ''}${model}`, jobId: jr.job.id });
}

/* -------- 右键：设置超时 -------- */

function openTimeoutMenu(e, kind) {
  e.preventDefault();
  e.stopPropagation();
  const isFp = kind === 'fingerprint';
  const cur = timeoutSec(kind);
  const in_ = el('input', { class: 'input', type: 'number', min: isFp ? '5' : '3', value: String(cur) });
  openModal({
    title: `设置${isFp ? '指纹测试' : '可用性测试'}超时`,
    bodyNode: [
      el('p', { class: 'muted', style: 'font-size:12.5px', text: isFp
        ? '指纹要模型写几百个随机数，推理模型会慢一些，建议 120 秒以上。'
        : '每个 Key 等"首字"的最长时间。默认 10 秒。' }),
      field(`${isFp ? '单次' : '每个 Key '}超时（秒）`, in_, '保存后立即用于下一次左键测试'),
    ],
    okText: '保存',
    onOk: () => {
      const v = Number(in_.value);
      if (!Number.isFinite(v) || v < (isFp ? 5 : 3)) { toast('超时太短', 'warn'); return false; }
      setTimeoutSec(kind, v);
      toast(`已设置：${v} 秒`, 'ok');
    },
  });
}

function banModelDialog(m) {
  if (!targetsOf(m).length) { toast('没有可拉黑的渠道目标', 'warn'); return; }
  chooseTarget(m, {
    title: '拉黑模型（选择渠道）',
    intro: '拉黑的是「原始渠道名 + 原始上游模型名」。该组合将不再出现在下游模型清单、也不再被尝试。',
  }, (t) => {
    const reasonIn = el('input', { class: 'input', placeholder: '为什么拉黑（用户可见）', value: '手动拉黑（从模型页）' });
    openModal({
      title: `拉黑 ${t.channel} / ${t.upstream}`,
      bodyNode: [field('原因', reasonIn, '会展示给用户，说明为什么拉黑')],
      okText: '加入黑名单',
      onOk: async () => {
        await api.banModel({ channel: t.channel, model: t.upstream, reason: reasonIn.value.trim() || '手动拉黑' });
        toast('已加入黑名单', 'ok');
        await loadAliases();
      },
    });
  });
}

function sourceBadge(kind, aliasedFrom, m) {
  if (kind === 'alias') {
    return el('span', { class: 'pill pill-accent', text: `改名自 ${aliasedFrom}` });
  }
  if (kind === 'alias-global') {
    return el('span', { class: 'pill pill-accent', text: `全局改名自 ${aliasedFrom}` });
  }
  if (kind === 'synonym') {
    const n = (m?.aliases || []).length;
    return el('span', {
      class: 'pill pill-info',
      text: n ? `归并名（合并了 ${n} 个别名）` : '归并名',
      title: (m?.aliases || []).join('、'),
    });
  }
  return el('span', { class: 'pill pill-ok', text: '上游原名' });
}

/* ---------------- ② 上游模型目录 ---------------- */

function renderCatalog() {
  const host = $('#catalogBody');
  if (!host) return;
  const groups = state.upstreamGroups.filter((g) => g.models?.length || g.enabled);

  if (!groups.length) {
    host.replaceChildren(el('p', { class: 'muted', text: '目录为空。点上方「拉取全部渠道模型」。' }));
    return;
  }

  host.replaceChildren(...groups.map((g) => el('div', { style: 'margin-bottom:16px' }, [
    el('div', {
      style: 'display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap',
    }, [
      el('strong', { text: g.channelDisplay || g.channel }),
      el('span', { class: g.enabled ? 'pill pill-ok' : 'pill pill-idle', text: g.enabled ? '启用' : '停用' }),
      el('span', { class: 'muted', style: 'font-size:12px', text: `${g.models.length} 个模型` }),
      el('span', {
        class: 'muted', style: 'font-size:12px',
        text: g.fetchedAt ? `· 拉取于 ${fmtAgo(g.fetchedAt)}` : '· 尚未拉取',
      }),
      el('button', {
        class: 'btn btn-sm', type: 'button', text: '拉取',
        onclick: () => fetchChannel(g.channel),
      }),
    ]),
    g.models.length
      ? el('div', { class: 'chips' }, g.models.map((m) => el('span', {
        class: 'chip', text: m, title: '点击复制',
        style: 'cursor:pointer',
        onclick: () => {
          navigator.clipboard?.writeText(m)
            .then(() => toast(`已复制 ${m}`, 'ok'))
            .catch(() => {});
        },
      })))
      : el('p', { class: 'muted', style: 'font-size:12px', text: '（未拉取）' }),
  ])));
}

/* ---------------- ③ 额外映射 ---------------- */

function renderAliases() {
  const tbody = $('#aliasTbody');
  const empty = $('#aliasEmpty');
  if (!tbody) return;
  const rows = state.aliases;

  if (!rows.length) {
    tbody.replaceChildren();
    if (empty) empty.hidden = false;
    return;
  }
  if (empty) empty.hidden = true;

  tbody.replaceChildren(...rows.map((a) => el('tr', {}, [
    el('td', {}, [el('span', { class: 'pill pill-accent', text: a.publicName })]),
    el('td', { class: 'uuid-cell', text: a.upstreamName }),
    el('td', {}, [
      a.scope === 'global'
        ? el('span', { class: 'pill pill-info', text: '全局（所有渠道）' })
        : el('span', { class: 'pill pill-idle', text: a.channelDisplay || a.channel }),
    ]),
    el('td', { text: String(a.priority) }),
    el('td', {}, [
      el('span', { class: a.enabled ? 'pill pill-ok' : 'pill pill-idle', text: a.enabled ? '启用' : '停用' }),
    ]),
    el('td', { class: 'col-actions' }, [
      el('button', { class: 'btn btn-sm', type: 'button', text: '编辑', onclick: () => editDialog(a) }),
      document.createTextNode(' '),
      el('button', { class: 'btn btn-sm btn-danger', type: 'button', text: '删除', onclick: () => remove(a) }),
    ]),
  ])));
}

/* ---------------- 拉取 ---------------- */

async function fetchChannel(channel) {
  try {
    const res = await api.fetchUpstreamModels(channel);
    if (!res.ok) { toast(res.error || '拉取失败', 'err'); return; }
    toast(`${channel}: 拉到 ${res.count} 个模型，下游共 ${res.downstreamTotal} 个可用`, 'ok');
    await loadAliases();
  } catch (e) {
    toast(e.message, 'err');
  }
}

async function fetchAll() {
  // 用本页自己加载的渠道列表（不依赖"Key 管理"页是否访问过）
  const chans = state.channels.length ? state.channels : getChannels();
  if (!chans.length) { toast('没有启用的渠道', 'warn'); return; }
  let total = 0;
  const failed = [];
  for (const c of chans) {
    try {
      const res = await api.fetchUpstreamModels(c.name);
      if (res.ok) total += res.count || 0;
      else failed.push(`${c.name}: ${res.error || '失败'}`);
    } catch (e) {
      failed.push(`${c.name}: ${e.message}`);
    }
  }
  await loadAliases();
  if (failed.length) {
    toast(`共拉到 ${total} 个模型；${failed.length} 个渠道失败：${failed.join('；')}`, 'warn', 8000);
  } else {
    const n = state.downstream.length;
    toast(`全部渠道拉取完成，共 ${total} 个模型；下游可用 ${n} 个`, 'ok');
  }
}

/* ---------------- 映射编辑 ---------------- */

export function addAliasDialog() {
  buildAliasModal({});
}

function editDialog(a) {
  buildAliasModal(a);
}

function buildAliasModal(existing) {
  const isEdit = !!existing.id;

  const pubIn = el('input', {
    class: 'input', value: existing.publicName || '',
    placeholder: '下游客户端使用的名字，例如 gpt-4o', autocomplete: 'off', list: 'modelNameHints',
  });
  if (isEdit) pubIn.setAttribute('readonly', 'readonly');

  const upIn = el('input', {
    class: 'input', value: existing.upstreamName || '',
    placeholder: '上游真实模型名，例如 glm-5.2', autocomplete: 'off', list: 'modelNameHints',
  });

  // 上游目录里的模型名做成 datalist 提示，省得手打错
  const hints = [...new Set([
    ...state.downstream.map((m) => m.id),
    ...state.upstreamGroups.flatMap((g) => g.models || []),
  ])];
  const datalist = el('datalist', { id: 'modelNameHints' },
    hints.map((h) => el('option', { value: h })));

  const chSel = el('select', { class: 'input' }, [
    el('option', { value: '', text: '全局（对所有渠道生效）' }),
    ...getChannels().map((c) => el('option', { value: c.name, text: `${c.displayName}（${c.name}）` })),
  ]);
  if (isEdit) {
    chSel.value = existing.channel || '';
    chSel.setAttribute('disabled', 'disabled');
  }

  const priIn = el('input', { class: 'input', type: 'number', value: String(existing.priority ?? 0) });

  openModal({
    title: isEdit ? '编辑映射' : '新建映射（改名）',
    bodyNode: [
      datalist,
      field('对外名', pubIn, isEdit ? '创建后不可修改' : '下游客户端看到的就是这个名字'),
      field('上游名', upIn, '转发到上游时替换成的真实模型名'),
      field('作用范围', chSel, '「全局」= 该名字在任意渠道上都解析到这个上游模型；选具体渠道更精确'),
      field('优先级', priIn, '同名多渠道时的优选顺序'),
    ],
    okText: isEdit ? '保存' : '创建',
    onOk: async () => {
      if (!pubIn.value.trim()) { toast('对外名必填', 'warn'); return false; }
      if (!upIn.value.trim()) { toast('上游名必填', 'warn'); return false; }
      if (isEdit) {
        await api.patchAlias(existing.id, {
          upstream_name: upIn.value.trim(),
          priority: Number(priIn.value) || 0,
        });
      } else {
        await api.addAlias({
          public_name: pubIn.value.trim(),
          upstream_name: upIn.value.trim(),
          channel: chSel.value || null,
          priority: Number(priIn.value) || 0,
        });
      }
      toast(isEdit ? '已保存' : '已创建', 'ok');
      await loadAliases();
    },
  });
}

async function remove(a) {
  const ok = await confirmDialog('删除映射', `确认删除「${a.publicName} → ${a.upstreamName}」？\n删除后下游就不能再用「${a.publicName}」这个名字调用了（上游原名不受影响）。`);
  if (!ok) return;
  try {
    await api.deleteAlias(a.id);
    toast('已删除', 'ok');
    await loadAliases();
  } catch (e) { toast(e.message, 'err'); }
}

async function clearCatalog() {
  const ok = await confirmDialog('清空上游目录', '确认清空全部渠道的上游模型目录？\n清空后下游 /v1/models 会变空，直到你重新拉取。');
  if (!ok) return;
  try {
    await api.clearUpstreamModels();
    toast('目录已清空', 'ok');
    await loadAliases();
  } catch (e) { toast(e.message, 'err'); }
}

/* ---------------- ③b 模型归并（别名 → 规范名） ---------------- */

function renderSynonyms() {
  const tbody = $('#synonymTbody');
  const empty = $('#synonymEmpty');
  if (!tbody) return;
  const rows = state.synonyms;

  if (!rows.length) {
    tbody.replaceChildren();
    if (empty) empty.hidden = false;
    return;
  }
  if (empty) empty.hidden = true;

  tbody.replaceChildren(...rows.map((s) => el('tr', {}, [
    el('td', {}, [el('span', { class: 'uuid-cell', text: s.name })]),
    el('td', {}, [el('span', { class: 'pill pill-accent', text: s.canonical })]),
    el('td', { class: 'muted', text: s.note || '—' }),
    el('td', { class: 'col-actions' }, [
      el('button', { class: 'btn btn-sm btn-danger', type: 'button', text: '删除', onclick: () => removeSynonym(s) }),
    ]),
  ])));
}

export function addSynonymDialog() {
  const nameIn = el('input', {
    class: 'input', placeholder: '别名，例如 DeepSeek-V4-Flash-0731', autocomplete: 'off', list: 'modelNameHints2',
  });
  const canonIn = el('input', {
    class: 'input', placeholder: '规范名，例如 deepseek-v4-flash', autocomplete: 'off', list: 'modelNameHints2',
  });
  const noteIn = el('input', { class: 'input', placeholder: '备注（可选）', autocomplete: 'off' });

  const hints = [...new Set([
    ...state.downstream.map((m) => m.id),
    ...state.synonyms.map((s) => s.canonical),
    ...state.upstreamGroups.flatMap((g) => g.models || []),
  ])];
  const datalist = el('datalist', { id: 'modelNameHints2' }, hints.map((h) => el('option', { value: h })));

  openModal({
    title: '新建模型归并',
    bodyNode: [
      datalist,
      field('别名', nameIn, '要被折叠掉的名字（调用它也会被路由到规范名）'),
      field('归并到（规范名）', canonIn, '下游保留展示的就是这个名字'),
      field('备注', noteIn, '可选，给自己看的说明'),
    ],
    okText: '创建',
    onOk: async () => {
      if (!nameIn.value.trim()) { toast('别名必填', 'warn'); return false; }
      if (!canonIn.value.trim()) { toast('规范名必填', 'warn'); return false; }
      try {
        await api.addSynonym({
          name: nameIn.value.trim(),
          canonical: canonIn.value.trim(),
          note: noteIn.value.trim() || null,
        });
      } catch (e) { toast(e.message, 'err'); return false; }
      toast('已创建归并', 'ok');
      await loadAliases();
    },
  });
}

async function removeSynonym(s) {
  const ok = await confirmDialog('删除归并', `确认删除「${s.name} → ${s.canonical}」？\n删除后「${s.name}」会重新作为一个独立模型名出现在清单里。`);
  if (!ok) return;
  try {
    await api.deleteSynonym(s.name);
    toast('已删除', 'ok');
    await loadAliases();
  } catch (e) { toast(e.message, 'err'); }
}

export function initAliasesView() {
  const btnAll = $('#btnFetchAllModels');
  if (btnAll) btnAll.addEventListener('click', fetchAll);
  const btnAdd = $('#btnAddAlias');
  if (btnAdd) btnAdd.addEventListener('click', () => addAliasDialog());
  const btnClear = $('#btnClearCatalog');
  if (btnClear) btnClear.addEventListener('click', clearCatalog);
  const btnSyn = $('#btnAddSynonym');
  if (btnSyn) btnSyn.addEventListener('click', () => addSynonymDialog());
}

export default { loadAliases, initAliasesView, addAliasDialog, addSynonymDialog };
