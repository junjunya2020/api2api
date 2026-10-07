/**
 * 「模型级」健康度仓储 —— 粒度 = (渠道 × 上游模型)，**与 Key 无关**。
 *
 * ⭐ 为什么必须有这一层（用户 2026-10-07 明确要求）：
 *
 *   `key_state` 的粒度是 (Key × 模型)，它只能表达"这把 Key 在这个模型上不行"。
 *   但真实的故障常常是「**这个模型**在某渠道就是不行」—— 典型两种：
 *     · 上游对该模型持续 429（用户原话：「有些模型上游就是喜欢429」）
 *     · 该模型压根不在 token plan 里（一打就 403/404）
 *
 *   这时**惩罚 Key 是错的**：换一把 Key 打同一个模型照样失败，
 *   结果是把整个 Key 池子全部烧成冷却 —— 用户原话：
 *     「不然一直切换 key 重试全死了」「不然全池子死了」
 *     「ban的话只ban模型，不ban key」
 *
 * 三级状态机（用户要的「分多级」）：
 *
 *   NORMAL ──连续失败 ≥3──▶ DEGRADED ──继续失败（累计≥6）──▶ UNAVAILABLE
 *      ▲                        │                                │ 24h 后
 *      └────────任何一次成功─────┴────────────────────────────────┘
 *
 *   正常 NORMAL       参与正常调度
 *   降级 DEGRADED     **排到候选末尾**，且本请求只允许试 **1 次**
 *   不可用 UNAVAILABLE **直接跳过**（除非该模型全渠道都不可用，才兜底试）
 *
 * 关键：**计数跨 Key 累计**。
 *   用一把 Key 打一次失败只 +1；要让 fail_streak 涨到 3，
 *   必须是**换了不同 Key 打同一个模型也都失败** —— 这天然实现了
 *   「多把 Key 都打不通才算模型坏」，而不是"一把 Key 倒霉就封模型"。
 */
import { all, one, run } from './index.mjs';
import { initialModelState, isNonChatModel } from './model-rules.mjs';
import config from '../config.mjs';
import log from '../util/log.mjs';

/** 模型健康度三级 */
export const ModelState = {
  NORMAL: 'NORMAL',
  DEGRADED: 'DEGRADED',
  UNAVAILABLE: 'UNAVAILABLE',
};

/** 严重度排序（用于聚合取最坏） */
const SEV = { NORMAL: 0, DEGRADED: 1, UNAVAILABLE: 2 };

const EMPTY = (channelId, model) => ({
  channel_id: channelId, model, state: ModelState.NORMAL,
  fail_streak: 0, total_ok: 0, total_fail: 0,
  cooldown_until: null, disabled_until: null,
  last_ok_at: null, last_error: null, reason: null, updated_at: null,
});

/**
 * 取某渠道某模型当前实际生效的健康度（已剔除到期项）。
 *
 * ⭐ 首次遇到某 (渠道, 模型) 时，用**内置规则**给出初始健康度 ——
 *    这样"上游就是喜欢 429"的模型第一次就不占熔断预算，
 *    而不是先烧一批 Key 才学到。已有行时规则不生效（运行时结论优先）。
 *
 * `channelName` 仅在内置规则匹配时需要（规则按渠道名写，如 'sensenova'）。
 */
export function getModelHealth(channelId, model, now = Date.now(), channelName = null) {
  const row = one(
    'SELECT * FROM model_health WHERE channel_id = ? AND model = ?',
    channelId, String(model),
  );
  if (!row) {
    // 还没有记录 → 问内置规则要初始值
    const seed = channelName ? initialModelState(channelName, model, config) : { state: ModelState.NORMAL, reason: null };
    if (seed.state !== ModelState.NORMAL) {
      return {
        ...EMPTY(channelId, model),
        state: seed.state,
        reason: seed.reason,
        /** 标记这是"规则预置"而非"运行时学到"，UI 可据此区别展示 */
        fromRule: true,
        updated_at: null,
      };
    }
    return { ...EMPTY(channelId, model), fromRule: false };
  }
  return { ...effective(row, now), fromRule: false };
}

