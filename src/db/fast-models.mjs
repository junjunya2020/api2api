/**
 * 「快速模型」白名单（用户 2026-10-07 要求：「是否只接快速模型，默认打开」）。
 *
 * 背景：NVIDIA NIM 免费档的目录有 **80 个模型，但真正能出内容的只有个位数** ——
 * 其余要么 404（本账号没订阅）、要么 410（已退役）、要么**挂死**（>90s 零响应）。
 * 把这些"目录里有、实际不可用"的模型放进下游清单，只会：
 *   ① 让 /v1/models 被淹没；② 让调度器把熔断预算烧在永不返回的模型上。
 *
 * 所以对「大批量混合目录」的渠道，默认**只暴露经过实测的快速模型**。
 * 开关默认**打开**，可通过 `/api/settings` 或 env `FAST_MODELS_ONLY=0` 关闭。
 *
 * ⚠️ 本表是**实测结论**，不是猜测 —— 见 `tools/scan-nvidia-2026-10-07.md`。
 *    实测口径：流式首字 TTFT < ~3.5s 且能稳定出内容，且是 **chat 可用**的
 *    （排除了纯翻译 / 纯多模态 parse 这类专用端点模型）。
 */
import config from '../config.mjs';

/**
 * 只对**这些渠道**启用「快速模型」过滤。
 *
 * 为什么不是全渠道：商汤 / 书生 / OpenRouter 的目录本身就是可用的，
 * 贸然过滤会误伤。只有 NVIDIA 这种"目录严重虚胖"的渠道才需要。
 */
export const FAST_ONLY_CHANNELS = new Set(['nvidia']);

/** 实测可用且快的 NVIDIA 模型（chat 可用） */
export const NVIDIA_FAST_MODELS = Object.freeze([
  'nvidia/nemotron-3-super-120b-a12b',      // TTFT ~1.6-2.0s，最稳最快
  'nvidia/nemotron-3-ultra-550b-a55b',      // TTFT ~0.9-3.5s
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning', // TTFT ~0.9s
  'openai/gpt-oss-20b',                     // TTFT ~1.6-2.7s
  'meta/llama-3.2-11b-vision-instruct',     // TTFT ~0.8s
  'google/diffusiongemma-26b-a4b-it',       // TTFT ~2.3s
]);

/** 各渠道的快速白名单（可被 env `FAST_MODELS` 整体覆盖，用于临时放宽/收紧） */
const TABLE = {
  nvidia: NVIDIA_FAST_MODELS,
};

let envCache = null;
function envList() {
  if (envCache !== null) return envCache;
  const raw = String(config.fastModels || '').trim();
  envCache = raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : null;
  return envCache;
}

/** 该渠道是否在「快速过滤」范围内 */
export function isFastOnlyChannel(channelName) {
  return FAST_ONLY_CHANNELS.has(String(channelName || ''));
}

/** 某渠道的快速白名单（env 覆盖优先，否则内置表） */
export function fastModelsOf(channelName) {
  const env = envList();
  if (env) return env;
  return TABLE[String(channelName || '')] || [];
}

/**
 * 该模型在**该渠道**下是否属于"快速模型"。
 * 非快速渠道恒为 true（不做过滤）。
 */
export function isFastModel(channelName, modelId) {
  if (!isFastOnlyChannel(channelName)) return true;
  const list = fastModelsOf(channelName);
  return list.includes(String(modelId || ''));
}

/** 过滤一个模型 id 列表（用于拉目录时落库前） */
export function filterFastModels(channelName, ids) {
  if (!isFastOnlyChannel(channelName)) return ids;
  const list = fastModelsOf(channelName);
  return ids.filter((id) => list.includes(String(id)));
}

export default {
  FAST_ONLY_CHANNELS, NVIDIA_FAST_MODELS,
  isFastOnlyChannel, fastModelsOf, isFastModel, filterFastModels,
};
