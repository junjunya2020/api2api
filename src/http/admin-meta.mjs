/**
 * 管理 API · 渠道 / 观测 / token。
 *
 *   GET   /api/channels              列出渠道（含 Key 计数）
 *   GET   /api/channels/:id          单渠道
 *   PATCH /api/channels/:id          改展示名/默认模型/启停（不改 base_url）
 *   GET   /api/tokens                列下游 token（不含明文）
 *   POST  /api/tokens                新建 token，**明文只在此处返回一次**
 *   DELETE /api/tokens/:name         删除
 *   GET   /api/stats                 汇总统计
 *   GET   /api/stats/states          调度状态明细
 *   GET   /api/logs                  最近请求流水
 *   POST  /api/logs/prune            清理历史流水
 *   GET   /healthz                   存活探针
 */
import * as channels from '../db/channels.mjs';
import * as tokens from '../db/tokens.mjs';
import * as logs from '../db/logs.mjs';
import * as state from '../db/state.mjs';
import * as settings from '../db/settings.mjs';
import * as blacklist from '../db/channel-ban.mjs';
import { keyStats } from '../db/keys.mjs';
import { publicModelList } from '../db/aliases.mjs';
import { adapterIds } from '../adapters/index.mjs';
import { FAST_ONLY_CHANNELS, fastModelsOf } from '../db/fast-models.mjs';
import { readJson, sendJson, matchPath, HttpError } from './util.mjs';
import config from '../config.mjs';

