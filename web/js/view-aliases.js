/**
 * 视图：模型。
 *
 * 三块内容，主次分明：
 *   ① 下游可用模型 —— 上游目录 + 映射叠加后，下游 /v1/models 实际能看到的东西
 *   ② 上游模型目录 —— 各渠道 GET /models 拉回来的原始清单（按渠道分组）
 *   ③ 额外映射     —— 可选的改名层，不影响"有哪些模型"
 */
import api from './api.js';
import {
  $, el, fmtAgo, toast, openModal, closeModal, field, confirmDialog,
} from './ui.js';
import { getChannels } from './view-keys.js';

const state = {
  aliases: [],
  downstream: [],
  upstreamGroups: [],
  synonyms: [],
};

export async function loadAliases() {
  const [a, m, u, s] = await Promise.all([
    api.listAliases(),
    api.models(),
    api.upstreamModels ? api.upstreamModels() : Promise.resolve({ groups: [] }),
    api.synonyms ? api.synonyms() : Promise.resolve({ synonyms: [] }),
  ]);
  state.aliases = a.aliases || [];
  state.downstream = m.models || [];
  state.upstreamGroups = u.groups || [];
  state.synonyms = s.synonyms || [];
  render();
  renderCatalog();
  renderAliases();
  renderSynonyms();
}

/* ---------------- ① 下游可用模型 ---------------- */

function render() {
  const tbody = $('#downstreamTbody');
  const empty = $('#downstreamEmpty');
  if (!tbody) return;
  const rows = state.downstream;

  if (!rows.length) {
    tbody.replaceChildren();
    if (empty) empty.hidden = false;
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
      el('button', { class: 'btn btn-sm', type: 'button', text: '测试可用性', onclick: () => testAvailabilityDialog(m) }),
      document.createTextNode(' '),
      el('button', { class: 'btn btn-sm', type: 'button', text: '测试指纹', onclick: () => testFingerprintDialog(m) }),
    ]),
  ])));
}

/* ---------------- 行操作：拉黑 / 测可用性 / 测指纹 ---------------- */

/** 该模型可用的 (原始渠道, 原始上游模型名) 目标 */
function targetsOf(m) {
  return (m.targets || []).filter((t) => t && t.channel && t.upstream);
}

function pickTargetDialog(title, m, intro, onPick) {
  const targets = targetsOf(m);
  if (!targets.length) { toast('这个模型没有可用的渠道目标（可能全被拉黑了）', 'warn'); return; }

  const list = el('div', { style: 'display:flex;flex-direction:column;gap:6px' });
  const nodes = targets.map((t) => el('button', {
    class: 'btn', type: 'button',
    style: 'justify-content:flex-start;text-align:left',
    text: `${t.channel}  ×  ${t.upstream}`,
    onclick: () => { closeModal(true); onPick(t); },
  }));
  list.replaceChildren(...nodes);

  openModal({ title, bodyNode: [el('p', { class: 'muted', style: 'font-size:12.5px', text: intro }), list], okText: '取消', cancelText: '关闭' });
}

function banModelDialog(m) {
  if (!targetsOf(m).length) { toast('没有可拉黑的渠道目标', 'warn'); return; }
  pickTargetDialog('拉黑模型（选择渠道）', m,
    '拉黑的是「原始渠道名 + 原始上游模型名」。该组合将不再出现在下游模型清单、也不再被尝试。', (t) => {
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

function testAvailabilityDialog(m) {
  if (!targetsOf(m).length) { toast('没有可测试的渠道目标', 'warn'); return; }
  pickTargetDialog('测试可用性（选择渠道）', m,
    '会把这个 (渠道, 模型) 在该渠道的**所有 Key** 上各打一次（每个 Key 默认 10 秒超时）。'
    + '全部失败会自动拉黑；可在「后台任务管理」看进度。', (t) => {
      const toIn = el('input', { class: 'input', type: 'number', value: '10', min: '3' });
      const bgIn = el('input', { class: 'input', type: 'checkbox' });
      const bgWrap = el('label', { style: 'display:flex;align-items:center;gap:8px;font-size:13px' }, [
        bgIn, el('span', { text: '放到后台跑（推荐，可在「后台任务管理」看进度）' }),
      ]);
      openModal({
        title: `测试可用性：${t.channel} / ${t.upstream}`,
        bodyNode: [field('每个 Key 超时（秒）', toIn, '默认 10 秒'), bgWrap],
        okText: '开始',
        onOk: async () => {
          const timeoutSec = Math.max(3, Number(toIn.value) || 10);
          if (bgIn.checked) {
            await api.enqueueProbe({ channel: t.channel, model: t.upstream, timeoutMs: timeoutSec * 1000 });
            toast('已提交后台任务（可在「后台任务管理」查看）', 'ok', 5000);
          } else {
            toast('正在测试，请稍候…', 'info', 2500);
            const r = await api.probeModel({ channel: t.channel, model: t.upstream, timeoutMs: timeoutSec * 1000 });
            toast(r.allFailed ? `全部 ${r.total} 个 Key 失败${r.banned ? '，已自动拉黑' : ''}` : `${r.okCount}/${r.total} 个 Key 成功`, r.allFailed ? 'warn' : 'ok', 6000);
            await loadAliases();
          }
        },
      });
    });
}

function testFingerprintDialog(m) {
  const in_ = el('input', { class: 'input', value: m.id, autocomplete: 'off' });
  const apiSel = el('select', { class: 'input' }, [
    el('option', { value: 'cc', text: 'Chat Completions' }),
    el('option', { value: 'responses', text: 'Responses' }),
    el('option', { value: 'message', text: 'Anthropic Messages' }),
  ]);
  openModal({
    title: '测试模型指纹',
    bodyNode: [
      field('模型名（网关对外名即可）', in_, '会用 lm-detector 让模型写随机数，识别背后真实模型'),
      field('协议', apiSel, '多数渠道用 Chat Completions'),
    ],
    okText: '后台测试',
    onOk: async () => {
      const model = in_.value.trim();
      if (!model) { toast('模型名必填', 'warn'); return false; }
      try {
        await api.enqueueFingerprint({ model, api: apiSel.value });
        toast('已提交指纹测试任务，请到「指纹测试」页或「后台任务管理」看结果', 'ok', 6000);
      } catch (e) { toast(e.message, 'err', 6000); return false; }
    },
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
  const chans = getChannels().filter((c) => c.enabled);
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
