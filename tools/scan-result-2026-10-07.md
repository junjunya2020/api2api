# 模型实测结论（2026-10-07）

> 用 `tools/model-scan.mjs` 逐个模型打上游得到，**不是猜的**。
> 商汤每个模型测 3 次、书生测 1 次；商汤结果 3/3 完全一致。
> 扫描是**纯只读**的 —— 只发请求 + 统计，不写任何 `key_state` / `model_health`。

## 商汤（sensenova）· 每模型 3 次

| 模型 | 结果 | HTTP | upstream code | 消息 |
|---|---|---|---|---|
| `deepseek-v4-flash` | ✅ 3/3 成功 | 200 | — | — |
| `glm-5.2` | ✅ 3/3 成功 | 200 | — | — |
| `sensenova-6.8-flash-lite` | ✅ 3/3 成功 | 200 | — | — |
| `sensenova-u1-fast` | ❌ 3/3 `config_fault` | 404 | `5` | `model is not found` |
| `sensenova-u1.5-lite` | ❌ 3/3 `config_fault` | 404 | `5` | `model is not found` |
| `deepseek-v4-pro` | ❌ 3/3 `quota` | 429 | `RateLimitExceeded.EndpointRPMExceeded` | `inference exceeds tpm/rpm limit` |
| `deepseek-flash` | ❌ 3/3 `quota` | 429 | `RateLimitExceeded.EndpointRPMExceeded` | `inference exceeds tpm/rpm limit` |
| `kimi-k3` | ❌ 3/3 `quota` | 429 | **`ModelAccountTpmRateLimitExceeded`** | `inference exceeds tpm/rpm limit` |
| `deepseek-v4.1-flash` | ❌ 3/3 `auth` → **已归一到 `config_fault`** | 403 | `7` | `model is not available in the current token plan` |

## 书生（intern）· 每模型 1 次

**10/10 全部成功** —— 本周书生侧没有可用性问题。

`Agents-A1` `Atria-Dawn-Preview` `deepseek-v4-flash-0731` `deepseek-v4-flash-vision`
`deepseek-v4-pro-0813` `glm-5.3` `intern-s2` `kimi-k2.6` `minimax-m3` `qwen3.8-27b`

---

## 三条关键结论

### ① `kimi-k3` 是**账号级** TPM 限流
它的 code 是 `ModelAccountTpmRateLimitExceeded`（**Account** TPM），
与 `deepseek-v4-pro` / `deepseek-flash` 的 `EndpointRPMExceeded`（端点 RPM）不同。

含义：这是**整个账号对该模型的 TPM 上限**，
不是"换把 Key 就好" —— 换 Key 打同一模型照样 429。
→ **绝不能把它算在 Key 头上**（算上就会把 Key 池烧穿，正是用户说的问题）。

### ② 商汤 9 个模型里只有 **3 个真能用**
`deepseek-v4-flash` / `glm-5.2` / `sensenova-6.8-flash-lite`。

剩下 6 个分成三类，**必须区别对待**：

| 类别 | 模型 | 正确处理 |
|---|---|---|
| 画图模型打错端点（不是坏） | `sensenova-u1-fast` `sensenova-u1.5-lite` | 走 `/v1/images/generations`；chat 的 404 **不计入健康度** |
| 持续 429（模型级限流） | `deepseek-v4-pro` `deepseek-flash` `kimi-k3` | 预置 DEGRADED，只试 1 次，**不烧 Key** |
| 不在 token plan | `deepseek-v4.1-flash` | 归一到 `config_fault`：跳过渠道、**不惩罚 Key**、正常计入模型健康度 |

### ③ 「不在套餐」的 403 曾被误判为 AUTH —— 这是个**会禁用 Key** 的坑
`deepseek-v4.1-flash` 返回 `403 code=7(PERMISSION_DENIED)`。
按 gRPC 表走会被归成 **AUTH**，而 AUTH 在调度里的动作是
**递增冷却直到禁用整把 Key** —— 一个"套餐里没这个模型"的错误
就会把一把完好的 Key 废掉，完全违反用户要求的
「ban 的话只 ban 模型，不 ban key」。

已在 `src/adapters/sensenova.mjs` 加**模型级覆盖**
（`MODEL_LEVEL_AUTH_TEXT`）：数字 code 属 AUTH 且消息命中
`token plan` / `not available in the current` 等特征时，
改判 `CONFIG_FAULT`。纯文本路径也加了同样的前置判断。

---

## 复现方式

```bash
# 在 219 上（需要 /root/api2api/data 里的真实 Key）
cd /root/api2api
PER_MODEL=3 GAP_MS=2500 ONLY=sensenova node tools/model-scan.mjs 2>&1
```

参数：
- `PER_MODEL` 每个模型打几次（默认 1；建议 ≥3 才能判定"稳定失败"）
- `GAP_MS` 调用间隔毫秒（默认 1500；太密会把自己打成 429，污染结论）
- `TIMEOUT` 单次超时毫秒（默认 20000）
- `ONLY` 只测指定渠道，逗号分隔

⚠️ **必须留间隔**：连续打同一模型会触发自身限流，
把"模型本来正常"测成"429"。（本次用 2.5s 间隔，结果 3/3 一致，可信。）
