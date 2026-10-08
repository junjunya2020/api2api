/**
 * 模型名归并（同义名 → 规范名）。
 *
 * ⭐ 用户要求（2026-10-08）：
 *   「DeepSeek-V4-Flash-0731 / deepseek-v4-flash-0731 / Deepseek-V4-Flash /
 *     deepseek-v4-flash:0731 都映射成 deepseek-v4-flash」
 *
 * 场景：同一个模型在不同渠道的上游名五花八门 ——
 *   商汤 `deepseek-v4-flash`、书生 `deepseek-v4-flash-0731`、
 *   魔搭 `deepseek-ai/DeepSeek-V4-Flash-0731`、LLM7 `DeepSeek-V4-Flash-0731`。
 *   下游只想记一个名字。本模块把这些名字**归并**到一个规范名上。
 *
 * 语义（与 model_alias 严格区分）：
 *   model_alias   对外名 → 上游名（**渠道内**改名，回答"这条渠道上它叫啥"）
 *   model_synonym 别名   → 规范名（**全局**归并，回答"这两个名字是不是同一个东西"）
 *
 * 行为：
 *   ① `resolveCandidates(名)`：名字命中归并表 → 改为解析**规范名**的候选
 *      （于是"任意别名"都能被路由到所有真的提供该模型的渠道）
 *   ② `publicModelList()`：别名**不再单独列出**（折叠到规范名），避免清单重复
 *
 * ⚠️ 未命中归并表时**零行为改变** —— 只是多一次主键查询。
 */
import { all, one, run } from './index.mjs';

export class BadRequestError extends Error {
  constructor(msg) { super(msg); this.name = 'BadRequestError'; this.status = 400; }
}

/** 归一化用于比较：去首尾空白、统一小写（大小写不敏感地判"同一个名字"） */
function norm(s) {
  return String(s ?? '').trim().toLowerCase();
}

/**
 * 把任意名字解析成**规范名**。
 * 不在归并表里（或是规名自身）时原样返回。
 */
export function canonicalOf(name) {
  const n = String(name ?? '').trim();
  if (!n) return n;
  const row = one('SELECT canonical FROM model_synonym WHERE name = ?', n)
    ?? one('SELECT canonical FROM model_synonym WHERE lower(name) = ?', n.toLowerCase());
  return row?.canonical ? String(row.canonical) : n;
}

/** 是否为某规范名的别名（用于清单折叠判定） */
export function aliasMap() {
  const rows = all('SELECT name, canonical FROM model_synonym');
  const byName = new Map();        // 别名（原样） → 规范名
  const byNameLower = new Map();   // 别名（小写） → 规范名
  const canonicals = new Set();    // 所有规范名（**只放真正的规范名**）
  for (const r of rows) {
    byName.set(r.name, r.canonical);
    byNameLower.set(norm(r.name), r.canonical);
    canonicals.add(r.canonical);
    // 自身指向自身（name === canonical）时才把 name 也算规范名。
    // ⚠️ 不能按"大小写不敏感相等"来加 —— 仅大小写不同的别名（如
    //    `Deepseek-V4-Flash` → `deepseek-v4-flash`）是**必要**的归并，
    //    若把它也算规范名，折叠逻辑就会把它当成规范名放行、折叠失效。
    if (r.name === r.canonical) canonicals.add(r.name);
  }
  return { byName, byNameLower, canonicals };
}

/** 所有别名（含大小写变体）指向的规范名列表 */
export function canonicals() {
  return [...new Set(all('SELECT canonical FROM model_synonym').map((r) => r.canonical))];
}

/**
 * 某规范名**同一组**的全部成员名（规范名自身 + 所有指向它的别名）。
 *
 * ⭐ 为什么路由需要这个：用户可能给每个渠道各建一条**渠道专属映射**
 *    （书生 `deepseek-v4-flash-0731` → `deepseek-v4-flash`、
 *     魔搭 `DeepSeek-V4-Flash-0731` → `deepseek-v4-flash` …），
 *    这些映射的 `public_name` 各不相同。只看规范名一条会漏掉其它渠道的上游名。
 *    把同组名字并起来查，规范名才能命中**所有**渠道 —— 这正是归并的目的。
 */
export function groupMembers(canonical) {
  const c = String(canonical ?? '').trim();
  if (!c) return [];
  const rows = all('SELECT name FROM model_synonym WHERE canonical = ?', c);
  const names = new Set([c, ...rows.map((r) => r.name)]);
  // 反向：如果 c 自己也是个别名（指向别处），把链条也带上（防配错时静默失效）
  const up = one('SELECT canonical FROM model_synonym WHERE name = ?', c);
  if (up?.canonical) names.add(String(up.canonical));
  return [...names];
}

export function listSynonyms() {
  return all('SELECT * FROM model_synonym ORDER BY canonical, name');
}

/**
 * 新增/更新一条归并（同名字覆盖 —— 便于修正指向）。
 * @param {{name:string, canonical:string, note?:string}} p
 */
export function addSynonym({ name, canonical, note = null }) {
  const n = String(name ?? '').trim();
  const c = String(canonical ?? '').trim();
  if (!n || !c) throw new BadRequestError('name 与 canonical 必填');
  // ⚠️ 只拒绝**完全相同**的字符串。
  //    仅大小写不同是**合法且必要**的 —— 用户明确要求
  //    `Deepseek-V4-Flash` 归并到 `deepseek-v4-flash`（只差大小写）。
  if (n === c) throw new BadRequestError('别名与规范名相同，无需归并');
  const now = Date.now();
  run(`INSERT INTO model_synonym (name, canonical, note, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET canonical = excluded.canonical,
                                       note = excluded.note`, n, c, note, now);
  return one('SELECT * FROM model_synonym WHERE name = ?', n);
}

export function deleteSynonym(name) {
  return run('DELETE FROM model_synonym WHERE name = ?', String(name)).changes > 0;
}

/** 删除某规范名下的**全部**别名（含自身指向） */
export function deleteCanonical(canonical) {
  return run('DELETE FROM model_synonym WHERE canonical = ?', String(canonical)).changes;
}

export default {
  canonicalOf, aliasMap, canonicals, groupMembers,
  listSynonyms, addSynonym, deleteSynonym, deleteCanonical,
};
