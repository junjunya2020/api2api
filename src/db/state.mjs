/**
 * 调度状态仓储：key_state 表读写。
 *
 * 状态机（用户要求，2026-10-07）：
 *   READY ──失败(streak<10)──▶ COOLDOWN（冷却 10min × 连续失败次数）
 *     ▲                              │ 到期自动
 *     └──────────────────────────────┘
 *   READY ──失败(streak>=10)──▶ DISABLED（24 小时后自动回 READY）
 *     ▲                              │ 到期自动
 *     └──────────────────────────────┘
 *
 * 关键：**连续失败**（fail_streak）一旦成功立刻清零 ——
 *   所以"第 3 次失败"说的是"连着失败 3 次"，中间成功过就重新从第 1 次算。
 */
import { all, one, run } from './index.mjs';
import config from '../config.mjs';
import log from '../util/log.mjs';

const EMPTY = (keyUuid, model) => ({
  key_uuid: keyUuid, model, state: 'READY', next_retry_at: null, disabled_until: null,
  fail_streak: 0, current_weight: 0, total_ok: 0, total_fail: 0,
  last_used_at: null, last_error: null,
});

/** 取某 Key 在某模型上的状态（不存在则视为 READY） */
export function getState(keyUuid, model) {
  const row = one('SELECT * FROM key_state WHERE key_uuid = ? AND model = ?', keyUuid, model);
  return row ?? EMPTY(keyUuid, model);
}

/** 确保行存在 */
function ensureRow(keyUuid, model) {
  run(`INSERT INTO key_state (key_uuid, model) VALUES (?, ?)
       ON CONFLICT(key_uuid, model) DO NOTHING`, keyUuid, model);
}

/** 本地日期 YYYY-MM-DD（用于按日聚合，跟随服务器时区） */
export function localDay(ts = Date.now()) {
  const d = new Date(ts - new Date().getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 10);
}

/**
 * 按日累加调用结果。供"最近 N 天零成功"判定使用。
 *
 * ⚠️ 探针（model='__probe__'）**不计入** —— 探针是系统主动验活，
 *    不代表这把 Key 真的被路由用过。用户明确要求统计的是"调用过"，
 *    探针不该让一把从没被选中的 Key 看起来"被调用过"。
 *
 * ⚠️ 外键保护：key_daily 有 `REFERENCES channel_key(uuid)`，
 *    若 uuid 不存在（数据竞争：Key 刚被删）插入会抛 FOREIGN KEY 失败。
 *    统计只是辅助信息，**绝不能因为它失败而让调度决策本身崩掉** ——
 *    所以这里吞掉异常，只记一条 warn。
 */
function bumpDaily(keyUuid, ok, ts = Date.now()) {
  const day = localDay(ts);
  try {
    if (ok) {
      run(`INSERT INTO key_daily (key_uuid, day, ok, fail, last_ok_at) VALUES (?, ?, 1, 0, ?)
           ON CONFLICT(key_uuid, day) DO UPDATE SET ok = ok + 1, last_ok_at = ?`,
      keyUuid, day, ts, ts);
    } else {
      run(`INSERT INTO key_daily (key_uuid, day, ok, fail, last_fail_at) VALUES (?, ?, 0, 1, ?)
           ON CONFLICT(key_uuid, day) DO UPDATE SET fail = fail + 1, last_fail_at = ?`,
      keyUuid, day, ts, ts);
    }
  } catch (e) {
    log.debug(`[state] 按日统计写入跳过（key=${keyUuid}）: ${e.message}`);
  }
}

/** 记录成功：**清零连续失败**，回 READY。用户要求"一旦成功恢复健康" */
export function recordSuccess(keyUuid, model) {
  ensureRow(keyUuid, model);
  const now = Date.now();
  run(`UPDATE key_state SET state='READY', next_retry_at=NULL, disabled_until=NULL, fail_streak=0,
         total_ok = total_ok + 1, last_used_at=?, last_error=NULL
       WHERE key_uuid=? AND model=?`, now, keyUuid, model);
  if (model !== '__probe__') bumpDaily(keyUuid, true, now);
}

/**
 * 记录失败。
 *
 * @param action     'cooldown' | 'soft' | 'disable' | 'none'
 *                     cooldown —— AUTH 类，**累加** fail_streak 并递增冷却
 *                     soft     —— QUOTA/TRANSIENT 类，**不累加** streak，只短暂让位
 *                                  （模型侧问题不该烧 Key，见 config.keySoftCooldownMs）
 * @param nextRetryAt 冷却到期时间戳（action='cooldown'|'soft' 时有效）
 * @param streak     本次失败后的连续失败次数（由调用方算好，因为决策也在那边）
 */
