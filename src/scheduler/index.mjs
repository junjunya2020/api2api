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
 *   - ⭐ **模型级健康度闸门**（2026-10-07 新增）：
 *       坏的是「模型」不是「Key」—— 某个模型持续 429 时，
 *       换 Key 打同一模型照样失败。因此模型健康度独立成三级：
 *       NORMAL / DEGRADED / UNAVAILABLE，**不惩罚 Key**。
 *
 * 明确不做：配额/额度窗口推测、quota budget 软降级（用户确认不需要）。
 */
import { candidatesForChannel } from '../db/keys.mjs';
import {
  reviveExpired, recordSuccess, recordFailure, setCurrentWeight, getState,
} from '../db/state.mjs';
import {
  ModelState, getModelHealth, recordModelSuccess, recordModelFailure, reviveExpired as reviveModels,
} from '../db/model-health.mjs';
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
 * ⭐ 本渠道这次请求允许尝试的**最大 Key 数**（熔断预算）。
 *
 * 用户要求（2026-10-07）：「最多尝试四分之一的号，不然一直切换 key 重试全死了」
 *
 * 目的：某个模型持续失败时，**别把一个几十把的池子打穿**。
 * 所以预算是**上限**，不是"必须正好四分之一"。
 *
 * ⚠️ 但必须有**下限**，否则小池子会被卡死：
 *   商汤只有 3 把 Key 时 ceil(3/4) = 1 → 只试 1 把就放弃 →
 *   **连"换 Key"都做不到**，一个偶发 429 就把整条渠道跳过。
 *   这是真实回归（e2e 三条用例因此失败），所以下限取 `channelCircuitMin`
 *   （默认 2 = 至少能换一把 Key），且**不超过池子本身的规模**。
 *
 * 最终 = clamp(ceil(可用Key数 / fraction),  [下限],  maxAttemptsPerChannel,  可用Key数)
 *
 * 例：3 把 → clamp(1, 2, 8, 3) = 2       （能换一次 Key）
 *     8 把 → clamp(2, 2, 8, 8) = 2
 *     11 把 → clamp(3, 2, 8, 11) = 3
 *     40 把 → clamp(10, 2, 8, 40) = 8    （尊重用户的硬上限）
 *     1 把 → clamp(1, 1, 8, 1)  = 1      （单 Key 渠道仍可用）
 *
 * 为什么按"**可用** Key 数"而不是"全部 Key 数"：大部分 Key 在冷却时，
 * 分母跟着变小才不会把剩下那两把也烧掉 —— 熔断的本质是"别把池子打穿"。
 *
 * @param {number} availableCount 该渠道当前**可用**（非冷却/禁用）的 Key 数
 */
export function channelBudget(availableCount) {
  const frac = Number(config.channelCircuitFraction);
  const hard = Number(config.maxAttemptsPerChannel) > 0 ? Number(config.maxAttemptsPerChannel) : Infinity;
  const avail = Number.isFinite(availableCount) && availableCount > 0 ? Math.floor(availableCount) : 1;

  // 未启用熔断（fraction<=1）→ 只看硬上限，但仍然不能超过池子规模
  if (!Number.isFinite(frac) || frac <= 1) return Math.max(1, Math.min(hard, avail));

  const circuit = Math.ceil(avail / frac);
  // 下限夹取：至少 1，且不超过池子规模（1 把 Key 不可能试 2 次）
  const floor = Math.min(Math.max(1, Number(config.channelCircuitMin) || 1), avail);
  return Math.max(1, Math.min(Math.max(circuit, floor), hard, avail));
}

/**
 * ⭐ 模型级闸门 —— 决定某 (渠道, 模型) 这次请求**能不能试、值得试几次**。
 *
 *   NORMAL       → 正常参与，attempts = 渠道熔断预算
 *   DEGRADED     → 参与但**排到候选末尾**，且只允许 **1 次**尝试（快速证伪）
 *   UNAVAILABLE  → **跳过**（除非调用方显式要求兜底）
 *
 * 关键：这一层与 Key 无关。坏模型不会连累 Key 池 —— 用户明确要求
 * 「ban 的话只 ban 模型，不 ban key」。
 *
 * ⭐ DEGRADED 也可能是**内置规则预置**的（见 db/model-rules.mjs）：
 *    "上游就是喜欢 429"的模型首次出现就直接降级观察，
 *    不必先烧一批 Key 才学到。规则只影响初值，成功一次即回 NORMAL。
 *
 * @param {string} channelName 渠道名（内置规则按渠道名匹配；可空）
 * @returns {{ allow:boolean, attempts:number, state:string, reason:string|null, fromRule:boolean }}
 */
export function modelGate(channelId, model, { fallback = false, channelName = null } = {}) {
  reviveModels();
  const h = getModelHealth(channelId, model, Date.now(), channelName);
  const fromRule = !!h.fromRule;
  if (h.state === ModelState.UNAVAILABLE) {
    // 兜底场景（该模型全渠道都不可用）才允许试一次，否则直接跳过
    return {
      allow: !!fallback,
      attempts: fallback ? 1 : 0,
      state: h.state,
      reason: h.reason || '模型连续失败已标记不可用',
      fromRule,
    };
  }
  if (h.state === ModelState.DEGRADED) {
    return {
      allow: true, attempts: 1, state: h.state,
      reason: h.reason || '模型降级观察中，仅试 1 次',
      fromRule,
    };
  }
  return { allow: true, attempts: 0, state: h.state, reason: null, fromRule }; // 0 = 用渠道预算
}

