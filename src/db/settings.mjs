/**
 * 运行时可切换的设置（落盘 `meta` 表）。
 *
 * 三层优先级：**settings（DB）> env（config）> 代码默认**。
 * 改完**立即生效**（无需重启）—— 用户要求能在控制台点。
 *
 * 目前有：
 *   · fast_models_only      只接快速模型（默认开）
 *   · blacklist_enabled     模型黑名单总开关（默认开）
 *   · auto_blacklist        连续失败自动加入黑名单（默认开）
 *
 * ⚠️ 用独立的 meta key 存储，不污染其它 meta。
 */
import { one, run } from './index.mjs';
import config from '../config.mjs';

const K_FAST = 'fast_models_only';
const K_BLACKLIST = 'blacklist_enabled';
const K_AUTO_BAN = 'auto_blacklist';

function getBool(key, dflt) {
  const row = one('SELECT v FROM meta WHERE k = ?', key);
  if (!row) return dflt;
  return String(row.v) === '1';
}

function setBool(key, on) {
  const v = on ? '1' : '0';
  run('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', key, v);
  return v === '1';
}

/* ---------------- 只接快速模型 ---------------- */

/** 是否只接快速模型。默认取 config（即 env / 代码默认，出厂为「打开」）。 */
export function fastModelsOnly() {
  return getBool(K_FAST, config.fastModelsOnly !== 0);
}

export function setFastModelsOnly(on) {
  return setBool(K_FAST, !!on);
}

/* ---------------- 模型黑名单 ---------------- */

/**
 * 模型黑名单**总开关** —— 关闭时黑名单只记录、不拦截（不隐藏、不发请求拦截）。
 * 默认 **打开**：内置"已确定用不了"的模型默认就该拦住。
 */
export function blacklistEnabled() {
  return getBool(K_BLACKLIST, config.blacklistEnabled !== 0);
}

export function setBlacklistEnabled(on) {
  return setBool(K_BLACKLIST, !!on);
}

/**
 * 是否**自动**把"连续失败且从未成功过"的 (渠道,模型) 加入黑名单。
 * 默认**打开**（用户明确要求「连续失败过多的模型+渠道自动禁用」）。
 */
export function autoBlacklistEnabled() {
  return getBool(K_AUTO_BAN, config.autoBlacklistEnabled !== 0);
}

export function setAutoBlacklistEnabled(on) {
  return setBool(K_AUTO_BAN, !!on);
}

/** 全部设置（给 /api/settings 用） */
export function allSettings() {
  return {
    fastModelsOnly: fastModelsOnly(),
    /** 出厂默认值，便于前端展示"默认打开" */
    fastModelsOnlyDefault: config.fastModelsOnly !== 0,

    blacklistEnabled: blacklistEnabled(),
    blacklistEnabledDefault: config.blacklistEnabled !== 0,

    autoBlacklistEnabled: autoBlacklistEnabled(),
    autoBlacklistEnabledDefault: config.autoBlacklistEnabled !== 0,
    /** 自动拉黑阈值：连续失败多少次且从未成功过 → 自动加入 */
    autoBanAfterFails: config.modelAutoBanAfterFails,
  };
}

export default {
  fastModelsOnly, setFastModelsOnly,
  blacklistEnabled, setBlacklistEnabled,
  autoBlacklistEnabled, setAutoBlacklistEnabled,
  allSettings,
};
