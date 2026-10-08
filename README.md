# api2api

多渠道 × 多 Key 的聚合路由服务。上游是一堆渠道（每个渠道挂一串 Key），下游暴露统一的 `/v1`，中间做路由、故障转移与 Key 调度。

**核心语义**：不转换协议 —— **原样透传**，只改 `model` 字段和 `Authorization`；只识别错误码用于调度决策。**全渠道依次尝试，首个成功立即返回。**

---

## 特性

| 项 | 说明 |
|---|---|
| 内置渠道 | **商汤日日新**（`sensenova`）、**书生·墨点**（`intern`） |
| 协议 | 原样透传，不做 OpenAI ↔ Anthropic 互转 |
| 路由 | 优先级桶 + smooth-WRR + 冷却队列 + 状态机 |
| 降级 | 渠道内换 Key → 渠道间横向降级（两层） |
| 错误 | 上游错误壳归一化为 OpenAI 格式，保留 `trace_id` |
| Key 管理 | `uuid` 为主键（调用方传入），双判重，AES-256-GCM 加密 |
| 模型映射 | 对外名 → 上游真名，支持渠道专属 / 全局 |
| ⭐ 模型归并 | 别名 → 规范名（`DeepSeek-V4-Flash-0731` 等归一），下游只记一个名字 |
| ⭐ 模型黑名单 | 原始 (渠道 × 上游模型) 永久拉黑，带原因；从清单隐藏 + 不发请求 |
| ⭐ 自动拉黑 | 「从未成功过 + 失败超阈值」的 (渠道,模型) 自动加入黑名单 |
| 测活 | 整渠道（`GET /models`）/ 指定模型（最小 chat 请求） |
| 存储 | SQLite（`node:sqlite`），WAL 模式 |
| 依赖 | **零第三方依赖** —— 只用 Node 内置模块 |
| 监听 | 仅 `127.0.0.1`，外部走 SSH 隧道 |

---

## 用哪个模型名？

下游**直接用上游真名**即可，路由会自动找到有它的渠道。
两家模型名几乎不重叠，所以同一个名字只会命中一家：

| 模型名 | 商汤 | 书生 | 端点 |
|---|:---:|:---:|---|
| `glm-5.2` | ✅ | — | chat |
| `glm-5.3` | — | ✅ | chat |
| `deepseek-v4-pro` | ⚠️ 清单有但 TokenPlan 不可用 | — | chat |
| `deepseek-v4-pro-0813` | — | ✅ | chat |
| `deepseek-v4-flash` | ⚠️ 同上 | — | chat |
| `deepseek-v4-flash-0731` | — | ✅ | chat |
| `kimi-k3` | ⚠️ 同上 | — | chat |
| `kimi-k2.6` | — | ✅ | chat |
| `minimax-m3` | — | ✅ | chat |
| `intern-s2` | — | ✅ | chat（视觉） |
| `qwen3.8-27b` | — | ✅ | chat（视觉） |
| `Atria-Dawn-Preview` | — | ✅ | chat |
| `Agents-A1` | — | ✅ | chat（视觉） |
| `sensenova-6.8-flash-lite` | ✅ | — | chat（视觉） |
| `sensenova-u1-fast` | ✅ | — | **`/v1/images/generations`** |
| `sensenova-u1.5-lite` | ✅ | — | **`/v1/images/generations`** |

想给下游起短名（如 `gpt-4o-mini`）就用**模型映射**（可选），见下文。
跨渠道的同名模型（如上面商汤/书生的 `deepseek-v4-flash-*`）可以用**模型归并**合成一个名字，见下文。

> ⚠️ 清单**不等于** token plan 实际能用。实测 `kimi-k3`、`deepseek-v4-pro` 虽在商汤清单里，
> 调用却返回 `is not supported by TokenPlan`。清单只作参考，真实可用性靠测活确认。
> （不过路由会自动落到有该模型的另一个渠道 —— 若那边能用，请求照样成功。）
> ⭐ 这类**已确定用不了**的模型现在会被**自动拉黑**（见「模型黑名单」），不再出现在清单里、也不再被尝试。