/**
 * 把一行记录折算成"当前实际生效"的状态 —— 剔除已到期的降级/不可用。
 *
 * ⚠️ 与 key_state 同样的坑：惰性维护要等下一次调用才跑，
 *    读取侧必须自己判定过期，否则 UI/调度会看到一个其实已经恢复的"不可用"。
 */
function effective(row, now) {
  let state = row.state;

  if (state === ModelState.UNAVAILABLE) {
    // 到期 → 降级观察（**不直接回 NORMAL**）：
    // 直接回 NORMAL 会让一个真的坏模型每 24h 又被全池子试一轮，循环烧 Key。
    // 回到 DEGRADED 让它"只试 1 次"，成功才真正恢复。
    if (row.disabled_until == null || row.disabled_until <= now) {
      state = ModelState.DEGRADED;
    }
  }
  return { ...row, state };
}

/** 惰性维护：把到期的 UNAVAILABLE 降到 DEGRADED，并返回改动行数 */
export function reviveExpired(now = Date.now()) {
  const r = run(`UPDATE model_health
                   SET state = 'DEGRADED', cooldown_until = ?, disabled_until = NULL,
                       reason = '自动恢复观察（24h 到期）', updated_at = ?
                 WHERE state = 'UNAVAILABLE'
                   AND (disabled_until IS NULL OR disabled_until <= ?)`,
  now, now, now);
  const n = r.changes ?? 0;
  if (n) log.info(`[model-health] ${n} 个模型从 UNAVAILABLE 自动降到 DEGRADED 观察`);
  return n;
}

/**
 * 建行时**带上内置规则的初始状态**。
 *
 * ⚠️ 必须这么做，否则规则会被"悄悄抹掉"：
 *   若这里只插默认 NORMAL，那 `recordModelFailure` 里先 ensureRow 再读，
 *   读到的是刚建的 NORMAL 行 → 内置规则给的 DEGRADED 初值丢失 →
 *   熔断预算立刻从 1 次变回全量，规则等于没生效。
 */
function ensureRow(channelId, model, channelName = null) {
  const seed = channelName
    ? initialModelState(channelName, model, config)
    : { state: ModelState.NORMAL, reason: null };
  run(`INSERT INTO model_health (channel_id, model, state, reason, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(channel_id, model) DO NOTHING`,
  channelId, String(model), seed.state, seed.reason, Date.now());
}

/**
 * 记一次**成功** —— 模型健康度立刻回到 NORMAL，连续失败清零。
 *
 * 语义上与 key_state 一致：**成功一次即恢复健康**。
 * 这是"模型其实没问题、刚才只是上游抖动"的兜底 —— 不能因为历史失败次数
 * 让一个正在正常出字的模型一直被降级。
 */
export function recordModelSuccess(channelId, model, channelName = null) {
  ensureRow(channelId, model, channelName);
  const now = Date.now();
  run(`UPDATE model_health
         SET state='NORMAL', fail_streak=0, cooldown_until=NULL, disabled_until=NULL,
             total_ok = total_ok + 1, last_ok_at=?, last_error=NULL, reason=NULL, updated_at=?
       WHERE channel_id=? AND model=?`, now, now, channelId, String(model));
}

/**
 * 记一次**失败**，并按连续失败次数决定是否升级健康度。
 *
 * ⚠️ 内置规则豁免（用户要求「有些画图模型 失效了不判真失效」）：
 *   走非 chat 端点的模型（文生图等），用 chat 打会 404 ——
 *   那是**路径不对**，不是模型坏。这类 CONFIG_FAULT **不计入**健康度，
 *   否则一个完全正常的画图模型会被熔断掉。
 *
 * @param {string} errClass 错误分类（用于决定这次失败是否计入「模型坏」的判据）
 * @param {string} [channelName] 渠道名（内置规则需要）
 * @returns {{ state:string, action:'none'|'degrade'|'unavailable', failStreak:number,
 *             prevState:string, until:number|null, exempted?:string }|null}
 */
