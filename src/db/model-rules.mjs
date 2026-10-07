/**
 * ⭐ 内置「问题模型」规则表 —— 把已知的、上游侧固有的毛病写成规则。
 *
 * 背景（用户 2026-10-07 原话）：
 *   「我感觉有些模型上游就是喜欢429 你帮我测试出这些特定模型」
 *   「有些画图模型 失效了不判真失效 你要一个一个模型测试的」
 *   「然后组成一个内置规则」
 *
 * 为什么需要"内置"而不是纯运行时学习：
 *   纯学习要等模型把 Key 池子烧穿一轮（每个模型都要先用若干把 Key 撞几十次）
 *   才把结论学到手。而这些毛病是**上游固有的、可预先知道的**——
 *   比如文生图模型不走 chat 端点、某些模型在特定渠道 RPM 极低。
 *   预置规则能让第一次请求就走在正确路径上。
 *
 * ⚠️ 规则**不写死结论**，只写"倾向"：
 *   预置成 DEGRADED（降级观察，每次只试 1 次），一旦成功立刻回 NORMAL。
 *   也就是说规则错了也不会永久误伤 —— 代价只是多试一次。
 */

/** 规则类型 */
export const RuleKind = {
  /** 上游对该模型限流极严（爱 429）→ 首次见即 DEGRADED */
  RATE_LIMIT_PRONE: 'rate_limit_prone',
  /** 该模型走非 chat 端点（文生图等）→ chat 的 404 不算模型坏 */
  NON_CHAT: 'non_chat',
  /** 该模型在该渠道**已知**不在 token plan 里（清单有但调不通）→ 直接 UNAVAILABLE */
  NOT_IN_PLAN: 'not_in_plan',
};

/**
 * 内置规则表。
 *
 * ⭐ 这张表的内容**全部来自 2026-10-07 的逐个模型实测**
 *    （脚本 `tools/model-scan.mjs`，商汤每模型 3 次、书生 1 次，结果 3/3 稳定），
 *    不是猜的。原始结论见 `tools/scan-result-2026-10-07.md`。
 *
 * `match` 支持：
 *   - 字符串 → 精确匹配上游模型名
 *   - 正则   → 匹配上游模型名
 *
 * `channel`（可选）：限定渠道名；不填 = 所有渠道。
 *
 * ⚠️ 可用环境变量叠加/覆盖（config.rateLimitProneModels / nonChatModels）。
 */
export const BUILTIN_MODEL_RULES = [
  // ==========================================================
  // ① 走非 chat 端点的模型（画图）—— 实测：chat 端点必然 404
  // ==========================================================
  // 实测：`sensenova-u1-fast` / `sensenova-u1.5-lite` 打 chat 端点
  //       → **404 `model is not found`**（3/3 稳定）
  //       但它们走 `/v1/images/generations` 完全正常（实测返回 1.65MB b64_json）。
  // 用户原话：「有些画图模型 失效了不判真失效 你要一个一个模型测试的」
  // → 这类 404 是**路径不对**，不是模型坏，仓储层直接豁免、不计入健康度。
  { kind: RuleKind.NON_CHAT, channel: 'sensenova', match: /^sensenova-u1/i },
  { kind: RuleKind.NON_CHAT, channel: 'sensenova', match: /-u1(\.|$|-)/i },
  { kind: RuleKind.NON_CHAT, channel: 'sensenova', match: /image|draw|t2i/i },

  // ==========================================================
  // ② 上游持续 429 —— 实测「就是喜欢 429」的特定模型
  // ==========================================================
  // 实测（3/3 全部 429，code=RateLimitExceeded.EndpointRPMExceeded）：
  //   `deepseek-v4-pro`  "inference exceeds tpm/rpm limit"
  //   `deepseek-flash`   "inference exceeds tpm/rpm limit"
  // 实测（3/3 全部 429，code=ModelAccountTpmRateLimitExceeded —— **账号级 TPM 上限**）：
  //   `kimi-k3`          "inference exceeds tpm/rpm limit"
  //
  // 这些都是**模型级**的持续限流：换 Key 打同一模型照样 429。
  // 预置 DEGRADED（只试 1 次）—— 不再让它们烧 Key 池。
  { kind: RuleKind.RATE_LIMIT_PRONE, channel: 'sensenova', match: 'deepseek-v4-pro' },
  { kind: RuleKind.RATE_LIMIT_PRONE, channel: 'sensenova', match: 'deepseek-flash' },
  { kind: RuleKind.RATE_LIMIT_PRONE, channel: 'sensenova', match: 'kimi-k3' },

  // 同一批规律在书生的对应模型（命名带版本后缀，实测本周全部正常，
  // 但同族模型资源同样紧张 → 保守预置，成功一次即回 NORMAL，代价仅一次尝试）
  { kind: RuleKind.RATE_LIMIT_PRONE, channel: 'intern', match: 'deepseek-v4-pro-0813' },

  // 通用规律：大参数量 / 推理型模型资源普遍更紧张
  { kind: RuleKind.RATE_LIMIT_PRONE, match: /reasoner|thinking|ultra|550b|120b/i },

  // ==========================================================
  // ③ 实测「不在 token plan」的模型
  // ==========================================================
  // 实测（3/3）：
  //   `deepseek-v4.1-flash` → **403 code=7(PERMISSION_DENIED)**
  //     "model is not available in the current token plan"
  //
  // ⚠️ 这条已由适配器归一到 CONFIG_FAULT（详见 sensenova.mjs 的 MODEL_LEVEL_AUTH_TEXT），
  //    所以它**不会再连坐禁用 Key**，也会正常计入模型健康度。
  //    这里再预置成 DEGRADED 是双保险：首次请求只试 1 次。
  { kind: RuleKind.RATE_LIMIT_PRONE, channel: 'sensenova', match: 'deepseek-v4.1-flash' },

  // ==========================================================
  // ④ OpenRouter 免费模型 —— `:free` 有极低日调用上限、高峰大量 429
  // ==========================================================
  { kind: RuleKind.RATE_LIMIT_PRONE, channel: 'openrouter', match: /:free$/i },
];