---

## 登录 Web UI

服务**不会**把 admin token 注入页面（`127.0.0.1` 端口容器网络也能访问，注入等于把管理凭证交给本机任意进程）。首次打开页面需要手动粘贴一次：

```bash
# 在 219 上读出来，粘到 Web UI 的「设置 → 本机登录凭据」
cat /opt/api2api/data/admin_token
```

粘贴后存入浏览器 localStorage，之后免输。

---

## 快速开始

```bash
# 1. 部署（在目标机上执行）
cd /opt/api2api
bash deploy/install.sh

# 2. 拿到管理员 token
cat /opt/api2api/data/admin_token

# 3. 加一把 Key（uuid 由你指定，全局唯一）
curl -X POST http://127.0.0.1:3210/api/keys \
  -H "Authorization: Bearer $(cat /opt/api2api/data/admin_token)" \
  -H 'Content-Type: application/json' \
  -d '{"channel":"sensenova","key":"sk-你的密钥","uuid":"my-key-001","name":"小号1"}'

# 4. 测活
curl -X POST http://127.0.0.1:3210/api/keys/check \
  -H "Authorization: Bearer $(cat /opt/api2api/data/admin_token)" \
  -H 'Content-Type: application/json' \
  -d '{"scope":"channel","channel":"sensenova"}'

# 5. 调用（OpenAI 兼容）
curl http://127.0.0.1:3210/v1/chat/completions \
  -H "Authorization: Bearer <你的下游token>" \
  -H 'Content-Type: application/json' \
  -d '{"model":"SenseChat-5-0903","messages":[{"role":"user","content":"你好"}]}'
```

---

## 管理 API

所有 `/api/*` 都需要 `Authorization: Bearer <token>`。

### Key

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/keys` | 加 Key：`{channel, key, uuid, name?, priority?, weight?}` |
| `POST` | `/api/keys/bulk` | 批量：`{channel, keys:[{uuid,key,name?}, ...]}` |
| `GET` | `/api/keys?channel=` | 列出（**永不返回明文**） |
| `GET` | `/api/keys/:uuid` | 单个 |
| `PATCH` | `/api/keys/:uuid` | 改 `{name, priority, weight, enabled}` |
| `DELETE` | `/api/keys/:uuid` | 删 |
| `POST` | `/api/keys/:uuid/reset` | 清除该 Key 的冷却/停用状态 |
| `POST` | `/api/keys/check` | 测活：`{scope:"channel", channel}` 或 `{scope:"model", model, channel?}` |
| `POST` | `/api/keys/check-all` | 便捷测整渠道 |

**判重规则**：`uuid` 全局唯一；**且**同一渠道内密钥不可重复（按 sha256 指纹判重）。

### 模型：上游目录 + 可选映射

**下游能看到哪些模型 = 上游实际有什么。** 点「拉取全部渠道模型」（或 `POST /api/models/fetch`），
把各渠道 `GET /models` 的真实清单拉回来**落库**，下游 `/v1/models` 立刻全部可见，**不需要先建任何映射**。

映射是**额外的、可选的改名层**：

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/aliases?channel=` | 列映射 |
| `POST` | `/api/aliases` | 建：`{public_name, upstream_name, channel?, priority?}` |
| `PATCH` | `/api/aliases/:id` | 改 |
| `DELETE` | `/api/aliases/:id` | 删 |
| `GET` | `/api/models` | 下游可见模型清单（= 上游目录 + 映射叠加） |
| `GET` | `/api/models/upstream` | 上游目录明细（按渠道分组 + 拉取时间） |
| `POST` | `/api/models/fetch` | 拉上游真实模型清单 `{channel}`，**并落库** |
| `DELETE` | `/api/models/upstream?channel=` / `?all=true` | 清空目录 |

**下游清单的合成规则**：

