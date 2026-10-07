/**
 * 模型映射仓储：对外名 (public_name) → 上游真名 (upstream_name)
 * channel_id 为 NULL 表示"对所有渠道生效"。
 */
import { all, one, run } from './index.mjs';
import { getChannel } from './channels.mjs';
import { catalogMap } from './catalog.mjs';

export class BadRequestError extends Error {
  constructor(msg) { super(msg); this.name = 'BadRequestError'; this.status = 400; }
}
export class DupError extends Error {
  constructor(msg) { super(msg); this.name = 'DupError'; this.status = 409; }
}

export function listAliases({ channel = null, publicName = null } = {}) {
  let sql = `SELECT a.*, c.name AS channel_name, c.display_name AS channel_display
             FROM model_alias a LEFT JOIN channel c ON c.id = a.channel_id`;
  const where = [];
  const params = [];
  if (channel) {
    const ch = getChannel(channel);
    if (!ch) throw new BadRequestError(`渠道不存在: ${channel}`);
    where.push('a.channel_id = ?'); params.push(ch.id);
  }
  if (publicName) { where.push('a.public_name = ?'); params.push(publicName); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY a.public_name ASC, a.priority DESC';
  return all(sql, ...params);
}

export function addAlias({ public_name, upstream_name, channel = null, priority = 0, weight = 1 }) {
  if (!public_name || !upstream_name) throw new BadRequestError('public_name 与 upstream_name 必填');
  let channelId = null;
  if (channel) {
    const ch = getChannel(channel);
    if (!ch) throw new BadRequestError(`渠道不存在: ${channel}`);
    channelId = ch.id;
  }
  // 去重：同 (public_name, channel_id) 视为同一映射
  const dup = channelId
    ? one('SELECT id FROM model_alias WHERE public_name = ? AND channel_id = ?', public_name, channelId)
    : one('SELECT id FROM model_alias WHERE public_name = ? AND channel_id IS NULL', public_name);
  if (dup) throw new DupError(`映射已存在: ${public_name}${channel ? ' @' + channel : ' (全局)'}`);

  const res = run(
    `INSERT INTO model_alias (public_name, channel_id, upstream_name, priority, weight, enabled, created_at)
     VALUES (?, ?, ?, ?, ?, 1, ?)`,
    public_name, channelId, upstream_name, Math.trunc(+priority) || 0, Math.trunc(+weight) || 1, Date.now(),
  );
  return one('SELECT * FROM model_alias WHERE id = ?', res.lastInsertRowid);
}

export function patchAlias(id, patch) {
  const cur = one('SELECT * FROM model_alias WHERE id = ?', Number(id));
  if (!cur) return null;
  run('UPDATE model_alias SET upstream_name=?, priority=?, weight=?, enabled=? WHERE id=?',
    patch.upstream_name ?? cur.upstream_name,
    Number.isFinite(+patch.priority) ? Math.trunc(+patch.priority) : cur.priority,
    Number.isFinite(+patch.weight) && +patch.weight > 0 ? Math.trunc(+patch.weight) : cur.weight,
    patch.enabled === undefined ? cur.enabled : (patch.enabled ? 1 : 0),
    Number(id),
  );
  return one('SELECT * FROM model_alias WHERE id = ?', Number(id));
}

export function deleteAlias(id) {
  const res = run('DELETE FROM model_alias WHERE id = ?', Number(id));
  return res.changes > 0;
}

/**
 * 核心查询：给定对外模型名，解析出候选上游映射列表。
 *
 * 语义（2026-10-06 修正）：**映射是叠加层，不是替代层**。
 *   ① 渠道专属映射 → 该渠道用映射的上游名（最高优先）
 *   ② 全局映射     → 没配专属映射的渠道用全局映射的上游名
 *   ③ 其余渠道     → 同名直通（public == upstream）
 *
 * 为什么不能"有映射就只走映射"：用户把 `deepseek-v4-flash-0731` 统一改名成
 * `deepseek-v4-flash` 时只会在书生建一条映射，若直接返回，商汤的同名模型
 * 就再也调不到了 —— 改名反而砍掉渠道。
 *
 * 排序：映射命中 > 目录命中的同名直通 > 目录未命中的同名直通。
 * 只排序、不剔除 —— 目录可能为空或过期，剔除会造成"明明能调却调不到"。
 */
export function resolveCandidates(publicName) {
  const chans = all(`
    SELECT id AS channel_id, name AS channel_name, display_name AS channel_display,
           adapter, base_url, sort_order
    FROM channel WHERE enabled = 1 ORDER BY sort_order
  `);
  if (!chans.length) return [];

  // 该对外名下的所有映射
  const aliasRows = all(`
    SELECT a.upstream_name, a.channel_id, a.priority, a.weight
    FROM model_alias a WHERE a.public_name = ? AND a.enabled = 1
  `, publicName);
  const chanSpecific = new Map();
  let globalAlias = null;
  for (const a of aliasRows) {
    if (a.channel_id) chanSpecific.set(a.channel_id, a);
    else if (!globalAlias || a.priority > globalAlias.priority) globalAlias = a;
  }

  // 目录里确实有这个名字的渠道
  const known = new Set(
    all(`SELECT DISTINCT c.name AS channel_name FROM upstream_model u
         JOIN channel c ON c.id = u.channel_id WHERE u.model_id = ?`, publicName)
      .map((r) => r.channel_name),
  );

  // **已经拉过目录**的渠道（至少有一条记录）。
  // 这个集合很重要：只有"拉过目录且名单里没有"才能断定该渠道没有这个模型；
  // 从没拉过目录的渠道是"未知"，不能因为缺数据就跳过它 —— 那会误杀能用的渠道。
  const fetchedChannels = new Set(
    all(`SELECT DISTINCT c.name AS channel_name FROM upstream_model u
         JOIN channel c ON c.id = u.channel_id`)
      .map((r) => r.channel_name),
  );

  /** @type {{cand:object, rank:number}[]} */
  const out = [];
  for (const c of chans) {
    const spec = chanSpecific.get(c.channel_id);
    if (spec) {
      out.push({ rank: 0, cand: normalize({ ...c, upstream_name: spec.upstream_name, priority: spec.priority, weight: spec.weight }) });
      continue;
    }
    if (globalAlias) {
      out.push({ rank: 1, cand: normalize({ ...c, upstream_name: globalAlias.upstream_name, priority: globalAlias.priority, weight: globalAlias.weight }) });
      continue;
    }
    // 同名直通：目录命中的排前面
    const inCatalog = known.has(c.channel_name);
    const catalogKnown = fetchedChannels.has(c.channel_name);
    const cand = normalize({ ...c, upstream_name: publicName, priority: 0, weight: 1 });
    cand.catalogKnown = catalogKnown;
    out.push({ rank: inCatalog ? 2 : 3, cand });
  }

  // 无目录信息时，rank 2/3 无差别，保持渠道 sort_order 原序（稳定排序）
  // rank 会带出去给 relay 用：它和渠道优先级有时会冲突（低优先级渠道有精确映射，
  // 高优先级渠道只有同名直通），relay 决定怎么权衡。
  return out.sort((x, y) => x.rank - y.rank)
    .map((x) => { x.cand.rank = x.rank; return x.cand; });
}

function normalize(r) {
  return {
    publicName: r.public_name ?? null,
    upstreamName: r.upstream_name,
    channelId: r.channel_id,
    channelName: r.channel_name,
    channelDisplay: r.channel_display,
    adapter: r.adapter,
    baseUrl: r.base_url,
    priority: r.priority ?? 0,
    weight: r.weight ?? 1,
    sortOrder: r.sort_order ?? 0,
    /** 0=渠道专属映射 1=全局映射 2=目录命中的同名直通 3=纯同名直通 */
    rank: 3,
    /** 该渠道**是否拉过目录**（true 时 rank 3 才能断定"确实没有这个模型"） */
    catalogKnown: r.catalogKnown ?? false,
  };
}

/**
 * 对外模型清单。
 *
 * 真相来源是**上游模型目录**（拉回来的真实清单），映射只在其上叠加改性：
 *   ① 上游有的模型，原样出现在列表里（同名直通，下游可直接用）
 *   ② 上游模型若被映射改名，对应上游名会被"折叠"掉，只留对外名
 *   ③ 映射到的上游名即使不在目录里也照样列出（用户可能故意映射到目录外的模型）
 *
 * 这样下游 /v1/models 看到的 = "我实际能调到的所有模型"，
 * 而不是"必须先手工建映射才看得到"。
 */
export function publicModelList() {
  const catalog = catalogMap();          // model_id → { channels, ... }
  const aliases = all(`
    SELECT a.public_name, a.upstream_name, a.channel_id, a.enabled,
           c.name AS channel_name, c.display_name AS channel_display
    FROM model_alias a LEFT JOIN channel c ON c.id = a.channel_id
    WHERE a.enabled = 1
  `);

  /** 被某个映射"占用"的 (上游名, 渠道) —— 折叠时用，避免同一个东西出现两次 */
  const claimedByChannel = new Map();    // `${channelName}|${upstream}` → publicName
  const claimedGlobal = new Map();       // `${upstream}` → publicName（全局映射）
  for (const a of aliases) {
    if (a.channel_name) {
      claimedByChannel.set(`${a.channel_name}|${a.upstream_name}`, a.public_name);
    } else {
      claimedGlobal.set(a.upstream_name, a.public_name);
    }
  }

  const out = new Map();  // publicId → entry

  // ① 上游目录：未被映射占用的模型，以原名出现在列表（同名直通）
  for (const [modelId, entry] of catalog) {
    // 全局映射：该上游名整体改名，原名不再出现
    if (claimedGlobal.has(modelId)) continue;

    // 渠道专属映射：只把"被占用的那些渠道"摘掉，其余渠道的原名仍可见
    const keptIdx = entry.channelNames
      .map((chName, i) => (claimedByChannel.has(`${chName}|${modelId}`) ? -1 : i))
      .filter((i) => i >= 0);
    if (!keptIdx.length) continue;

    out.set(modelId, {
      id: modelId,
      kind: 'upstream',
      channels: keptIdx.map((i) => entry.channels[i]),
      aliasedFrom: null,
    });
  }

  // ② 映射：作为对外名列出（去重）
  for (const a of aliases) {
    const channels = a.channel_name
      ? [a.channel_display || a.channel_name]
      : [...catalog.get(a.upstream_name)?.channels ?? []];
    if (out.has(a.public_name)) {
      const e = out.get(a.public_name);
      e.channels = [...new Set([...e.channels, ...channels])];
      continue;
    }
    out.set(a.public_name, {
      id: a.public_name,
      kind: a.channel_name ? 'alias' : 'alias-global',
      channels: channels.length ? channels : ['所有渠道'],
      aliasedFrom: a.upstream_name,
    });
  }

  return [...out.values()].sort((x, y) => x.id.localeCompare(y.id));
}

export default { listAliases, addAlias, patchAlias, deleteAlias, resolveCandidates, publicModelList };
