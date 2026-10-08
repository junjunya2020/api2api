/**
 * 模型指纹测试 —— 调 vendored 的 lm-detector（`vendor/lm-detector`）。
 *
 * 用户要求（2026-10-08）：
 *   「把这个仓库加入子模块 https://github.com/Ikaleio/lm-detector.git 然后搞调用函数
 *     测试模型指纹就用这个」
 *   「测试指纹是自动去到后台任务的」「单独指纹测试页面……也是在后台测试，
 *     但是前台只是实时看到，关闭浏览器不影响进度」
 *
 * 调用方式：lm-detector 的 CLI 有 `--json` 输出（schema `fpd-detection-v1`）。
 * 我们在服务器上跑它（root 权限，无需 --allow 参数；容器里才必须加）。
 *
 * ⚠️ 关键约束：给它的 baseUrl 必须是 **api2api 自己的 `/v1`**，
 *    这样指纹测试才会真正经过网关（用的是网关里配置的**上游真 Key**，
 *    上游 Key 永不出网关）。同时把「只接快速模型」在白名单期间关掉，
 *    否则很多模型会被 fast-mode 拦截，测不了。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import config from '../config.mjs';
import log from '../util/log.mjs';
import { getChannel } from '../db/channels.mjs';
import { fastModelsOnly, setFastModelsOnly } from '../db/settings.mjs';

/** lm-detector 在仓库里的位置（子模块） */
export function detectorDir() {
  return config.detectorDir;
}

export function detectorReady() {
  const dir = detectorDir();
  return !!dir && fs.existsSync(path.join(dir, 'cli', 'fpd.ts'));
}

/** 检测该用哪个 bun 可执行文件跑 lm-detector */
function findBun() {
  const cands = [
    process.env.BUN_BIN,
    '/root/.bun/bin/bun',
    '/usr/local/bin/bun',
    '/usr/bin/bun',
    // Windows 本机调试用
    'C:/Users/aaa/.bun/bin/bun.exe',
  ].filter(Boolean);
  for (const c of cands) {
    try { if (fs.existsSync(c)) return c; } catch { /* ignore */ }
  }
  return 'bun'; // 交给 PATH
}

/**
 * 跑一次指纹检测，返回结构化结果。
 *
 * ⚠️ API Key 通过 **环境变量** 传给子进程（`API_KEY`，lmfpd 支持），
 *    不放命令行 —— 否则 `ps` 就能看到正在使用的 Key。
 *
 * @param {{baseUrl:string, apiKey:string, model:string, api?:string, repeat?:number,
 *          timeoutSec?:number, onProgress?:(p:object)=>void, cancel?:()=>boolean,
 *          tokenizer?:boolean}} opts
 * @returns {Promise<{ok:boolean, prediction?:object, ranking?:Array, model?:string,
 *                    raw?:object, error?:string, exitCode?:number, ms:number}>}
 */
export function runFingerprint(opts) {
  const {
    baseUrl, apiKey, model,
    api = 'cc', repeat = 1, timeoutSec = 120,
    onProgress = null, cancel = null, tokenizer = false,
  } = opts;

  const dir = detectorDir();
  if (!detectorReady()) {
    return Promise.resolve({ ok: false, error: `lm-detector 未就绪（缺 ${dir}/cli/fpd.ts）`, ms: 0 });
  }

  const args = [
    'cli/fpd.ts',
    '-b', baseUrl,
    '-m', model,
    '--api', api,
    '--json',
    // ⚠️ **不要加 `-ns`（非流式）**：很多模型（deepseek 系、GLM 系）会先写一大段
    //    reasoning，非流式时它把 max_tokens 用光、正文为空 → 全部样本 failed。
    //    流式才能拿到真正的数字串（实测：glm-5.2 流式 OK，非流式 3/3 failed）。
    '-n', String(repeat),
    '--timeout', String(timeoutSec),
  ];
  if (tokenizer) args.push('--tokenizer');

  const bun = findBun();
  const startedAt = Date.now();
  log.info(`[fingerprint] ${model} ← ${baseUrl}（bun=${bun}, repeat=${repeat}, timeout=${timeoutSec}s）`);

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bun, args, {
        cwd: dir,
        env: {
          ...process.env,
          API_KEY: apiKey,                       // ← Key 只走环境，不进 argv
          BASE_URL: baseUrl, MODEL: model,
          FPD_NO_UPDATE_CHECK: '1', NO_UPDATE_NOTIFIER: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      return resolve({ ok: false, error: `无法启动 lm-detector: ${e.message}`, ms: Date.now() - startedAt });
    }

    let out = '';
    let err = '';
    let cancelled = false;
    const timer = setInterval(() => {
      if (cancel && cancel() && !cancelled) {
        cancelled = true;
        child.kill('SIGTERM');
      }
    }, 1000);

    child.stdout.on('data', (d) => {
      out += d.toString();
      // 逐块解析：JSON 很大，这里只用于进度（能解出 rounds 就报一下）
      if (onProgress && out.length > 200) {
        const done = (out.match(/"finishedAt"/g) || []).length;
        onProgress({ phase: 'running', bytes: out.length, rounds: done });
      }
    });
    child.stderr.on('data', (d) => { err += d.toString(); });

    const finish = (payload) => {
      clearInterval(timer);
      resolve({ ...payload, ms: Date.now() - startedAt });
    };

    child.on('error', (e) => finish({ ok: false, error: `启动失败: ${e.message}` }));
    child.on('close', (code) => {
      if (cancelled) return finish({ ok: false, error: '已取消', cancelled: true, exitCode: code });

      // JSON 可能混着 bun 的 warn 行 —— 从第一个 `{` 开始截
      const i = out.indexOf('{');
      const jsonText = i >= 0 ? out.slice(i) : '';
      let raw = null;
      try { raw = JSON.parse(jsonText); } catch { /* 下面按失败处理 */ }

      if (!raw) {
        return finish({
          ok: false, exitCode: code,
          error: (err || out || `lm-detector 退出码 ${code}`).slice(0, 800),
        });
      }
      const parsed = summarize(raw);
      finish({ ...parsed, raw, exitCode: code });
    });
  });
}