1. 上游目录里的模型**原名列出**（同名直通，下游可直接用）
2. 该上游名若被**全局映射**改名 → 原名折叠，只留对外名
3. 该上游名若被**渠道专属映射**改名 → 只折叠那个渠道，其他渠道原名仍在
4. 映射到的上游名即使不在目录里也照样列出（可能故意指向目录外的模型）
5. ⭐ 被**归并**的别名折叠掉，只留规范名（见下）
6. ⭐ 被**黑名单**拉黑的 `(渠道 × 原始上游模型)` 从清单里彻底消失

**调用解析优先级**：渠道专属映射 > 全局映射 > 同名直通（目录里有该模型的渠道会优先被尝试，避免白跑 404）。

### ⭐ 模型归并（同一个模型，一个名字）

不同渠道的**同一个模型**上游名常常不一样：

```
商汤  deepseek-v4-flash
书生  deepseek-v4-flash-0731
魔搭  deepseek-ai/DeepSeek-V4-Flash-0731
LLM7  deepseek-v4-flash:0731
```

把它们**归并**到一个规范名（如 `deepseek-v4-flash`）后：
下游只用记**一个名字**；调任一别名也会被重定向到规范名，命中**所有**渠道。

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/synonyms` | 列归并 |
| `POST` | `/api/synonyms` | 建：`{name, canonical, note?}` |
| `DELETE` | `/api/synonyms/:name` | 删 |

> 仅大小写不同（`Deepseek-V4-Flash` → `deepseek-v4-flash`）也是合法归并。
> 控制台「模型」页可直接操作。

### ⭐ 模型黑名单（原始渠道 × 原始上游模型）

**「连续失败过多 / 从来没成功过」+「已知确定用不了」的模型会被拉黑**：
从下游模型清单里**隐藏**，转发时**一次请求都不发**；每条都带**可读理由**，可在控制台查看与解禁。

⚠️ 键是 **原始渠道名 + 原始上游模型名**（不是对外名、不是转换后的名字）。

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/blacklist?channel=&source=` | 列黑名单（含原因 / 来源 / 失败成功计数） |
| `POST` | `/api/blacklist` | 手动加入 `{channel, model, reason}` |
| `POST` | `/api/blacklist/unban` | 解禁 `{channel, model}` |
| `POST` | `/api/blacklist/sync-fast` | 按「只接快速模型」开关重算 fast-mode 拉黑 |

**来源**（`source`）：

| 值 | 含义 |
|---|---|
| `builtin` | 内置「已确定用不了」名单（来自逐模型实测，见 `tools/scan-result-2026-10-07.md`） |
| `fast-mode` | 快速模式未收录（目录虚胖渠道，只保留实测可用的快速模型） |
| `auto` | 连续失败自动加入（**从未成功过** 且失败 ≥ `MODEL_AUTO_BAN_AFTER_FAILS`） |
| `manual` | 人工加入 |

### ⭐ 运行开关（`GET/PATCH /api/settings`）

| 字段 | 默认 | 说明 |
|---|:---:|---|
| `fastModelsOnly` | **开** | 只接快速模型（目录虚胖渠道如 NVIDIA）；开关变化会**同步 fast-mode 拉黑** |
| `blacklistEnabled` | **开** | 模型黑名单总开关；关闭后**只记录、不拦截** |
| `autoBlacklistEnabled` | **开** | 是否自动把「从未成功过 + 失败超阈值」的 (渠道,模型) 拉黑 |

### 渠道 / 观测 / Token

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/channels` | 渠道列表（含 Key 计数、`sortOrder`） |
| `POST` | `/api/channels/reorder` | **渠道优先级**整体重排 `{order:["sensenova","intern","openrouter"]}` |
| `PATCH` | `/api/channels/:id` | 改展示名 / 默认模型 / 启停（**不可改 base_url**） |
| `GET` | `/api/tokens` | token 列表（仅指纹） |
| `POST` | `/api/tokens` | 新建，**明文只返回一次** |
| `DELETE` | `/api/tokens/:name` | 删除 |
| `GET` | `/api/stats` | 汇总统计 |
| `GET` | `/api/stats/states` | 调度状态明细 |
| `GET` | `/api/logs?limit=` | 请求流水 |
| `POST` | `/api/logs/prune` | 清理旧流水 `{keep}` |
| `GET` | `/healthz` | 存活探针（免鉴权） |

---

## 对外 API

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/v1/chat/completions` | OpenAI 兼容，支持流式 |
| `POST` | `/v1/images/generations` | 文生图（商汤 `sensenova-u1-fast` / `u1.5-lite`） |
| `POST` | `/v1/messages` | Anthropic 协议（商汤支持） |
| `POST` | `/v1/embeddings` | 向量 |
| `POST` | `/v1/completions` | 补全 |
| `GET` | `/v1/models` | 列出对外暴露的模型名 |