export function recordFailure(keyUuid, model, {
  action = 'cooldown', nextRetryAt = null, streak = null, error = null,
} = {}) {
  ensureRow(keyUuid, model);
  const now = Date.now();

  if (action === 'none') {
    run('UPDATE key_state SET last_error=? WHERE key_uuid=? AND model=?', error, keyUuid, model);
    // 即便是"不冷却、不换 Key"的失败（如 request_fault），只要真的打过上游，
    // 就算一次失败 —— 桥的"调用过但零成功"判定需要它。
    if (model !== '__probe__') bumpDaily(keyUuid, false, now);
    return;
  }

  if (action === 'disable') {
    // 第 10 次连续失败 → 禁用，24 小时后自动恢复
    const until = now + config.disabledRecoverMs;
    run(`UPDATE key_state SET state='DISABLED', next_retry_at=NULL, disabled_until=?,
           fail_streak = COALESCE(?, fail_streak + 1),
           total_fail = total_fail + 1, last_error=?, last_used_at=?
         WHERE key_uuid=? AND model=?`, until, streak, error, now, keyUuid, model);
    if (model !== '__probe__') bumpDaily(keyUuid, false, now);
    return;
  }

  // ⭐ 软冷却：**只让位，不动 fail_streak** —— 模型侧问题不烧 Key。
  if (action === 'soft') {
    run(`UPDATE key_state SET state='COOLDOWN', next_retry_at=?, disabled_until=NULL,
           fail_streak = fail_streak,
           total_fail = total_fail + 1, last_error=?, last_used_at=?
         WHERE key_uuid=? AND model=?`, nextRetryAt, error, now, keyUuid, model);
    if (model !== '__probe__') bumpDaily(keyUuid, false, now);
    return;
  }

  run(`UPDATE key_state SET state='COOLDOWN', next_retry_at=?, disabled_until=NULL,
         fail_streak = COALESCE(?, fail_streak + 1),
         total_fail = total_fail + 1, last_error=?, last_used_at=?
       WHERE key_uuid=? AND model=?`, nextRetryAt, streak, error, now, keyUuid, model);
  if (model !== '__probe__') bumpDaily(keyUuid, false, now);
}

/**
 * 最近 N 天的调用汇总（按 Key）。
 * @returns Map<uuid, { ok, fail, lastOkAt, lastFailAt }>
 */
export function dailySummaryByKey(days = 3, now = Date.now()) {
  const since = localDay(now - (days - 1) * 86_400_000);
  const rows = all(`
    SELECT key_uuid,
           SUM(ok)   AS ok,
           SUM(fail) AS fail,
           MAX(last_ok_at)   AS last_ok_at,
           MAX(last_fail_at) AS last_fail_at
    FROM key_daily
    WHERE day >= ?
    GROUP BY key_uuid
  `, since);
  const out = new Map();
  for (const r of rows) {
    out.set(r.key_uuid, {
      ok: r.ok ?? 0, fail: r.fail ?? 0,
      lastOkAt: r.last_ok_at ?? null, lastFailAt: r.last_fail_at ?? null,
    });
  }
  return out;
}

/**
 * 「调用过但一次都没成功」的 Key —— 桥要据此提醒用户换 Key。
 *
 * 三条严格按用户定义：
 *   - 窗口内 ok>0            → 正常（有成功过）
 *   - 窗口内 ok=0 且 fail>0  → **判为失败**
 *   - 窗口内两者都是 0       → **没被调用过，不算**（用户明确：本身没调用不算）
 *
 * @param days     观察窗口（默认 3 天）
 * @param minAgeMs 新绑定的 Key 宽限期：绑定不足这么久的 Key 不判定 ——
 *                 否则刚绑上、还没来得及被路由选中的 Key 会立刻被误报。
 */
export function keysWithNoSuccess(days = 3, { minAgeMs = 0, now = Date.now() } = {}) {
  const daily = dailySummaryByKey(days, now);
  const out = [];
  for (const [uuid, d] of daily) {
    if (d.ok > 0) continue;          // 有成功 → 正常
    if (d.fail <= 0) continue;       // 没被调用过 → 不算
    out.push({ uuid, ...d });
  }
  // 宽限有两重，**都无条件下发**：
  //   ① 绑定不足 minAgeMs（新绑的还没被路由选中）
  //   ② 有 grace_until 且未到期（**复核验活通过后主动续的期**）
  // ② 是滑动窗口的关键 —— 每轮复核能过就再保 3 天，能一直保留。
  //   用户 2026-10-07：「复核通过后相当于继续三天缓冲，能一直调用最好」
  const rows = all('SELECT uuid, created_at, grace_until FROM channel_key');
  const meta = new Map(rows.map((r) => [r.uuid, r]));
  return out.filter((x) => {
    const m = meta.get(x.uuid);
    if (!m) return true;                                  // 查不到 → 保守判为失效
    if (Number(m.grace_until ?? 0) > now) return false;    // 复核续期内 → 豁免（与 minAgeMs 无关）
    if (minAgeMs <= 0) return true;                        // 不要求年龄 → 直接命中
    return now - (Number(m.created_at) || 0) >= minAgeMs;
  });
}