export function recordModelFailure(channelId, model, errClass, errorMsg = null, channelName = null) {
  // 非 chat 端点模型的「路径 404」直接豁免 —— 详见函数头注释
  if (errClass === 'config_fault' && channelName
      && isNonChatModel(channelName, model, config)) {
    log.debug(`[model-health] ${channelName}/${model} 是非 chat 端点模型，路径 404 不计入健康度`);
    return null;
  }

  ensureRow(channelId, model, channelName);
  const now = Date.now();
  const prev = getModelHealth(channelId, model, now, channelName);

  const streak = (prev.fail_streak ?? 0) + 1;
  const degradeAt = Math.max(1, config.modelDegradeAfterFails);
  const unavailAt = Math.max(degradeAt + 1, config.modelUnavailableAfterFails);

  // 升级判定：先 UNAVAILABLE 再 DEGRADED（同一次失败只能升一级）
  let nextState = prev.state;
  let action = 'none';
  let disabledUntil = prev.disabled_until;
  let cooldownUntil = prev.cooldown_until;

  if (streak >= unavailAt) {
    nextState = ModelState.UNAVAILABLE;
    disabledUntil = now + config.modelDisabledRecoverMs;
    cooldownUntil = null;
    action = 'unavailable';
  } else if (streak >= degradeAt) {
    // 已经在 UNAVAILABLE 的不降级（保留 24h 语义）
    if (prev.state !== ModelState.UNAVAILABLE) {
      nextState = ModelState.DEGRADED;
      action = prev.state === ModelState.DEGRADED ? 'none' : 'degrade';
    }
  }

  run(`UPDATE model_health
         SET state=?, fail_streak=?, cooldown_until=?, disabled_until=?,
             total_fail = total_fail + 1, last_error=?, reason=?, updated_at=?
       WHERE channel_id=? AND model=?`,
  nextState, streak, cooldownUntil, disabledUntil,
  errorMsg ? String(errorMsg).slice(0, 300) : null,
  reasonFor(nextState, errClass),
  now, channelId, String(model));

  if (action !== 'none') {
    log.warn(`[model-health] ${channelId}/${model} 连续失败 ${streak} 次 → ${nextState}`
      + (action === 'unavailable' ? `（${Math.round(config.modelDisabledRecoverMs / 3600000)} 小时后自动观察）` : ''));
  }
  return { state: nextState, action, failStreak: streak, prevState: prev.state,
    until: nextState === ModelState.UNAVAILABLE ? disabledUntil : cooldownUntil };
}

function reasonFor(state, errClass) {
  if (state === ModelState.NORMAL) return null;
  const tag = errClass ? `[${errClass}] ` : '';
  return `${tag}连续失败自动${state === ModelState.UNAVAILABLE ? '标记不可用' : '降级'}`;
}

/** 手动重置某模型（运维用） */
export function resetModelHealth(channelId, model = null) {
  if (model) {
    return run(`UPDATE model_health SET state='NORMAL', fail_streak=0, cooldown_until=NULL,
                  disabled_until=NULL, last_error=NULL, reason=NULL, updated_at=?
                WHERE channel_id=? AND model=?`, Date.now(), channelId, String(model)).changes;
  }
  return run(`UPDATE model_health SET state='NORMAL', fail_streak=0, cooldown_until=NULL,
                disabled_until=NULL, last_error=NULL, reason=NULL, updated_at=?
              WHERE channel_id=?`, Date.now(), channelId).changes;
}

/**
 * 某渠道的模型健康度映射 —— 供调度器 O(1) 查询。
 * @returns {Map<string,{state:string, failStreak:number, until:number|null, lastError:string|null}>}
 */