/** 把一条规则匹配到 (渠道, 模型) 上 */
function ruleMatches(rule, channelName, model) {
  if (rule.channel && String(rule.channel) !== String(channelName)) return false;
  const m = String(model ?? '');
  if (typeof rule.match === 'string') return m === rule.match;
  if (rule.match instanceof RegExp) return rule.match.test(m);
  return false;
}

/**
 * 环境变量补丁：`RATE_LIMIT_PRONE_MODELS` / `NON_CHAT_MODELS`。
 * 逗号分隔的上游模型名（精确匹配），叠加在内置表之上。
 */
function envRules(cfg) {
  const out = [];
  const split = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
  for (const name of split(cfg?.rateLimitProneModels)) {
    out.push({ kind: RuleKind.RATE_LIMIT_PRONE, match: name });
  }
  for (const name of split(cfg?.nonChatModels)) {
    out.push({ kind: RuleKind.NON_CHAT, match: name });
  }
  return out;
}

/**
 * 查某个 (渠道, 模型) 命中的规则。
 *
 * @param {string} channelName 渠道名（如 'sensenova'）
 * @param {string} model       上游模型名
 * @param {object} [cfg]       配置（默认取全局 config）
 * @returns {{ kind:string, rule:object }|null}
 */
export function matchModelRule(channelName, model, cfg = null) {
  if (cfg && !cfg.builtinModelRules) return null;
  const rules = [...BUILTIN_MODEL_RULES, ...envRules(cfg)];
  for (const r of rules) {
    if (ruleMatches(r, channelName, model)) return { kind: r.kind, rule: r };
  }
  return null;
}

/**
 * 该 (渠道, 模型) 的**初始健康度** —— 由内置规则给出。
 *
 *   NOT_IN_PLAN  → 'UNAVAILABLE'（但见上：当前不用，保留扩展）
 *   RATE_LIMIT_PRONE → 'DEGRADED'
 *   其它 / 无规则 → 'NORMAL'
 *
 * ⚠️ 只在 `model_health` **还没有该行**时使用（首次遇到）。
 *    已有行说明运行时已经学到了更真实的结论，不该被静态规则覆盖。
 */
export function initialModelState(channelName, model, cfg = null) {
  const hit = matchModelRule(channelName, model, cfg);
  if (!hit) return { state: 'NORMAL', reason: null, kind: null };
  switch (hit.kind) {
    case RuleKind.NOT_IN_PLAN:
      return { state: 'UNAVAILABLE', reason: '内置规则：该模型不在 token plan 内', kind: hit.kind };
    case RuleKind.RATE_LIMIT_PRONE:
      return { state: 'DEGRADED', reason: '内置规则：该模型上游限流严格，降级观察', kind: hit.kind };
    case RuleKind.NON_CHAT:
      // 走非 chat 端点不代表模型坏 —— 保持 NORMAL，只是探活时要知道别用 chat 判死
      return { state: 'NORMAL', reason: null, kind: hit.kind };
    default:
      return { state: 'NORMAL', reason: null, kind: hit.kind };
  }
}

/** 该模型的 HOME 端点是否是非 chat（画图等）—— 探活/健康判定用 */
export function isNonChatModel(channelName, model, cfg = null) {
  const hit = matchModelRule(channelName, model, cfg);
  return hit?.kind === RuleKind.NON_CHAT;
}

/** 给管理页/CLI 用：列出全部内置规则（含来源） */
export function listRules(cfg = null) {
  const dump = (r) => ({
    kind: r.kind,
    channel: r.channel ?? '(全部)',
    match: r.match instanceof RegExp ? r.match.source : r.match,
    isRegex: r.match instanceof RegExp,
  });
  return {
    builtin: BUILTIN_MODEL_RULES.map(dump),
    env: envRules(cfg).map(dump),
    enabled: !cfg || !!cfg.builtinModelRules,
  };
}

export default {
  RuleKind, BUILTIN_MODEL_RULES, matchModelRule, initialModelState,
  isNonChatModel, listRules,
};