/** 取当前连续失败次数 */
export function failStreak(keyUuid, model) {
  const row = one('SELECT fail_streak FROM key_state WHERE key_uuid=? AND model=?', keyUuid, model);
  return row?.fail_streak ?? 0;
}

/** 更新 smooth-WRR 游标。
 *  必须先 ensureRow：全新 Key 还没有 key_state 行，
 *  直接 UPDATE 会命中 0 行 → 游标丢失 → 平滑加权轮询退化成「永远选权重最大的那把」。 */
export function setCurrentWeight(keyUuid, model, cw) {
  ensureRow(keyUuid, model);
  run('UPDATE key_state SET current_weight=? WHERE key_uuid=? AND model=?', cw, keyUuid, model);
}

/**
 * 惰性维护：把**到期**的 COOLDOWN / DISABLED 批量拉回 READY。
 *   - COOLDOWN：next_retry_at 到点
 *   - DISABLED：disabled_until 到点（默认 24 小时），并**清零连续失败** ——
 *     否则恢复后第一次失败立刻又是第 11 次，直接再次禁用。
 */
export function reviveExpired(now = Date.now()) {
  const a = run(`UPDATE key_state SET state='READY', next_retry_at=NULL
                 WHERE state='COOLDOWN' AND next_retry_at IS NOT NULL AND next_retry_at <= ?`, now);
  const b = run(`UPDATE key_state SET state='READY', next_retry_at=NULL, disabled_until=NULL, fail_streak=0
                 WHERE state='DISABLED' AND disabled_until IS NOT NULL AND disabled_until <= ?`, now);
  return (a.changes ?? 0) + (b.changes ?? 0);
}

/** 手动重置某 Key（运维用）—— 冷却、禁用、连续失败全部清掉 */
export function resetKeyState(keyUuid, model = null) {
  if (model) {
    const res = run(`UPDATE key_state SET state='READY', next_retry_at=NULL, disabled_until=NULL,
                       fail_streak=0, current_weight=0, last_error=NULL WHERE key_uuid=? AND model=?`, keyUuid, model);
    return res.changes;
  }
  const res = run(`UPDATE key_state SET state='READY', next_retry_at=NULL, disabled_until=NULL,
                     fail_streak=0, current_weight=0, last_error=NULL WHERE key_uuid=?`, keyUuid);
  return res.changes;
}

/** 全部状态（观测用） */
export function listStates({ channel = null } = {}) {
  let sql = `SELECT s.key_uuid, s.model, s.state, s.next_retry_at, s.disabled_until, s.fail_streak,
                    s.total_ok, s.total_fail, s.last_used_at, s.last_error,
                    k.name AS key_name, c.name AS channel_name
             FROM key_state s
             JOIN channel_key k ON k.uuid = s.key_uuid
             JOIN channel c ON c.id = k.channel_id`;
  const params = [];
  if (channel) { sql += ' WHERE (c.id = ? OR c.name = ?)'; params.push(channel, channel); }
  sql += ' ORDER BY s.state, c.sort_order, k.priority DESC';
  return all(sql, ...params);
}

/**
 * Key 维度的状态聚合 —— 供「Key 列表」直接显示"正常 / 冷却中(剩余多久) / 已禁用"。
 *
 * 一把 Key 可能在多个模型上有状态（key_state 粒度是 key×model），
 * 这里做**最坏情况聚合**：只要有任一模型处于 DISABLED 就显示 DISABLED，
 * 否则有 COOLDOWN 就显示 COOLDOWN（取最早到期的那条），全 READY 才算正常。
 * 这才是用户真正关心的："这把 Key 现在还能不能用"。
 *
 * ⭐ 同时给出「**最后调用的是哪个模型**」（2026-10-07 用户要求）：
 *   冷却中只看到"剩余 17 分 51 秒"是不够的 —— 你还想知道它是**被哪个模型打挂的**。
 *   key_state 天然是 key×model 粒度且带 last_used_at，所以直接按时间取最近的一条即可，
 *   无需新增列、无需额外写入。
 *
 * @returns {Map<string,{state:string, untilAt:number|null, failStreak:number,
 *                       lastError:string|null, models:number, cooldownModels:number,
 *                       lastModel:string|null, lastModelAt:number|null,
 *                       lastModelState:string|null}>}
 */