> 所有 POST 端点共用**同一条转发路径** —— 只替换 `body.model` 后原样透传，不做协议转换。
> 想加新端点，在 `src/http/v1.mjs` 的 `PASSTHROUGH` 集合里加一行即可。

鉴权用 `/api/tokens` 签发的 token。**客户端永远拿不到上游 Key** —— 两条信任链完全隔离。

---

## 路由算法

### 渠道优先级（严格分层）

**顺序 = 渠道的「路由顺序」，在「渠道」页拖动调整**（对应 `channel.sort_order`）：

```
sensenova (10)  >  intern (20)  >  openrouter (30)
```

一个模型被多个渠道支持时，**先把这个渠道的 Key 全部试完，才降级到下一个渠道**。
只有低优先级渠道才有该模型时（如 `glm-5.3` 只在书生），才去那个池子。

每个渠道有**独立的尝试预算**（`MAX_ATTEMPTS_PER_CHANNEL`，默认 8），
不会出现"商汤 Key 太多、把全局预算吃光、书生根本没机会"的情况。

### 三层决策

```
请求 model=X
 └─ L0 按上游目录剔除"确认没有该模型"的渠道（省掉必败的真实请求）
     └─ L1 按渠道优先级分层遍历
         └─ L2 渠道内按 priority 桶选 Key（**填满优先**，见下）
             ├─ Key 失败 → 冷却，换同渠道下一把 Key
             ├─ 「本渠道没这个模型」→ 跳过本渠道剩余 Key，直接落下一渠道
             └─ 全渠道耗尽 → 状态码按主导错误给 + retry_after
```

**L0 的判据必须区分「未知」和「没有」**：

| 情况 | 处理 |
|---|---|
| 拉过目录，名单里确实没有 | **跳过**（必败，省一次真实请求） |
| **从没拉过目录** | **照试**（未知 ≠ 没有，否则新渠道永远调不通） |
| 所有候选都"确认没有" | **回退全试**（目录可能过期，不能凭空 503） |

### Key 选取策略

**默认「填满优先」**（`SCHEDULER_POLICY=fill_first`）—— **不轮询**。

语义：始终用**排在最先的可用 Key**，把它用满（失败或触达每 Key RPM 上限）才换下一把。

```
7 把 Key，RPM 上限 2，连发 6 次请求：
  Key#1: ●●       ← 用满 2 次
  Key#2:   ●●     ← 才轮到第 2 把
  Key#3:     ●●
  Key#4-7: 完全没动
```

好处：Key 远多于需求时只消耗前几把，剩余 Key 保持"全新"；失败与冷却集中在少数 Key 上，观察和运维都简单。

**每 Key RPM 是软约束**（`KEY_RPM_LIMIT`，默认 2）：
优先跳过已达上限的 Key；若**整桶都达上限**，退而选最快解除限制的那把 ——
只有一把 Key 的用户**绝不能因为限速而不可用**。

想改成轮询：`SCHEDULER_POLICY=weighted`（smooth-WRR，按 `weight` 摊开）。

### 失败冷却（线性递增）

「连续失败」计数一旦**成功立刻归零** —— 中间成功过就重新从第 1 次算。