/**
 * 记一次模型级成功 —— 立刻回 NORMAL（成功即恢复健康）。
 * 内置规则预置的 DEGRADED 也在这里被清除（运行时事实优先于静态规则）。
 */
export function applyModelSuccess(channelId, model, channelName = null) {
  recordModelSuccess(channelId, model, channelName);
}

/**
 * 记一次模型级失败 —— 累计到阈值就降级/标不可用。
 *
 * ⚠️ 只有**真的代表"这个模型不行"**的错误才计入：
 *   - QUOTA��持续 429 —— 用户原话「有些模型上游就是喜欢429」）
 *   - CONFIG_FAULT（该渠道真没有这个模型；非 chat 端点的画图模型在仓储层豁免）
 *   - TRANSIENT（连续抖动说明这个模型确实不稳）
 *
 * ⚠️ **不计入**：
 *   - REQUEST_FAULT —— 请求体问题，换模型也一样错，不是模型的锅
 *   - **AUTH** —— 这是 **Key 自己死了**（密钥无效/过期），换任何模型都一样。
 *              把 AUTH 算在模型头上会**连坐**：一把死 Key 打过的所有模型
 *              都会被标降级 —— 这正是用户要避免的"误伤"。
 *              AUTH 的正确归宿是 Key 侧的递增冷却直到禁用（见 decideAction）。
 *   - OK —— 成功不算失败
 */
export function applyModelFailure(channelId, model, errClass, errorMsg, channelName = null) {
  if (errClass === ErrClass.REQUEST_FAULT || errClass === ErrClass.OK) return null;
  if (errClass === ErrClass.AUTH) return null;   // Key 的问题，不是模型的
  return recordModelFailure(channelId, model, errClass, errorMsg, channelName);
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
 *
 * ⭐ 2026-10-07 重要语义变更（用户明确要求「ban 的话只 ban 模型，不 ban key」）：
 *
 *   原先所有失败（QUOTA/AUTH/TRANSIENT）都走同一套"线性递增冷却"，
 *   结果是**一个坏模型就能把整个 Key 池子烧穿** ——
 *   每把 Key 打同一个坏模型都失败，各自 +10 分钟冷却，几十把 Key 全灭。
 *   用户原话：「不然一直切换 key 重试全死了」「不然全池子死了」。
 *
 *   新的归因规则（**Key 只在能确定是 Key 自己的问题时才受罚**）：
 *
 *   | 错误分类        | Key 动作                    | 模型健康度 |
 *   |----------------|----------------------------|-----------|
 *   | AUTH            | **递增冷却**（Key 真死了）  | 不计入     |
 *   | QUOTA / TRANSIENT | **软冷却**（短、不累加）   | +1        |
 *   | CONFIG_FAULT    | 跳过本渠道（不罚 Key）      | 不计入     |
 *   | REQUEST_FAULT   | 无（换谁都白搭）            | 不计入     |
 *
 *   理由：
 *     · **AUTH** 是最典型的"Key 本身坏了"（无效/过期），换模型也一样，
 *       所以让它走递增冷却直到禁用 —— 这是唯一该 ban Key 的场景。
 *       反过来，Key 真坏时不该污染模型健康度（否则一把死 Key 会连坐所有模型）。
 *     · **QUOTA 429** 绝大多数是上游侧限流，且常是**模型级**的。
 *       给 Key 一个**短的软冷却**（默认 60s，不累加 streak）让它先让位，
 *       真正的判定交给模型健康度 —— 累计到阈值就 ban 模型。
 *     · **模型健康度跨 Key 累计**：要让一个模型被 ban，必须**多把不同的 Key
 *       都打不通它**。这天然实现了"多把 Key 都失败才算模型坏"，
 *       而不是"一把 Key 倒霉就封模型"。
 *
 * @returns {{ action:'cooldown'|'soft'|'disable'|'none'|'skip_channel', nextRetryAt:number|null,
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

  // ⭐ 只有 AUTH：Key 本身确定有问题 → 递增冷却直到禁用（唯一该 ban Key 的场景）
  if (errClass === ErrClass.AUTH) {
    const streak = prevFailStreak + 1;
    if (streak >= config.disableAfterFails) {
      return { action: 'disable', nextRetryAt: null, retry: true, streak, cooldownMs: 0 };
    }
    return {
      action: 'cooldown',
      nextRetryAt: Date.now() + cooldownFor(streak),
      retry: true,
      streak,
      cooldownMs: cooldownFor(streak),
    };
  }

  // ⭐ QUOTA / TRANSIENT / 其它：**模型侧的问题**，Key 只做短暂让位。
  //    软冷却**不累加 fail_streak** —— 否则一个坏模型连打 10 次就能把 Key 禁用。
  //    真正的"banned"落在模型健康度上（见 applyModelFailure）。
  const softMs = Math.max(0, Number(config.keySoftCooldownMs) || 0);
  if (softMs <= 0) return none(true);
  return {
    action: 'soft',
    nextRetryAt: Date.now() + softMs,
    retry: true,
    streak: prevFailStreak,          // 保持不变
    cooldownMs: softMs,
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

export { ErrClass, RETRYABLE, FATAL_FOR_REQUEST, FATAL_FOR_CHANNEL, ModelState };
export default {
  pickKey, selectSmoothWRR, selectFillFirst, decideAction, cooldownFor,
  applyFailure, applySuccess, channelBudget, modelGate,
  applyModelSuccess, applyModelFailure,
};
