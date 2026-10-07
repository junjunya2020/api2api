/**
 * 每 Key RPM 限速 —— 进程内滑动窗口。
 *
 * 用户要求（2026-10-07）：
 *   「key 够多尽量 每个 key rpm2」
 * 即：多把 Key 时摊开用，别逮着一把薅；单把 Key 时不能因此不可用。
 *
 * 设计取舍：**不落库**。
 *   - RPM 是"最近 60 秒"的瞬时状态，落库要每次请求写 IO，得不偿失；
 *   - 服务是单进程 systemd 常驻，内存窗口与真实状态一致；
 *   - 重启后窗口清空 = 重新开始计数，这正是重启后应有的语义。
 *
 * 语义：**软约束**。达到上限的 Key 在选取时被降权（排到后面），
 * 但若整个候选池都达上限，仍然照用 —— 否则单 Key 用户会彻底不可用。
 */
import config from '../config.mjs';

/** 滑动窗口长度：1 分钟（RPM 的 R 就是每分钟） */
export const WINDOW_MS = 60_000;

/** uuid → 窗口内命中时间戳数组（升序，只保留最近 60 秒） */
const windows = new Map();

/** 丢弃窗口外的旧记录，返回剩余数组 */
function prune(uuid, now) {
  const w = windows.get(uuid);
  if (!w || !w.length) return [];
  const cutoff = now - WINDOW_MS;
  let i = 0;
  while (i < w.length && w[i] <= cutoff) i++;
  if (i > 0) w.splice(0, i);
  return w;
}

/** 记一次命中（**只在真正要发上游请求时调用**，管理操作不计入） */
export function recordHit(uuid, now = Date.now()) {
  const w = prune(uuid, now);
  w.push(now);
  windows.set(uuid, w);
  return w.length;
}

/** 窗口内已用次数 */
export function usage(uuid, now = Date.now()) {
  return prune(uuid, now).length;
}

/** 当前配置的每 Key 每分钟上限（<=0 表示不限速） */
export function limit() {
  const n = Number(config.keyRpmLimit);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 是否已达上限 */
export function isLimited(uuid, now = Date.now()) {
  const lim = limit();
  if (!lim) return false;
  return usage(uuid, now) >= lim;
}

/**
 * 还要等多久才能再用这把 Key（毫秒）。未达上限返回 0。
 * 需要等最早的第 (已用 - 上限 + 1) 条记录滑出窗口。
 */
export function retryAfterMs(uuid, now = Date.now()) {
  const lim = limit();
  if (!lim) return 0;
  const w = prune(uuid, now);
  if (w.length < lim) return 0;
  const idx = w.length - lim;
  return Math.max(0, w[idx] + WINDOW_MS - now);
}

/** 手动重置某 Key（运维用，与调度状态一起清） */
export function clear(uuid) {
  windows.delete(uuid);
}

/** 清空全部窗口（测试用） */
export function clearAll() {
  windows.clear();
}

/**
 * 批量快照，供管理 API 一次性取全部 Key 的限速状态。
 * @returns {Map<string,{used:number,limit:number,limited:boolean,retryAfterMs:number}>}
 */
export function snapshot(now = Date.now()) {
  const lim = limit();
  const out = new Map();
  for (const uuid of windows.keys()) {
    const used = usage(uuid, now);
    out.set(uuid, {
      used, limit: lim,
      limited: lim > 0 && used >= lim,
      retryAfterMs: lim > 0 && used >= lim ? retryAfterMs(uuid, now) : 0,
    });
  }
  return out;
}

export default { recordHit, usage, limit, isLimited, retryAfterMs, clear, clearAll, snapshot, WINDOW_MS };
