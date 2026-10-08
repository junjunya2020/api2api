/**
 * ⭐ 内置"已确定用不了"的模型黑名单。
 *
 * 用户要求（2026-10-08）：
 *   「之前确定用不了的模型就直接拉黑了 让用户能看到 为什么拉黑」
 *
 * 数据来源 = `tools/scan-result-2026-10-07.md`（**逐个模型打上游实测**，不是猜的）：
 *   商汤 9 个模型里只有 3 个真能用（每模型打 3 次、结果 3/3 一致）。
 *
 * ⚠️ 键是 **原始渠道名 + 原始上游模型名**（用户明确要求），
 *    所以这里写的是上游真名（`deepseek-v4-pro`），不是对外名。
 *
 * ⚠️ 每条都必须给出**人类可读的理由** —— 用户要求"让用户能看到为什么拉黑"。
 *
 * ⚠️ 与 `model-rules.mjs` 的区别：
 *   model-rules 给的是"首次遇到时的初始健康度"（DEGRADED/UNAVAILABLE），
 *   是**会恢复的**（24h 后降级观察、成功一次即回 NORMAL）。
 *   本表是**永久拉黑**：不发请求、不出现在模型清单、只能手动解禁。
 *   两者叠加不冲突：先被健康度标记、迟迟不恢复的，才值得进这张表。
 */
import { BanSource } from './channel-ban.mjs';

export const BUILTIN_BANS = [
  // ==========================================================
  // 商汤：9 个模型实测只有 3 个能用（3/3 稳定），其余 6 个全部拉黑
  // ==========================================================
  {
    channel: 'sensenova',
    model: 'sensenova-u1-fast',
    reason: '实测 3/3 用 chat 端点返回 404「model is not found」——这是**文生图**模型，'
      + '走 /v1/images/generations 而非 chat/completions，放在 chat 清单里必然调不通。',
    source: BanSource.BUILTIN,
  },
  {
    channel: 'sensenova',
    model: 'sensenova-u1.5-lite',
    reason: '实测 3/3 用 chat 端点返回 404「model is not found」——文生图模型（同上），'
      + '非 chat 端点，chat 清单里无法调用。',
    source: BanSource.BUILTIN,
  },
  {
    channel: 'sensenova',
    model: 'deepseek-v4-pro',
    reason: '实测 3/3 返回 429「inference exceeds tpm/rpm limit」'
      + '（code=RateLimitExceeded.EndpointRPMExceeded）——该模型在此渠道持续限流，'
      + '换 Key 打同一模型照样 429，属于模型级问题，不要浪费尝试。',
    source: BanSource.BUILTIN,
  },
  {
    channel: 'sensenova',
    model: 'deepseek-flash',
    reason: '实测 3/3 返回 429「inference exceeds tpm/rpm limit」'
      + '（code=RateLimitExceeded.EndpointRPMExceeded）——同 deepseek-v4-pro，模型级持续限流。',
    source: BanSource.BUILTIN,
  },
  {
    channel: 'sensenova',
    model: 'kimi-k3',
    reason: '实测 3/3 返回 429，code=**ModelAccountTpmRateLimitExceeded** —— '
      + '注意是「账号级」TPM 上限（不是端点级），换任何 Key 都没用。',
    source: BanSource.BUILTIN,
  },
  {
    channel: 'sensenova',
    model: 'deepseek-v4.1-flash',
    reason: '实测 3/3 返回 403 code=7「model is not available in the current token plan」——'
      + '该模型不在当前套餐内（不是 Key 无权限）。已由适配器归一到 config_fault，'
      + '这里再拉黑以免每次都被尝试一遍。',
    source: BanSource.BUILTIN,
  },
];

export default { BUILTIN_BANS };
