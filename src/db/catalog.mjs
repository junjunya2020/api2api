/**
 * 上游模型目录：各渠道 GET /models 拉回来的真实模型清单。
 *
 * 这是**下游 /v1/models 的真相来源** —— 上游有什么，下游就能看到什么。
 * model_alias（映射）只负责"改名"，不参与"有哪些模型"的判定：
 *   - 有映射 → 下游看到映射的对外名
 *   - 没映射 → 下游看到上游原名（同名直通）
 */
import { all, run, tx } from './index.mjs';
import { getChannel, listChannels } from './channels.mjs';
import { friendlyVariants, needsFriendlyAlias } from '../util/friendly.mjs';

/**
 * 用某渠道的最新清单整体替换旧记录。
 * 整表替换而非增量 —— 上游下架的模型必须消失，否则下游会一直看到幽灵模型。
 *
 * `seq` 记录模型在 `/models` 响应里的**原始次序** ——
 * 验活"逐个试模型"要按上游声明的顺序来（用户明确要求：从列表第一个开始）。
 */
export function replaceChannelModels(channelId, ids) {
  const now = Date.now();
  return tx(() => {
    run('DELETE FROM upstream_model WHERE channel_id = ?', channelId);
    let n = 0;
    const seen = new Set();
    for (const id of ids) {
      if (!id) continue;
      const mid = String(id);
      if (seen.has(mid)) continue;   // 去重但不打乱顺序（保留首次出现的位次）
      seen.add(mid);
      run(
        'INSERT OR REPLACE INTO upstream_model (channel_id, model_id, seq, fetched_at) VALUES (?, ?, ?, ?)',
        channelId, mid, n, now,
      );
      n++;
    }
    return n;
  });
}

/**
 * 为带噪音的上游模型名自动生成友好别名（本渠道内）。
 *
 * 例：`deepseek.ai/deepseek-v4.1-flash:free`
 *   → 别名 `deepseek-v4.1-flash`      @该渠道
 *   → 别名 `Deepseek-V4.1-Flash`      @该渠道
 * 原名**照样保留**，同名直通仍可调用。
 *
 * 只处理"需要友好化"的（带 `/` 或 `:free` 之类标签）；
 * 本来就干净的名字（`glm-5.2`）不造别名，避免无意义的记录。
 *
 * @returns {{created:number, aliases:Array<{publicName:string, upstreamName:string}>}}
 */
export function seedFriendlyAliases(channelId, ids) {
  /** @type {Map<string,string>} publicName → upstreamName （本渠道内，publicName 唯一） */
  const plan = new Map();
  for (const raw of ids) {
    if (!needsFriendlyAlias(raw)) continue;
    for (const variant of friendlyVariants(raw)) {
      // 同渠道内如果两个上游名产生同一个友好名（极少见），保留先到的那个
      if (!plan.has(variant)) plan.set(variant, raw);
    }
  }
  if (!plan.size) return { created: 0, aliases: [] };

  const created = [];
  tx(() => {
    for (const [publicName, upstreamName] of plan) {
      // 已存在同渠道同 publicName 的映射 → 跳过（不覆盖用户手工配置）
      const dup = all(
        'SELECT id FROM model_alias WHERE public_name = ? AND channel_id = ?',
        publicName, channelId,
      );
      if (dup.length) continue;
      run(
        `INSERT INTO model_alias (public_name, channel_id, upstream_name, priority, weight, enabled, created_at)
         VALUES (?, ?, ?, 0, 1, 1, ?)`,
        publicName, channelId, upstreamName, Date.now(),
      );
      created.push({ publicName, upstreamName });
    }
  });
  return { created: created.length, aliases: created };
}

/**
 * 清理某渠道下"自动生成的友好别名" —— 只删那些仍指向本渠道、且上游名符合噪音特征的。
 * 用于拉取失败后回滚、或渠道被禁用时收尾。用户手工建的映射不动。
 */
export function removeFriendlyAliases(channelId) {
  const rows = all('SELECT id, public_name, upstream_name FROM model_alias WHERE channel_id = ?', channelId);
  let removed = 0;
  const ids = [];
  for (const r of rows) {
    // 自动生成的特征：上游名本身需要友好化，且 public 是它的友好变体
    if (!needsFriendlyAlias(r.upstream_name)) continue;
    if (friendlyVariants(r.upstream_name).includes(r.public_name)) {
      ids.push(r.id);
    }
  }
  if (!ids.length) return 0;
  tx(() => {
    for (const id of ids) {
      run('DELETE FROM model_alias WHERE id = ?', id);
      removed++;
    }
  });
  return removed;
}

/** 某渠道目录（按上游声明顺序，与 `GET /models` 返回次序一致） */
export function listChannelModels(channelRef) {
  const ch = getChannel(channelRef);
  if (!ch) return [];
  return all(
    'SELECT model_id, seq, fetched_at FROM upstream_model WHERE channel_id = ? ORDER BY seq ASC, model_id ASC',
    ch.id,
  );
}

/**
 * 全渠道目录聚合：模型名 → { channels: [渠道名], fetchedAt }
 * 同一个模型名在多个渠道都有时会合并（这正是跨渠道降级的基础）。
 */
export function catalogMap() {
  const rows = all(`
    SELECT u.model_id, u.fetched_at, c.name AS channel_name, c.display_name AS channel_display
    FROM upstream_model u JOIN channel c ON c.id = u.channel_id
    WHERE c.enabled = 1
    ORDER BY u.model_id, c.sort_order
  `);
  const map = new Map();
  for (const r of rows) {
    let e = map.get(r.model_id);
    if (!e) {
      e = { id: r.model_id, channels: [], channelNames: [], fetchedAt: 0 };
      map.set(r.model_id, e);
    }
    e.channels.push(r.channel_display || r.channel_name);
    e.channelNames.push(r.channel_name);
    e.fetchedAt = Math.max(e.fetchedAt, r.fetched_at);
  }
  return map;
}

/** 每个渠道的目录统计（给管理页用） */
export function catalogStats() {
  const counts = new Map(
    all('SELECT channel_id, COUNT(*) AS n, MAX(fetched_at) AS t FROM upstream_model GROUP BY channel_id')
      .map((r) => [r.channel_id, r]),
  );
  return listChannels().map((c) => {
    const r = counts.get(c.id);
    return {
      channel: c.name,
      channelDisplay: c.displayName,
      count: r?.n ?? 0,
      fetchedAt: r?.t ?? null,
    };
  });
}

export function clearChannelModels(channelRef) {
  const ch = getChannel(channelRef);
  if (!ch) return 0;
  const n = run('DELETE FROM upstream_model WHERE channel_id = ?', ch.id).changes;
  removeFriendlyAliases(ch.id);
  return n;
}

export default {
  replaceChannelModels, seedFriendlyAliases, removeFriendlyAliases,
  listChannelModels, catalogMap, catalogStats, clearChannelModels,
};
