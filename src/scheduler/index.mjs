/**
 * 调度器 —— 抄 CLIProxyAPI 的路由骨架，但按用户要求改了策略。
 *
 * 包含：
 *   - 优先级桶：priority 高者优先，桶内空了才降级
 *   - **填满优先**（默认）：总是用排在最前的可用 Key，直到它失败/限速才换下一把
 *   - 平滑加权轮询（可选，`SCHEDULER_POLICY=weighted`）
 *   - 每 Key RPM 软限速（滑动窗口，进程内）
 *   - 冷却队列：**线性递增**冷却（10min × 连续失败次数）
 *   - 状态机：READY / COOLDOWN / DISABLED（24 小时后自动恢复）
 *   - 错误分类驱动的动作决策
 *
 * 明确不做：配额/额度窗口推测、quota budget 软降级（用户确认不需要）。
 */
import { candidatesForChannel } from '../db/keys.mjs';
import {
  reviveExpired, recordSuccess, recordFailure, setCurrentWeight, getState,
} from '../db/state.mjs';
import * as rate from './rate.mjs';
import { ErrClass, RETRYABLE, FATAL_FOR_REQUEST, FATAL_FOR_CHANNEL } from '../util/errors.mjs';
import config from '../config.mjs';
import log from '../util/log.mjs';

/**
 * smooth-WRR 选取（`SCHEDULER_POLICY=weighted` 时使用）。
 * @param {Array<{uuid,priority,weight,currentWeight}>} keys 已按 priority 降序
 * @returns {{picked:object|null, updates:Array<{uuid,cw}>}}
 */
export function selectSmoothWRR(keys) {
  if (!keys.length) return { picked: null, updates: [] };

  let best = null;
  let total = 0;
  const updates = [];

  for (const k of keys) {
    const cw = (k.currentWeight ?? 0) + k.weight;
    total += k.weight;
    k._cw = cw;
    if (!best || cw > best._cw) best = k;
  }
  if (!best) return { picked: null, updates: [] };

  best._cw -= total;
  for (const k of keys) {
    updates.push({ uuid: k.uuid, cw: k._cw });
  }
  return { picked: best, updates };
}

/**
 * 填满优先选取。
 *
 * 语义：**始终用排在最前的那把可用 Key**，榨干它（失败或触到 RPM 上限）才换下一把。
 *   好处：Key 数远多于需求时只会用前几把，剩余 Key 保持"全新"，
 *        冷却/失败计数都集中在少数几把上，观察和运维都简单。
 *
 * RPM 是**软约束**：优先跳过已达上限的 Key；若整桶都达上限，
 * 退而选"最快解除限制"的那把（而不是拒绝服务 —— 单 Key 用户不能因此不可用）。
 *
 * @param {Array} pool 同一优先级的候选（已按 created_at 升序 = 加入顺序）
 * @param {number} now
 */
function selectFillFirst(pool, now) {
  const free = [];
  const limited = [];
  for (const k of pool) {
    if (rate.isLimited(k.uuid, now)) {
      limited.push({ k, wait: rate.retryAfterMs(k.uuid, now) });
    } else {
      free.push(k);
    }
  }
  if (free.length) return { picked: free[0], updates: [] };

  // 整桶都限速：取最快恢复的那把（软约束，保证可用性）
  if (limited.length) {
    limited.sort((a, b) => a.wait - b.wait);
    log.debug(`[sched] 全桶限速，退选 ${limited[0].k.uuid}（还需 ${Math.ceil(limited[0].wait / 1000)}s）`);
    return { picked: limited[0].k, updates: [] };
  }
  return { picked: null, updates: [] };
}

/**
 * 为某渠道挑选下一个可用 Key。
 * @param {string} channelId
 * @param {string} model 上游模型名（状态按 (key, model) 隔离）
 * @param {Set<string>} tried 本次请求已试过的 key uuid，避免重复
 */
