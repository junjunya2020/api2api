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
import * as tokens from '../db/tokens.mjs';

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
 * ⭐ 指纹测试总入口（用户 2026-10-08）。
 *
 * 选择渠道的方式（用户原话：「要可以选择渠道名字 默认是全部渠道」）：
 *   · 不传 channel → 用**全渠道聚合**的 admin token（默认行为）
 *   · 传了 channel → 临时签发一个**绑定该渠道**的 token，
 *     这样指纹请求只走该渠道的 Key —— 干净、不影响别的测试、也不用动全局开关。
 *     （早期实现靠"临时关掉只接快速模型"来绕开 fast-mode 拦截，既脏又会互相打架。）
 *
 * @param {{model:string, channel?:string|null, api?:string, repeat?:number, timeoutSec?:number,
 *          onProgress?:Function, cancel?:Function}} opts
 */
export async function fingerprintModel(opts) {
  const { model, channel = null, api = 'cc', repeat = 1, timeoutSec = 120, onProgress = null, cancel = null } = opts;
  const base = `http://127.0.0.1:${config.port}/v1`;

  let apiKey;
  let tempName = null;
  if (channel) {
    // 绑定该渠道的临时 token（明文只在返回值里，用完即删）
    tempName = `fp-scope-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const created = tokens.createToken(tempName, channel, `指纹测试临时令牌（渠道=${channel}）`);
    apiKey = created.token;
  } else {
    apiKey = adminToken();
  }

  try {
    const res = await runFingerprint({ baseUrl: base, apiKey, model, api, repeat, timeoutSec, onProgress, cancel });
    return res;
  } finally {
    if (tempName) {
      try { tokens.deleteToken(tempName); } catch (e) { log.warn(`[fingerprint] 清理临时令牌失败: ${e.message}`); }
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

export default {
  detectorDir, detectorReady, runFingerprint, fingerprintModel, summarize, adminToken,
};