export function keyHealthMap(now = Date.now()) {
  const rows = all(`
    SELECT key_uuid, state, next_retry_at, disabled_until, fail_streak, last_error, model, last_used_at
    FROM key_state
  `);

  /** @type {Map<string,any>} */
  const out = new Map();
  for (const r of rows) {
    // 已到期的冷却/禁用视为已恢复（兜底，避免读到惰性维护之前的脏状态）
    let st = r.state;
    let untilAt = null;
    if (st === 'COOLDOWN' && r.next_retry_at && r.next_retry_at <= now) st = 'READY';
    else if (st === 'COOLDOWN') untilAt = r.next_retry_at;
    if (st === 'DISABLED' && r.disabled_until && r.disabled_until <= now) st = 'READY';
    else if (st === 'DISABLED') untilAt = r.disabled_until;

    const cur = out.get(r.key_uuid) ?? {
      state: 'READY', untilAt: null, failStreak: 0,
      lastError: null, models: 0, cooldownModels: 0,
      lastModel: null, lastModelAt: null, lastModelState: null,
    };
    cur.models += 1;
    if (st === 'COOLDOWN') cur.cooldownModels += 1;
    // 严重度：DISABLED > COOLDOWN > READY
    const sev = (s) => (s === 'DISABLED' ? 2 : s === 'COOLDOWN' ? 1 : 0);
    if (sev(st) > sev(cur.state)) {
      cur.state = st;
      cur.untilAt = untilAt;
    } else if (st === cur.state && untilAt != null) {
      // 同状态取**最晚**到期（更贴近"这把 Key 什么时候真的可用"）
      cur.untilAt = cur.untilAt == null ? untilAt : Math.max(cur.untilAt, untilAt);
    }
    if (st !== 'READY') {
      cur.failStreak = Math.max(cur.failStreak, r.fail_streak ?? 0);
      cur.lastError = r.last_error ?? cur.lastError;
    }
    // 「最后一次调用」= last_used_at 最大的那条。
    // 探针（__probe__）不算"业务调用"，但它确实是一次真实上游请求，
    // 仍保留作为兜底 —— 纯粹的验活记录不会误导，反而能解释"为什么这把 Key 有记录"。
    const at = Number(r.last_used_at ?? 0);
    if (r.model && at > (cur.lastModelAt ?? 0)) {
      cur.lastModel = r.model;
      cur.lastModelAt = at;
      cur.lastModelState = st;
    }
    out.set(r.key_uuid, cur);
  }
  return out;
}

/**
 * 状态汇总。
 *
 * 两种维度都有用，别混淆：
 *   - `byCell`：**key × model** 维度（key_state 行数）—— 看得出"哪个模型的哪把 Key 出了问题"
 *   - `byKey` ：**Key** 维度（最坏情况聚合）—— 回答"有几把 Key 现在不能用"，
 *               与「Key 管理」页的口径**完全一致**，UI 上两个页面的数字才能对上
 *
 * 两者都**剔除已过期**的冷却/禁用（惰性维护要等下一次 pickKey 才跑，
 * 统计不该显示一个其实已经恢复的状态）。
 */
export function stateSummary(now = Date.now()) {
  // 用子查询而非 `GROUP BY <别名>` —— key_state 里已有一个真实列叫 state，
  // 别名同名会让 SQLite 的解析产生歧义。
  const byCell = all(`
    SELECT s AS state, COUNT(*) AS n FROM (
      SELECT CASE
        WHEN state = 'COOLDOWN' AND next_retry_at IS NOT NULL AND next_retry_at >  ? THEN 'COOLDOWN'
        WHEN state = 'DISABLED' AND disabled_until IS NOT NULL AND disabled_until > ? THEN 'DISABLED'
        ELSE 'READY'
      END AS s
      FROM key_state
    ) GROUP BY s
  `, now, now);

  const health = keyHealthMap(now);
  const byKey = { READY: 0, COOLDOWN: 0, DISABLED: 0 };
  for (const h of health.values()) byKey[h.state] = (byKey[h.state] ?? 0) + 1;

  return {
    byCell,
    byKey: Object.entries(byKey).map(([state, n]) => ({ state, n })),
    /** 当前处于异常状态的 Key 总数（冷却 + 禁用） */
    unhealthyKeys: (byKey.COOLDOWN ?? 0) + (byKey.DISABLED ?? 0),
  };
}

export default {
  getState, recordSuccess, recordFailure, failStreak, setCurrentWeight,
  reviveExpired, resetKeyState, listStates, keyHealthMap, stateSummary,
  localDay, dailySummaryByKey, keysWithNoSuccess,
};