| 连续失败 | 动作 |
|---|---|
| 第 1 次 | 冷却 **10 分钟** |
| 第 2 次 | 冷却 **20 分钟** |
| 第 3 次 | 冷却 **30 分钟** |
| … | 每次 +10 分钟 |
| 第 9 次 | 冷却 **90 分钟** |
| 第 10 次 | **禁用**，24 小时后自动恢复并清零计数 |
| 任意时刻成功一次 | **立即恢复健康**（`READY`，计数清零） |

冷却时长 = `COOLDOWN_STEP_MS` × 连续失败次数，上限 `COOLDOWN_MAX_MS`。
在「Key 管理」页的**运行状态**列能直接看到 `正常 / 冷却中（剩余 X 分 Y 秒）/ 已禁用（剩余 X 小时）`，
倒计时每秒自走，无需刷新。

### 模型名友好化

上游模型名常带噪音，下游不该看到：

```
deepseek.ai/deepseek-v4.1-flash:free   →  deepseek-v4.1-flash   和  Deepseek-V4.1-Flash
google/gemma-4-31b-it:free             →  gemma-4-31b-it        和  Gemma-4-31b-It
```

**拉取上游模型清单时会自动生成这两种友好名**（挂在该渠道下）。
**上游原名照样可以调用**（同名直通），友好名只是额外入口。
干净的名字（`glm-5.2`）不造别名，避免噪音。

### 错误分类与动作

| 上游响应 | 归类 | 换 Key？ | 换渠道？ | 动作 |
|---|---|---|---|---|
| 2xx | `ok` | — | — | 返回，回写健康 |
| 429 / 配额 / TPM-RPM 超限 | `quota` | ✅ | ✅ | 指数退避冷却（1s→15min） |
| 401 Key 无效 | `auth` | ✅ | ✅ | 连败达阈值则 `DISABLED` |
| 403 风控 | `auth` | ✅ | ✅ | 长冷却 |
| 404 **本渠道**没这个模型 | `config_fault` | ❌ | ✅ | **跳渠道**（`skip_channel`） |
| 400 / 422 / 上下文超长 | `request_fault` | ❌ | ❌ | **原样返回**（换谁也白搭） |
| 408 / 5xx | `transient` | ✅ | ✅ | 短冷却，最多试 3 次 |

**两个关键设计（均为真 Key 实测后修正）**：

1. **`config_fault` 必须可跨渠道** —— `glm-5.3` 只在书生有，商汤回 404。
   若当 fatal 处理，路由会在第一个渠道就停住，跨渠道能力直接失效 ——
   而"模型在哪个渠道存在就落到哪个渠道"正是本项目的核心价值。
   同时它触发 `skip_channel`：该渠道剩下一把 Key 都不必再撞（结果必然相同），
   且**不惩罚 Key**（模型不存在不是 Key 的错）。

2. **全渠道耗尽时，状态码/消息/code 都取自「主导错误」，且彼此同源** ——
   主导错误的优先级是 `quota > transient > auth > config_fault > no_key`，
   因为可恢复错误意味着"稍后重试可能成功"，不能因为最后一条恰好是"模型缺失"
   就告诉客户端永久放弃。曾经出现过 `429 + "不支持该模型"` 这种自相矛盾的响应。

### 明确不做

- 协议转换
- 配额 / 额度窗口识别（无窗口推测器、无 quota budget）
- 劫持式透明反代
- 公网暴露

---

