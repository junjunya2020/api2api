/**
 * Web UI 入口。
 * 负责：tab 切换、健康检查、各视图懒加载。
 */
import api, { getToken } from './api.js';
import { $, $$, initModal, toast } from './ui.js';
import keysView from './view-keys.js';
import aliasesView from './view-aliases.js';
import channelsView from './view-channels.js';
import probeView from './view-probe.js';
import statsView from './view-stats.js';
import blacklistView from './view-blacklist.js';
import settingsView from './view-settings.js';

/** 视图注册表：名称 → 加载函数 */
const views = {
  keys: async () => {
    await keysView.loadChannels();
    await keysView.loadKeys();
  },
  aliases: async () => {
    if (!keysView.getChannels().length) await keysView.loadChannels();
    await aliasesView.loadAliases();
  },
  channels: async () => {
    await channelsView.loadChannels();
  },
  probe: async () => {
    if (!keysView.getChannels().length) await keysView.loadChannels();
  },
  stats: async () => {
    if (!keysView.getChannels().length) await keysView.loadChannels();
    // 模型健康度面板的渠道筛选 —— 复用已加载的渠道列表
    const sel = document.querySelector('#mhFilterChannel');
    if (sel && !sel.options.length) {
      const chans = keysView.getChannels();
      for (const c of chans) {
        const o = document.createElement('option');
        o.value = c.name;
        o.textContent = `${c.displayName}（${c.name}）`;
        sel.appendChild(o);
      }
    }
    await statsView.loadStats();
  },
  blacklist: async () => {
    await blacklistView.loadBlacklist();
  },
  settings: async () => {
    await settingsView.loadSettings();
  },
};

let currentView = 'keys';
let loading = false;

async function switchView(name) {
  if (loading) return;
  loading = true;
  currentView = name;

  for (const tab of $$('#tabs .tab')) {
    tab.classList.toggle('is-active', tab.dataset.view === name);
  }
  for (const v of $$('.view')) {
    v.classList.toggle('is-active', v.id === `view-${name}`);
  }

  // 设置页永远要渲染 —— 它是唯一的登录入口（token 输入框在这里）。
  // 若此处提前 return，就会出现「因为没登录所以看不到登录框」的死锁。
  if (name === 'settings') {
    try {
      await views.settings();
    } catch (e) {
      toast(e.message || '加载设置失败', 'err');
    } finally {
      loading = false;
    }
    return;
  }

  if (!getToken()) {
    toast('未设置 token。请到「设置」页填入服务端 data/admin_token 的内容。', 'warn', 6000);
    loading = false;
    return switchView('settings');
  }

  try {
    const fn = views[name];
    if (fn) await fn();
  } catch (e) {
    if (e.status === 401) {
      toast('token 无效或已失效，请到「设置」页重新填写', 'err', 6000);
      if (name !== 'settings') return switchView('settings');
    } else {
      toast(e.message || '加载失败', 'err');
    }
  } finally {
    loading = false;
  }
}

async function refresh() {
  await switchView(currentView);
  toast('已刷新', 'ok', 1400);
}

async function checkHealth() {
  const pill = $('#healthPill');
  try {
    const r = await api.health();
    pill.className = r.ok ? 'pill pill-ok' : 'pill pill-warn';
    pill.textContent = r.ok ? '服务正常' : '状态异常';
  } catch {
    pill.className = 'pill pill-err';
    pill.textContent = '无法连接';
  }
}

function initTabs() {
  for (const tab of $$('#tabs .tab')) {
    tab.addEventListener('click', () => switchView(tab.dataset.view));
  }
}

function main() {
  initModal();
  initTabs();
  keysView.initKeysView();
  aliasesView.initAliasesView();
  channelsView.initChannelsView();
  probeView.initProbeView();
  statsView.initStatsView();
  blacklistView.initBlacklistView();
  settingsView.initSettingsView();

  $('#btnRefresh').addEventListener('click', refresh);

  checkHealth();
  setInterval(checkHealth, 30_000);

  switchView('keys');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', main);
} else {
  main();
}