export function pickKey(channelId, model, tried = new Set()) {
  reviveExpired();
  const now = Date.now();

  const cands = candidatesForChannel(channelId, model, now)
    .filter((k) => !tried.has(k.uuid));

  if (!cands.length) return null;

  // 优先级桶：按 priority 降序分组，取最高的非空桶
  const buckets = new Map();
  for (const k of cands) {
    if (!buckets.has(k.priority)) buckets.set(k.priority, []);
    buckets.get(k.priority).push(k);
  }
  const topPriority = Math.max(...buckets.keys());
  const pool = buckets.get(topPriority);

  const usePolicy = config.schedulerPolicy === 'weighted' ? 'weighted' : 'fill_first';
  const { picked, updates } = usePolicy === 'weighted'
    ? selectSmoothWRR(pool)
    : selectFillFirst(pool, now);

  if (!picked) return null;

  // 只有 weighted 才需要持久化游标
  for (const u of updates) setCurrentWeight(u.uuid, model, u.cw);

  return picked;
}

/**
 * 计算本次失败后的冷却时长（**线性递增**，用户要求）。
 *
 *   第 1 次失败 → 10 分钟
 *   第 2 次失败 → 20 分钟
 *   …
 *   第 9 次失败 → 90 分钟
 *   第 10 次    → 禁用（不冷却，直接 DISABLED）
 *
 * 「连续失败」= fail_streak，**成功一次立刻归零** —— 所以中间成功过就重新从第 1 次算。
 * 不加抖动：用户要的是可预测的整分钟数，UI 上显示的"剩余多久"才对得上。
 */
export function cooldownFor(streak) {
  const n = Math.max(1, streak);
  return Math.min(config.cooldownStepMs * n, config.cooldownMaxMs);
}

/**
 * 决定某次失败后该怎么做。
 * @returns {{ action:'cooldown'|'disable'|'none'|'skip_channel', nextRetryAt:number|null,
 *            retry:boolean, streak:number, cooldownMs:number }}
 */
export function decideAction(keyUuid, model, errClass, prevFailStreak = 0) {
  const none = (retry) => ({ action: 'none', nextRetryAt: null, retry, streak: prevFailStreak, cooldownMs: 0 });

  if (errClass === ErrClass.OK) return none(false);

  // 请求本身有问题 —— 不换 Key、不换渠道（换谁也白搭），且**不算 Key 的失败**
  if (FATAL_FOR_REQUEST.has(errClass)) return none(false);

  // 「本渠道没这个模型」—— 换 Key 结果一样，不惩罚 Key（不是 Key 的错），直接落下一渠道
  if (FATAL_FOR_CHANNEL.has(errClass)) {
    return { action: 'skip_channel', nextRetryAt: null, retry: true, streak: prevFailStreak, cooldownMs: 0 };
  }

  // 无可用 Key —— 与具体 Key 无关，不动状态
  if (errClass === ErrClass.NO_KEY) return none(true);

  // QUOTA / AUTH / TRANSIENT：**同一套线性冷却**（用户要求"第一次失败冷却10分钟"，
  // 未按错误类型区分 —— 简单可预测优先）。
  const streak = prevFailStreak + 1;

  if (streak >= config.disableAfterFails) {
    return {
      action: 'disable', nextRetryAt: null, retry: true,
      streak, cooldownMs: 0,
    };
  }
  const cooldownMs = cooldownFor(streak);
  return {
    action: 'cooldown',
    nextRetryAt: Date.now() + cooldownMs,
    retry: true,
    streak,
    cooldownMs,
  };
}

/** 应用一次失败结果到状态库 */
export function applyFailure(keyUuid, model, errClass, errorMsg) {
  const prev = getState(keyUuid, model);
  const act = decideAction(keyUuid, model, errClass, prev.fail_streak ?? 0);
  // skip_channel 不改 Key 状态（不是 Key 的问题）
  if (act.action !== 'skip_channel') {
    recordFailure(keyUuid, model, {
      action: act.action, nextRetryAt: act.nextRetryAt,
      streak: act.streak, error: errorMsg,
    });
  }
  log.debug(`[sched] ${keyUuid}/${model} ${errClass} → ${act.action} streak=${act.streak} retry=${act.retry}`);
  return act;
}

/** 应用一次成功 */
export function applySuccess(keyUuid, model) {
  recordSuccess(keyUuid, model);
}

export { ErrClass, RETRYABLE, FATAL_FOR_REQUEST, FATAL_FOR_CHANNEL };
export default {
  pickKey, selectSmoothWRR, selectFillFirst, decideAction, cooldownFor,
  applyFailure, applySuccess,
};