## 调参（环境变量或 `data/config.json`）

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `3210` | 监听端口 |
| `HOST` | `127.0.0.1` | 监听地址。**默认仅本机**；改成 `0.0.0.0` 会暴露给整个网段（见 §安全说明） |
| `MAX_ATTEMPTS` | `48` | 单请求全局最大尝试数（**要够大，别成为渠道降级的瓶颈**） |
| `MAX_ATTEMPTS_PER_CHANNEL` | `8` | 单渠道最多试几把 Key，用满才降级下一渠道 |
| `UPSTREAM_TIMEOUT_MS` | `120000` | 上游请求超时 |
| `UPSTREAM_CONNECT_TIMEOUT_MS` | `15000` | 测活/连接阶段超时 |
| `SCHEDULER_POLICY` | `fill_first` | `fill_first`（**填满优先，默认，不轮询**）/ `weighted`（平滑加权轮询） |
| `KEY_RPM_LIMIT` | `2` | 每把 Key 每分钟最多发起多少次上游请求；`0` = 不限速 |
| `COOLDOWN_STEP_MS` | `600000` | 冷却步长（10 分钟）× 连续失败次数 = 本次冷却时长 |
| `COOLDOWN_MAX_MS` | `5400000` | 冷却上限（90 分钟，即第 9 次失败时的时长） |
| `DISABLE_AFTER_FAILS` | `10` | 连续失败多少次后禁用 Key |
| `DISABLED_RECOVER_MS` | `86400000` | 被禁用后多久自动恢复（24 小时） |
| `DOWNSTREAM_RETRY_AFTER_MS` | `20000` | 全渠道耗尽时给客户端的重试建议（**≠** 内部冷却） |
| ⭐ `BLACKLIST_ENABLED` | `1` | 模型黑名单总开关（`0` = 只记录不拦截）；可在控制台切换 |
| ⭐ `AUTO_BLACKLIST` | `1` | 是否自动把「从未成功过 + 失败超阈值」的 (渠道,模型) 拉黑 |
| ⭐ `MODEL_AUTO_BAN_AFTER_FAILS` | `10` | 自动拉黑阈值：从未成功过且累计失败达此数 → 拉黑 |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |

> `DOWNSTREAM_RETRY_AFTER_MS` 默认 20 秒而非内部冷却的 10 分钟：它只是"建议客户端何时再来"，
> 给太久会让客户端在 Key 已恢复后仍干等；内部冷却才是真正的 Key 保护。

---

## 目录结构

```
api2api/
├── server.mjs                # 入口：HTTP 服务 + 路由分发
├── src/
│   ├── config.mjs            # 配置加载
│   ├── relay.mjs             # ⭐ 转发核心（首个成功即返回）
│   ├── util/                 # 日志 / 错误分类 / 加密
│   ├── db/                   # schema / 渠道 / Key / 映射 / 归并 / 黑名单 / 状态 / 流水 / token
│   ├── adapters/             # ⭐ 适配器：sensenova / intern / 通用 + 测活探针
│   ├── scheduler/            # ⭐ 调度：优先级桶 / 填满优先 / RPM 限速 / 线性冷却
│   └── http/                 # /v1 对外 + /api 管理 + 静态文件
├── web/                      # Web UI（HTML / CSS / JS 严格分离）
├── test/                     # 冒烟 + 端到端 + **老库迁移回归**
├── deploy/                   # systemd unit + 安装/运维脚本
└── data/                     # SQLite / 主密钥 / admin token（gitignore）
```

---

## 运维

```bash
bash deploy/api2api-ctl.sh status     # 状态
bash deploy/api2api-ctl.sh token      # 打印 token
bash deploy/api2api-ctl.sh logs       # 跟踪日志
bash deploy/api2api-ctl.sh backup     # 备份库+密钥
bash deploy/api2api-ctl.sh restart    # 重启
```

---

## 测试

```bash
node --no-warnings test/smoke.test.mjs     # 178 项单元/集成
node --no-warnings test/e2e.test.mjs       # 54 项端到端（含 mock 上游）
node --no-warnings test/migrate.test.mjs   # 18 项老库迁移回归
node --no-warnings test/_loadcheck.mjs     # 模块加载自检
```

**本地与 219 上均为 250/250 全绿。**

> `migrate.test.mjs` 存在的理由：新 schema 曾在 DDL 里给老库尚不存在的列建索引，
> 导致 `no such column: disabled_until` → 进程退出 → systemd 无限重启。
> 这个测试**构造一个真正的老库**，验证「建表 → 补列 → 建索引」的顺序不会再错。

### 真 Key 实测记录（2026-10-06）

用商汤与书生的真实 Key 打通了成功路径，拿到以下结论：