/** 把 fpd 的 JSON 结果压成前端好用的形状 */
export function summarize(raw) {
  const round = Array.isArray(raw?.rounds) ? raw.rounds.find((r) => r?.analysis) : null;
  const an = round?.analysis ?? raw?.analysis;
  if (!an) {
    return { ok: false, error: '这次检测没有产出可用的排名（有效数字不足或请求失败）', model: raw?.request?.model ?? null };
  }
  return {
    ok: true,
    model: raw?.request?.model ?? null,
    format: raw?.request?.api ?? null,
    prediction: {
      id: an.prediction,
      name: an.prediction_name,
      probability: an.probability,
      family: an.family_prediction_name,
      familyProbability: an.family_probability,
      evidence: an.evidence?.label ?? null,
      reason: an.evidence?.reason ?? null,
      usedOutputs: an.used_outputs,
      rankingScore: an.ranking_score ?? null,
    },
    ranking: (an.results || []).map((r) => ({
      model: r.model,
      displayName: r.display_name,
      family: r.family_name || r.family,
      probability: r.probability,
      score: r.score,
    })),
    rounds: raw?.completed_rounds ?? null,
    bank: raw?.bank?.models ?? null,
  };
}

/**
 * ⭐ 指纹测试总入口（后台任务用）。
 *
 * 负责：
 *   ① 临时关掉「只接快速模型」（否则很多模型会被 fast-mode 拦截）
 *   ② 用 `/v1` 的 baseUrl + admin token 跑 lm-detector
 *   ③ **无论成功失败都恢复**原开关
 *
 * @param {{model:string, api?:string, repeat?:number, timeoutSec?:number,
 *          onProgress?:Function, cancel?:Function}} opts
 */
export async function fingerprintModel(opts) {
  const { model, api = 'cc', repeat = 1, timeoutSec = 120, onProgress = null, cancel = null } = opts;
  const base = `http://127.0.0.1:${config.port}/v1`;

  // 用管理 token 当 API key（网关自己鉴权；上游真 Key 永不外泄）
  const apiKey = adminToken();

  // ① 让被 fast-mode 拉黑的模型也能被测到
  const fastBefore = fastModelsOnly();
  if (fastBefore) {
    try { setFastModelsOnly(false); } catch (e) { log.warn(`[fingerprint] 暂关快速模式失败: ${e.message}`); }
  }

  try {
    const res = await runFingerprint({ baseUrl: base, apiKey, model, api, repeat, timeoutSec, onProgress, cancel });
    return res;
  } finally {
    if (fastBefore) {
      try { setFastModelsOnly(true); } catch (e) { log.warn(`[fingerprint] 恢复快速模式失败: ${e.message}`); }
    }
  }
}

/** 读管理 token（部署时落在 data/admin_token） */
export function adminToken() {
  try {
    return fs.readFileSync(config.adminTokenFile, 'utf8').trim();
  } catch {
    return '';
  }
}

/** 渠道 → api2api 对外模型名（把上游真名转成网关能看到的名字） */
export function publicModelNameFor(channelRef, upstreamModel) {
  const ch = getChannel(channelRef);
  if (!ch) return upstreamModel;
  return upstreamModel;
}

export default {
  detectorDir, detectorReady, runFingerprint, fingerprintModel, summarize, adminToken,
};
