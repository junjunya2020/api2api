/**
 * 一次性「模型实测扫描」—— 逐个模型打上游，统计真实错误分布。
 *
 * ⚠️ 纯只读：只发请求 + 统计，**不调用** recordFailure / recordSuccess，
 *    不写任何 key_state / model_health。跑完即删。
 *
 * 目的（用户 2026-10-07 要求）：
 *   「我感觉有些模型上游就是喜欢429 你帮我测试出这些特定模型」
 *   「有些画图模型 失效了不判真失效 你要一个一个模型测试的」
 *
 * 环境变量：
 *   PER_MODEL  每个模型打几次（默认 1）
 *   GAP_MS     每次调用之间的间隔毫秒（默认 1500，避免自己把自己限流）
 *   TIMEOUT    单次超时毫秒（默认 20000）
 *   ONLY       只测指定渠道，逗号分隔（如 sensenova,intern）
 */
const R = 'file:///root/api2api/src';
const { all } = await import(`${R}/db/index.mjs`);
const { decryptSecret } = await import(`${R}/util/crypto.mjs`);
const { getAdapter } = await import(`${R}/adapters/index.mjs`);

const PER_MODEL = Number(process.env.PER_MODEL || 1);
const GAP_MS = Number(process.env.GAP_MS || 1500);
const TIMEOUT = Number(process.env.TIMEOUT || 20000);
const ONLY = process.env.ONLY || '';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function keyOf(channelId) {
  const rows = all(
    'SELECT uuid, secret_enc FROM channel_key WHERE channel_id=? AND enabled=1 ORDER BY priority DESC, created_at ASC LIMIT 1',
    channelId,
  );
  if (!rows.length) return null;
  return { uuid: rows[0].uuid, secret: decryptSecret(rows[0].secret_enc) };
}

const chans = all('SELECT id, name, adapter, base_url FROM channel ORDER BY sort_order');
const out = [];

for (const ch of chans) {
  if (ONLY && !ONLY.split(',').includes(ch.name)) continue;
  const k = keyOf(ch.id);
  const ad = getAdapter(ch.adapter);
  const models = all('SELECT model_id FROM upstream_model WHERE channel_id=? ORDER BY seq', ch.id).map((r) => r.model_id);

  for (const model of models) {
    const r = { channel: ch.name, model, ok: 0, fail: 0, byClass: {}, codes: [], latencies: [] };
    if (!k) { r.note = 'no-key'; out.push(r); continue; }

    for (let i = 0; i < PER_MODEL; i++) {
      const t0 = Date.now();
      try {
        const url = ch.base_url.replace(/\/+$/, '') + '/chat/completions';
        const res = await fetch(url, {
          method: 'POST',
          headers: ad.headers(k.secret),
          body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1, stream: false }),
          signal: AbortSignal.timeout(TIMEOUT),
        });
        const text = await res.text();
        const v = ad.classify(res.status, res.headers, text);
        r.latencies.push(Date.now() - t0);
        r.codes.push(res.status);
        if (v.errClass === 'ok') r.ok++;
        else {
          r.fail++;
          r.byClass[v.errClass] = (r.byClass[v.errClass] || 0) + 1;
          if (!r.sample) r.sample = String(v.message || text).slice(0, 180);
          if (!r.code) r.code = v.code ?? null;
        }
      } catch (e) {
        r.fail++;
        r.byClass.transient = (r.byClass.transient || 0) + 1;
        r.codes.push(null);
        if (!r.sample) r.sample = 'conn: ' + String(e.message).slice(0, 150);
      }
      if (i < PER_MODEL - 1) await sleep(GAP_MS);
    }
    out.push(r);
    const cls = Object.entries(r.byClass).map(([a, b]) => a + ':' + b).join(',') || '-';
    process.stderr.write('  ' + ch.name.padEnd(11) + ' ' + model.padEnd(34) + ' ok=' + r.ok + ' fail=' + r.fail + ' [' + cls + ']\n');
    await sleep(GAP_MS);
  }
}

console.log(JSON.stringify({ ts: Date.now(), perModel: PER_MODEL, results: out }));
