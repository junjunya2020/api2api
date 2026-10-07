/**
 * 模型名友好化。
 *
 * 上游模型名往往带一堆噪音：供应商前缀 + 免费标签，例如：
 *   deepseek.ai/deepseek-v4.1-flash:free
 *   google/gemma-4-31b-it:free
 *   nvidia/nemotron-3-super-120b-a12b:free
 *
 * 下游客户端不该看到这些。规则：
 *   ① 去掉供应商前缀（`vendor/` 或 `vendor.domain/`）
 *   ② 去掉尾部标签（`:free` / `:beta` / `:extended` 等）
 *   ③ 生成两种形态：全小写连字符（`deepseek-v4.1-flash`）
 *                   和分段首字母大写（`Deepseek-V4.1-Flash`）
 *
 * **不改动上游原名** —— 原名照样能调用（同名直通），友好名只是额外入口。
 */

/**
 * 尾部标签，形如 `:free`。只在**最后一段**上剥离，避免误伤模型名里正常的冒号。
 * OpenRouter 的约定：`:free` 是唯一在用的变体标签。
 */
const TAG_RE = /:(free|beta|preview|extended|thinking|online|nitro)\b/gi;

/** 这些主语的前缀不是供应商，不能剥（如 `openrouter/free` 是平台虚拟模型） */
const KEEP_PREFIX = new Set(['openrouter']);

/**
 * 去供应商前缀。
 * `deepseek.ai/deepseek-v4.1-flash:free` → `deepseek-v4.1-flash:free`
 * `google/gemma-4-31b-it:free`           → `gemma-4-31b-it:free`
 * `openrouter/free`                      → `openrouter/free`（保留）
 */
export function stripVendor(id) {
  const s = String(id ?? '').trim();
  const idx = s.lastIndexOf('/');
  if (idx < 0) return s;
  const head = s.slice(0, idx);
  if (KEEP_PREFIX.has(head.toLowerCase())) return s;
  return s.slice(idx + 1);
}

/** 去尾部标签：`xxx:free` → `xxx` */
export function stripTags(id) {
  return String(id ?? '').replace(TAG_RE, '').replace(/[-_.]+$/, '');
}

/**
 * 小写连字符形态（下游最常用的名字）。
 * `deepseek.ai/deepseek-v4.1-flash:free` → `deepseek-v4.1-flash`
 */
export function friendlyName(id) {
  return stripTags(stripVendor(id)).toLowerCase();
}

/**
 * 分段首字母大写形态。
 * `deepseek-v4.1-flash` → `Deepseek-V4.1-Flash`
 * 规则：按 `-` 分段，每段首字母大写、其余原样（不改变数字与点号）。
 */
export function pascalName(id) {
  const base = stripTags(stripVendor(id));
  return base
    .split('-')
    .filter(Boolean)
    .map((seg) => seg.charAt(0).toUpperCase() + seg.slice(1))
    .join('-');
}

/**
 * 一个上游模型名对应的全部友好别名（去重、且不含与原名相同的项）。
 * @returns {string[]} 例如 ['deepseek-v4.1-flash', 'Deepseek-V4.1-Flash']
 */
export function friendlyVariants(id) {
  const out = new Set();
  const lower = friendlyName(id);
  const pascal = pascalName(id);
  if (lower && lower !== String(id)) out.add(lower);
  if (pascal && pascal !== String(id) && pascal !== lower) out.add(pascal);
  return [...out];
}

/**
 * 判断这个名字是否"需要友好化"（即带前缀或带标签）。
 * 干净的名字（`glm-5.2`）不需要造别名。
 */
export function needsFriendlyAlias(id) {
  const s = String(id ?? '');
  if (!s) return false;
  if (s.includes('/')) return true;
  if (TAG_RE.test(s)) { TAG_RE.lastIndex = 0; return true; }
  TAG_RE.lastIndex = 0;
  return false;
}

export default {
  stripVendor, stripTags, friendlyName, pascalName, friendlyVariants, needsFriendlyAlias,
};