| 验证项 | 结果 |
|---|---|
| 跨渠道自动落位 | ✅ `glm-5.3`、`minimax-m3` 商汤 404 → 自动落书生 200 |
| 单渠道直通 | ✅ `glm-5.2` 商汤 200 |
| 流式透传 | ✅ SSE 帧原样返回 |
| 上游目录落库 | ✅ 拉取后下游 `/v1/models` **立刻看到 19 个**（商汤 9 + 书生 10），**零映射** |
| 原名直接可调 | ✅ 未建任何映射，`glm-5.3` / `glm-5.2` / `minimax-m3` 全部 200 |
| 映射叠加 | ✅ 建 `gpt-4o → glm-5.2` 后调用成功，下游总数仍为 19（上游名折叠） |
| 测活探针 | ✅ `GET /v1/models` 零成本验活（商汤 141ms、书生 223ms） |
| 真实模型名 | **商汤 9 个**：`glm-5.2` `deepseek-v4-flash` `deepseek-v4-pro` `deepseek-flash` `deepseek-v4.1-flash` `kimi-k3` `sensenova-u1-fast`(文生图) `sensenova-u1.5-lite`(文生图) `sensenova-6.8-flash-lite`(视觉)<br>**书生 10 个**：`glm-5.3` `minimax-m3` `intern-s2` `qwen3.8-27b` `Atria-Dawn-Preview` `Agents-A1` `kimi-k2.6` `deepseek-v4-flash-0731` `deepseek-v4-flash-vision` `deepseek-v4-pro-0813` |

> ⚠️ 清单里的模型**不保证** token plan 能用 ——
> 实测 `kimi-k3`、`deepseek-v4-pro` 虽在商汤清单里，调用却返回
> `is not supported by TokenPlan`（404）。真实可用性靠测活确认；
> 但请求不会被浪费 —— 路由会自动落到另一个渠道，那边能用就照样成功。
> `sensenova-u1*` 是 `output_modalities: ["image"]` 的文生图模型，
> 走 `/v1/images/generations`（用 chat 端点会 404）。

**两家错误壳差异（归一化层必须处理的依据）**：

| 上游 | 场景 | 原始壳 |
|---|---|---|
| 商汤 | 认证失败 | `{"error":{"code":16,"message":"Forbidden"}}` — gRPC 数字壳 |
| 商汤 | 业务错误 | `{"error":{"message":"...","type":"...","code":"3"/"5"}}` — **标准壳但 code 是字符串** |
| 商汤 | 限流 | `code:"RateLimitExceeded.EndpointRPMExceeded"` / `"ModelAccountTpmRateLimitExceeded"` |
| 书生 | 全部 | 标准 OpenAI 壳，带 `trace_id` + `request_id` |
| 书生 | 模型不可用 | `type:"model_not_available"`（**不是** `model_not_found`） |

> 结论：商汤**同一端点内有两套壳**，且字符串 code 必须优先于数字 code 判断 ——
> 否则 `"field MaxTokens invalid"` 会被文本规则里的 `token.*invalid` 误判成 AUTH。

### 实测中发现并修掉的缺陷

1. **`config_fault` 被误当 fatal** → 跨渠道能力失效（P0）
2. **商汤字符串 code 未识别** → 429 被误判 `transient`、404 被误判 `transient`
3. **书生 `model_not_available` 未映射** → 误判 `transient`
4. **适配器给出"不确定"时未用 HTTP 状态纠正** → 分类偏弱
5. **全渠道耗尽只取最后一条错误** → 状态码/消息/code 三处错配
6. **`Retry-After` 用了 1 秒级内部冷却** → 客户端立刻重试加重限流
7. **e2e 端口写死 3999** → 上轮残留进程导致串扰，一串 `fetch failed` 被误读成代码 bug

---

## 安全说明

- 服务只监听 `127.0.0.1`，外部必须走 SSH 隧道
- 上游 Key 用 AES-256-GCM 加密存储，主密钥在 `data/master.key`（`chmod 600`）
- 下游 token 只存 sha256
- 请求日志不记录任何明文密钥
- `data/` 目录不应提交到版本库