export async function handleMeta(req, res, url) {
  const { pathname } = url;
  const method = req.method;

  // ---- 渠道 ----
  if (pathname === '/api/channels' && method === 'GET') {
    return sendJson(res, 200, {
      channels: channels.publicChannelBrief(),
      builtinAdapters: adapterIds(),
    });
  }

  // ---- 运行设置（用户可在控制台切换，立即生效）----
  if (pathname === '/api/settings' && method === 'GET') {
    return sendJson(res, 200, {
      settings: settings.allSettings(),
      /** 说明「快速模型」白名单现状 */
      fast: {
        channels: [...FAST_ONLY_CHANNELS],
        models: [...FAST_ONLY_CHANNELS].flatMap((ch) => fastModelsOf(ch)),
      },
    });
  }
  if (pathname === '/api/settings' && method === 'PATCH') {
    const body = await readJson(req);
    const out = {};
    const changed = [];

    if (body && body.fastModelsOnly !== undefined) {
      out.fastModelsOnly = settings.setFastModelsOnly(!!body.fastModelsOnly);
      changed.push('fastModelsOnly');
      // ⭐ 快速模式开关变更 → 同步 fast-mode 拉黑（NVIDIA 未收录模型）。
      //    开 → 未收录的拉黑；关 → 移除 fast-mode 拉黑。用户要求「nvidia 那些模型
      //    开启了快速模式后就默认拉黑」。
      //
      //    ⚠️ 这里扫的是**当前目录**，所以只能覆盖"目录里还在、但不在白名单里"的
      //       残留。新拉目录时被白名单挡掉的模型**根本不会入库** ——
      //       那部分由 `/api/models/fetch` 在过滤的当下直接 `banMany` 落黑名单。
      //       两处配合才能做到「快速模式收录之外的都拉黑」。
      try {
        out.fastModeSync = blacklist.applyFastModeBans(out.fastModelsOnly);
      } catch (e) {
        out.fastModeSync = { error: e.message };
      }
    }
    if (body && body.blacklistEnabled !== undefined) {
      out.blacklistEnabled = settings.setBlacklistEnabled(!!body.blacklistEnabled);
      changed.push('blacklistEnabled');
    }
    if (body && body.autoBlacklistEnabled !== undefined) {
      out.autoBlacklistEnabled = settings.setAutoBlacklistEnabled(!!body.autoBlacklistEnabled);
      changed.push('autoBlacklistEnabled');
    }
    if (!changed.length) {
      throw new HttpError(400, '没有可更新的字段（支持 fastModelsOnly / blacklistEnabled / autoBlacklistEnabled）');
    }
    return sendJson(res, 200, { ok: true, changed, settings: settings.allSettings(), ...out });
  }

  // 渠道优先级整体重排：前端拖拽后一次性提交完整顺序。
  // 放在 :id 匹配**之前**，否则 'reorder' 会被当成渠道 id。
  if (pathname === '/api/channels/reorder' && method === 'POST') {
    const body = await readJson(req);
    const order = Array.isArray(body?.order) ? body.order.map(String) : null;
    if (!order || !order.length) {
      throw new HttpError(400, '需要 order 数组，例如 {"order":["sensenova","intern","openrouter"]}');
    }
    const list = channels.reorderChannels(order);
    return sendJson(res, 200, {
      ok: true,
      order: list.map((c) => ({ name: c.name, displayName: c.display_name, sortOrder: c.sort_order })),
    });
  }

  const pc = matchPath('/api/channels/:id', pathname);
  if (pc) {
    if (method === 'GET') {
      const ch = channels.getChannel(pc.id);
      if (!ch) throw new HttpError(404, `渠道不存在: ${pc.id}`);
      return sendJson(res, 200, { channel: channels.publicChannelBrief().find((c) => c.id === ch.id) });
    }
    if (method === 'PATCH' || method === 'PUT') {
      const body = await readJson(req);
      const ch = channels.getChannel(pc.id);
      if (!ch) throw new HttpError(404, `渠道不存在: ${pc.id}`);
      const updated = channels.updateChannel(ch.id, body);
      return sendJson(res, 200, { ok: true, channel: channels.publicChannelBrief().find((c) => c.id === updated.id) });
    }
  }

  // ---- token ----
  if (pathname === '/api/tokens') {
    if (method === 'GET') {
      return sendJson(res, 200, {
        // 只给 hash 前缀，便于区分；明文不可再取
        tokens: tokens.listTokens().map((t) => ({
          hashPrefix: t.token_hash.slice(0, 12),
          name: t.name,
          enabled: !!t.enabled,
          createdAt: t.created_at,
          lastUsedAt: t.last_used_at,
        })),
      });
    }
    if (method === 'POST') {
      const body = await readJson(req).catch(() => ({}));
      const created = tokens.createToken(body?.name ?? null);
      return sendJson(res, 201, {
        ok: true,
        token: created.token,
        name: created.name,
        warning: '明文 token 只返回这一次，请立即保存',
      });
    }
  }

  const pt = matchPath('/api/tokens/:name', pathname);
  if (pt && method === 'DELETE') {
    const ok = tokens.deleteToken(pt.name);
    if (!ok) throw new HttpError(404, `token 不存在: ${pt.name}`);
    return sendJson(res, 200, { ok: true, deleted: true });
  }

  // ---- 观测 ----
  if (pathname === '/api/stats' && method === 'GET') {
    return sendJson(res, 200, {
      channels: channels.publicChannelBrief(),
      keyStats: keyStats(),
      modelCount: publicModelList().length,
      byChannel: logs.statsByChannel(),
      errClasses: logs.errClassDistribution(2000),
      stateSummary: state.stateSummary(),
      config: {
        port: config.port,
        host: config.host,
        maxAttempts: config.maxAttempts,
        upstreamTimeoutMs: config.upstreamTimeoutMs,
      },
    });
  }

  if (pathname === '/api/stats/states' && method === 'GET') {
    const now = Date.now();
    return sendJson(res, 200, {
      states: state.listStates({ channel: url.searchParams.get('channel') }).map((s) => {
        // 已到期的冷却/禁用视为已恢复 —— 惰性维护要等下一次 pickKey 才跑，
        // 观测页不该显示一个其实已经过期的"冷却中"。
        const expired = (s.state === 'COOLDOWN' && s.next_retry_at && s.next_retry_at <= now)
          || (s.state === 'DISABLED' && s.disabled_until && s.disabled_until <= now);
        const until = s.state === 'DISABLED' ? s.disabled_until : s.next_retry_at;
        return {
          keyUuid: s.key_uuid,
          keyName: s.key_name,
          channel: s.channel_name,
          model: s.model,
          state: expired ? 'READY' : s.state,
          nextRetryAt: s.next_retry_at,
          disabledUntil: s.disabled_until,
          /** 距离恢复还有多久（毫秒）；READY 时为 0 */
          remainingMs: expired || !until ? 0 : Math.max(0, until - now),
          failStreak: s.fail_streak,
          totalOk: s.total_ok,
          totalFail: s.total_fail,
          lastUsedAt: s.last_used_at,
          lastError: s.last_error,
        };
      }),
      /** 调度规则，便于观测页给出与 Key 列表一致的说明 */
      scheduler: {
        policy: config.schedulerPolicy,
        keyRpmLimit: config.keyRpmLimit,
        cooldownStepMs: config.cooldownStepMs,
        disableAfterFails: config.disableAfterFails,
        disabledRecoverMs: config.disabledRecoverMs,
      },
    });
  }

  if (pathname === '/api/logs' && method === 'GET') {
    const limit = Math.min(Number(url.searchParams.get('limit')) || 100, 1000);
    return sendJson(res, 200, {
      logs: logs.recentLogs(limit, { model: url.searchParams.get('model') }),
    });
  }

  if (pathname === '/api/logs/prune' && method === 'POST') {
    const body = await readJson(req).catch(() => ({}));
    const keep = Number.isFinite(+body?.keep) ? Math.max(0, Math.trunc(+body.keep)) : 20000;
    const removed = logs.pruneLogs(keep);
    return sendJson(res, 200, { ok: true, removed, keep });
  }

  return false;
}