export function modelHealthMap(channelId, now = Date.now()) {
  const rows = all('SELECT * FROM model_health WHERE channel_id = ?', String(channelId));
  const out = new Map();
  for (const r of rows) {
    const e = effective(r, now);
    out.set(r.model, {
      state: e.state,
      failStreak: e.fail_streak ?? 0,
      until: e.state === ModelState.UNAVAILABLE ? e.disabled_until : e.cooldown_until,
      lastError: e.last_error ?? null,
      reason: e.reason ?? null,
    });
  }
  return out;
}

/**
 * 全渠道「确定不可用」的模型集合 —— relay 用来在**候选层**直接剔除。
 *
 * ⚠️ 只在**该模型所有候选渠道都不可用**时才剔除（返回的是按模型聚合的结果），
 *    由 relay 决定"是否还有别的渠道可用"。这里只如实给出不可用的 (渠道, 模型) 对。
 *
 * @returns {Set<string>} `${channelId}::${model}` 形式的键
 */
export function unavailablePairs(now = Date.now()) {
  reviveExpired(now);
  const rows = all(`SELECT channel_id, model FROM model_health
                    WHERE state = 'UNAVAILABLE'
                      AND (disabled_until IS NULL OR disabled_until > ?)`, now);
  return new Set(rows.map((r) => `${r.channel_id}::${r.model}`));
}

/** 列表（观测/管理页用），含渠道展示名 */
export function listModelHealth({ channel = null, now = Date.now() } = {}) {
  let sql = `SELECT m.*, c.name AS channel_name, c.display_name AS channel_display
             FROM model_health m JOIN channel c ON c.id = m.channel_id`;
  const params = [];
  if (channel) { sql += ' WHERE (c.id = ? OR c.name = ?)'; params.push(channel, channel); }
  sql += ' ORDER BY c.sort_order, m.state, m.fail_streak DESC, m.model';
  return all(sql, ...params).map((r) => {
    const e = effective(r, now);
    return {
      channel: r.channel_name,
      channelDisplay: r.channel_display,
      model: r.model,
      state: e.state,
      failStreak: e.fail_streak ?? 0,
      totalOk: r.total_ok ?? 0,
      totalFail: r.total_fail ?? 0,
      untilAt: e.state === ModelState.UNAVAILABLE ? e.disabled_until : e.cooldown_until,
      remainingMs: (() => {
        const u = e.state === ModelState.UNAVAILABLE ? e.disabled_until : e.cooldown_until;
        return u ? Math.max(0, u - now) : 0;
      })(),
      lastOkAt: r.last_ok_at,
      lastError: r.last_error,
      reason: e.reason,
      updatedAt: r.updated_at,
    };
  });
}

/** 健康状况汇总（按渠道） */
export function modelHealthSummary(now = Date.now()) {
  reviveExpired(now);
  const rows = all(`SELECT channel_id, state, COUNT(*) AS n FROM model_health
                    WHERE state != 'NORMAL' GROUP BY channel_id, state`);
  const out = [];
  const byChannel = new Map();
  for (const r of rows) {
    if (!byChannel.has(r.channel_id)) byChannel.set(r.channel_id, { DEGRADED: 0, UNAVAILABLE: 0 });
    byChannel.get(r.channel_id)[r.state] = r.n;
  }
  const chans = all('SELECT id, name, display_name FROM channel ORDER BY sort_order');
  for (const c of chans) {
    const v = byChannel.get(c.id) ?? { DEGRADED: 0, UNAVAILABLE: 0 };
    out.push({
      channel: c.name, channelDisplay: c.display_name,
      degraded: v.DEGRADED ?? 0, unavailable: v.UNAVAILABLE ?? 0,
    });
  }
  return out;
}

export default {
  ModelState, getModelHealth, recordModelSuccess, recordModelFailure,
  resetModelHealth, modelHealthMap, listModelHealth, modelHealthSummary,
  reviveExpired, unavailablePairs,
};
