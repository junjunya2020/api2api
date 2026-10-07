/**
 * 运行时可切换的设置（落盘 `meta` 表）—— 目前只有「只接快速模型」。
 *
 * 为什么不直接只读 config：用户要求**加一个开关**，意味着要能在控制台点、
 * 改完立即生效（不用 SSH 改 env 再重启）。
 * 三层优先级：**settings（DB）> env（config）> 代码默认**。
 *
 * ⚠️ 用独立的 meta key 存储，不污染其它 meta。
 */
import { one, run } from './index.mjs';
import config from '../config.mjs';

const KEY = 'fast_models_only';

/** 是否只接快速模型。默认取 config（即 env / 代码默认，出厂为「打开」）。 */
export function fastModelsOnly() {
  const row = one('SELECT v FROM meta WHERE k = ?', KEY);
  if (!row) return config.fastModelsOnly !== 0;
  return String(row.v) === '1';
}

/** 设置开关（写入 DB，立即生效，无需重启） */
export function setFastModelsOnly(on) {
  const v = on ? '1' : '0';
  run('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', KEY, v);
  return v === '1';
}

/** 全部设置（给 /api/settings 用） */
export function allSettings() {
  return {
    fastModelsOnly: fastModelsOnly(),
    /** 出厂默认值，便于前端展示"默认打开" */
    fastModelsOnlyDefault: config.fastModelsOnly !== 0,
  };
}

export default { fastModelsOnly, setFastModelsOnly, allSettings };
