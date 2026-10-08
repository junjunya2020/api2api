/**
 * 冒烟测试：不依赖外部网络，验证核心链路。
 * 直接调用模块，避免端口冲突。
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

// 用独立的测试数据库，避免污染开发数据
const TMP = path.resolve(process.cwd(), 'test', '.tmp');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
process.env.DB_FILE = path.join(TMP, 'test.db');
process.env.MASTER_KEY_FILE = path.join(TMP, 'master.key');
process.env.ADMIN_TOKEN_FILE = path.join(TMP, 'admin_token');
process.env.DATA_DIR = TMP;
process.env.LOG_LEVEL = 'error';

const { getDb, closeDb } = await import('../src/db/index.mjs');
const keys = await import('../src/db/keys.mjs');
const aliases = await import('../src/db/aliases.mjs');
const catalog = await import('../src/db/catalog.mjs');
const channels = await import('../src/db/channels.mjs');
const sched = await import('../src/scheduler/index.mjs');
const rate = await import('../src/scheduler/rate.mjs');
const config = (await import('../src/config.mjs')).default;
const state = await import('../src/db/state.mjs');
const firstbyte = await import('../src/adapters/firstbyte.mjs');
const { recordFailure } = await import('../src/db/state.mjs');
const tokens = await import('../src/db/tokens.mjs');
const { encryptSecret, decryptSecret, fingerprint } = await import('../src/util/crypto.mjs');
const { selectSmoothWRR } = await import('../src/scheduler/index.mjs');
const sensenova = (await import('../src/adapters/sensenova.mjs')).default;
const intern = (await import('../src/adapters/intern.mjs')).default;
const { ErrClass, RETRYABLE, FATAL_FOR_REQUEST, FATAL_FOR_CHANNEL } = await import('../src/util/errors.mjs');
const mh = await import('../src/db/model-health.mjs');
const modelRules = await import('../src/db/model-rules.mjs');
const dbx = await import('../src/db/index.mjs');
const logsDb = await import('../src/db/logs.mjs');
const { shape: shapeFn } = await import('../src/http/admin-keys.mjs');

let pass = 0;
let fail = 0;
function t(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    pass++;
  } catch (e) {
    console.log(`  ✗ ${name}\n      ${e.message}`);
    fail++;
  }
}
async function ta(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    pass++;
  } catch (e) {
    console.log(`  ✗ ${name}\n      ${e.message}`);
    fail++;
  }
}

console.log('\n=== api2api 冒烟测试 ===\n');
getDb();

console.log('[1] 内置渠道');
t('预置了六个渠道', () => {
  const list = channels.listChannels();
  assert.strictEqual(list.length, 6, `期望 6 个，实际 ${list.length}`);
  const names = list.map((c) => c.name).sort();
  assert.deepStrictEqual(names, ['intern', 'llm7', 'modelscope', 'nvidia', 'openrouter', 'sensenova']);
});
t('渠道 base_url 正确', () => {
  const s = channels.getChannel('sensenova');
  assert.strictEqual(s.base_url, 'https://token.sensenova.cn/v1');
  const i = channels.getChannel('intern');
  assert.strictEqual(i.base_url, 'https://discovery-api.intern-ai.org.cn/v1');
  const n = channels.getChannel('nvidia');
  assert.strictEqual(n.base_url, 'https://integrate.api.nvidia.com/v1');
  assert.strictEqual(n.adapter, 'nvidia');
  const m = channels.getChannel('modelscope');
  assert.strictEqual(m.base_url, 'https://api-inference.modelscope.cn/v1');
  assert.strictEqual(m.adapter, 'modelscope');
  const l = channels.getChannel('llm7');
  assert.strictEqual(l.base_url, 'https://api.llm7.io/v1');
  assert.strictEqual(l.adapter, 'llm7');
});

console.log('\n[2] 加密与指纹');
t('AES-GCM 往返一致', () => {
  const plain = 'sk-test-abcdef123456';
  const enc = encryptSecret(plain);
  assert.ok(Buffer.isBuffer(enc));
  assert.ok(!enc.toString('utf8').includes(plain), '密文不应包含明文');
  assert.strictEqual(decryptSecret(enc), plain);
});
t('同一密钥指纹稳定、不同密钥不同', () => {
  assert.strictEqual(fingerprint('k1'), fingerprint('k1'));
  assert.notStrictEqual(fingerprint('k1'), fingerprint('k2'));
});

console.log('\n[3] Key CRUD（uuid 主键 + 判重）');
t('加 Key 成功', () => {
  const rec = keys.addKey({ channel: 'sensenova', key: 'sk-sn-001', uuid: 'u-001', name: '小号1' });
  assert.strictEqual(rec.uuid, 'u-001');
  assert.strictEqual(rec.name, '小号1');
  assert.strictEqual(rec.channel_name, 'sensenova');
});
t('uuid 重复被拒', () => {
  assert.throws(() => keys.addKey({ channel: 'intern', key: 'sk-other', uuid: 'u-001' }), /uuid 已存在/);
});
t('同渠道内相同 Key 被拒（指纹判重）', () => {
  assert.throws(() => keys.addKey({ channel: 'sensenova', key: 'sk-sn-001', uuid: 'u-002' }), /相同 Key 已存在/);
});
t('不同渠道可用相同 Key', () => {
  const rec = keys.addKey({ channel: 'intern', key: 'sk-sn-001', uuid: 'u-003' });
  assert.strictEqual(rec.uuid, 'u-003');
});
t('name 可空', () => {
  const rec = keys.addKey({ channel: 'intern', key: 'sk-noname', uuid: 'u-004' });
  assert.strictEqual(rec.name, null);
});
t('列表不返回明文', () => {
  const list = keys.listKeys();
  const s = JSON.stringify(list);
  assert.ok(!s.includes('sk-sn-001'), '列表不应包含明文密钥');
  assert.ok(!s.includes('secret_enc'));
});
t('明文可通过内部接口取回', () => {
  assert.strictEqual(keys.getKeySecret('u-001'), 'sk-sn-001');
});
t('可改 name/weight/enabled', () => {
  const rec = keys.patchKey('u-001', { name: '改名了', weight: 5, enabled: false });
  assert.strictEqual(rec.name, '改名了');
  assert.strictEqual(rec.weight, 5);
  assert.strictEqual(rec.enabled, 0);
  keys.patchKey('u-001', { enabled: true, weight: 1 });
});
t('删除 Key', () => {
  assert.strictEqual(keys.deleteKey('u-004'), true);
  assert.strictEqual(keys.getKey('u-004'), null);
});
t('批量导入部分成功', () => {
  const r = keys.addKeysBulk('sensenova', [
    { key: 'sk-bulk-1', uuid: 'ub-1' },
    { key: 'sk-bulk-2', uuid: 'ub-2' },
    { key: 'sk-sn-001', uuid: 'ub-dup' }, // 与已有重复
  ]);
  assert.strictEqual(r.total, 3);
  assert.strictEqual(r.okCount, 2);
  assert.strictEqual(r.failCount, 1);
});

console.log('\n[4] 模型映射');
t('建渠道专属映射', () => {
  const a = aliases.addAlias({ public_name: 'gpt-4o', upstream_name: 'SenseChat-5-0903', channel: 'sensenova' });
  assert.strictEqual(a.public_name, 'gpt-4o');
});
t('建全局映射', () => {
  const a = aliases.addAlias({ public_name: 'deepseek-v4', upstream_name: 'deepseek-v4-flash' });
  assert.strictEqual(a.channel_id, null);
});
t('同名同渠道重复被拒', () => {
  assert.throws(() => aliases.addAlias({ public_name: 'gpt-4o', upstream_name: 'xxx', channel: 'sensenova' }), /映射已存在/);
});
t('别名解析：渠道专属映射排第一，其他渠道仍同名直通（映射是叠加层）', () => {
  const c = aliases.resolveCandidates('gpt-4o');
  // 商汤有专属映射 → 用映射的上游名，排第一
  assert.strictEqual(c[0].channelName, 'sensenova');
  assert.strictEqual(c[0].upstreamName, 'SenseChat-5-0903');
  // 书生没配映射 → 同名直通 gpt-4o（不因为"别处有映射"就被砍掉）
  const it = c.find((x) => x.channelName === 'intern');
  assert.ok(it, '书生渠道不应因商汤有映射而消失');
  assert.strictEqual(it.upstreamName, 'gpt-4o');
  // 返回所有启用渠道（不写死总数，渠道数会随接入增长）
  assert.strictEqual(c.length, channels.listChannels().filter((x) => x.enabled).length);
});
t('别名解析：全局映射落到所有渠道', () => {
  const c = aliases.resolveCandidates('deepseek-v4');
  const enabled = channels.listChannels().filter((x) => x.enabled).length;
  assert.strictEqual(c.length, enabled, `应落到全部 ${enabled} 个启用渠道`);
  const others = c.filter((x) => x.upstreamName === 'deepseek-v4-flash');
  assert.strictEqual(others.length, enabled);
});
t('别名解析：无映射则同名直通', () => {
  const c = aliases.resolveCandidates('完全没配过的模型');
  assert.strictEqual(c.length, channels.listChannels().filter((x) => x.enabled).length);
  assert.ok(c.every((x) => x.upstreamName === '完全没配过的模型'));
});
t('对外模型清单', () => {
  const m = aliases.publicModelList();
  const ids = m.map((x) => x.id).sort();
  assert.deepStrictEqual(ids, ['deepseek-v4', 'gpt-4o']);
});

console.log('\n[4b] 上游模型目录（下游模型列表的真相来源）');
t('拉取落库后，上游原名直接出现在下游清单（无需建映射）', () => {
  const ch = channels.getChannel('intern');
  catalog.replaceChannelModels(ch.id, ['glm-5.3', 'minimax-m3', 'intern-s2']);
  const ids = aliases.publicModelList().map((x) => x.id).sort();
  assert.ok(ids.includes('glm-5.3'), `下游应能看到 glm-5.3，实际: ${ids.join(',')}`);
  assert.ok(ids.includes('minimax-m3'), '下游应能看到 minimax-m3');
  // 已有的映射仍在
  assert.ok(ids.includes('gpt-4o'), '映射的对外名应保留');
  assert.ok(ids.includes('deepseek-v4'), '全局映射的对外名应保留');
});

t('上游名被全局映射占用时，原名折叠只留对外名', () => {
  const ch = channels.getChannel('intern');
  // deepseek-v4 是全局映射 → deepseek-v4-flash；把上游名也放进目录
  catalog.replaceChannelModels(ch.id, ['glm-5.3', 'deepseek-v4-flash']);
  const ids = aliases.publicModelList().map((x) => x.id);
  assert.ok(ids.includes('deepseek-v4'), '对外名应在');
  assert.ok(!ids.includes('deepseek-v4-flash'), `上游原名应被折叠，实际: ${ids.join(',')}`);
});

t('渠道专属映射只折叠该渠道的原名，其他渠道不受影响', () => {
  const sn = channels.getChannel('sensenova');
  const it = channels.getChannel('intern');
  // gpt-4o @sensenova → SenseChat-5-0903
  catalog.replaceChannelModels(sn.id, ['SenseChat-5-0903']);
  catalog.replaceChannelModels(it.id, ['SenseChat-5-0903']);
  const list = aliases.publicModelList();
  const entry = list.find((x) => x.id === 'SenseChat-5-0903');
  assert.ok(entry, '书生渠道上未被映射占用的原名应仍可见');
  assert.deepStrictEqual(entry.channels, ['书生·墨点'], `只应剩书生，实际 ${JSON.stringify(entry.channels)}`);
});

t('目录统计与清空', () => {
  const stats = catalog.catalogStats();
  assert.ok(stats.length >= 2, '应有各渠道统计');
  const n = catalog.clearChannelModels('intern');
  assert.ok(n > 0, '清空应删除记录');
  assert.strictEqual(catalog.listChannelModels('intern').length, 0);
  const ids = aliases.publicModelList().map((x) => x.id);
  assert.ok(!ids.includes('glm-5.3'), '清空后下游不应再看到该渠道模型');
});

t('同名直通时，目录里有该模型的渠道排前面', () => {
  catalog.replaceChannelModels(channels.getChannel('intern').id, ['only-on-intern']);
  const c = aliases.resolveCandidates('only-on-intern');
  const enabled = channels.listChannels().filter((x) => x.enabled).length;
  assert.strictEqual(c.length, enabled, '所有启用渠道都会被尝试（目录只影响顺序，不剔除）');
  assert.strictEqual(c[0].channelName, 'intern', `目录命中的渠道应排第一，实际 ${c[0].channelName}`);
});

console.log('\n[5] 调度器');
t('优先级桶：高优先级优先', () => {
  const { getDb: g } = { getDb };
  keys.addKey({ channel: 'sensenova', key: 'sk-pri-hi', uuid: 'u-pri-hi', priority: 10 });
  keys.addKey({ channel: 'sensenova', key: 'sk-pri-lo', uuid: 'u-pri-lo', priority: 0 });
  const got = new Set();
  for (let i = 0; i < 10; i++) {
    const k = sched.pickKey(channels.getChannel('sensenova').id, 'm1');
    if (k) got.add(k.uuid);
  }
  assert.ok(got.has('u-pri-hi'), '应选中高优先级 Key');
  assert.ok(!got.has('u-pri-lo'), '低优先级不应被选中');
});
t('smooth-WRR 分布平滑且符合权重', () => {
  const k = [
    { uuid: 'a', priority: 1, weight: 5, currentWeight: 0 },
    { uuid: 'b', priority: 1, weight: 1, currentWeight: 0 },
  ];
  const counts = { a: 0, b: 0 };
  for (let i = 0; i < 12; i++) {
    const { picked, updates } = selectSmoothWRR(k);
    for (const u of updates) {
      const tgt = k.find((x) => x.uuid === u.uuid);
      tgt.currentWeight = u.cw;
    }
    counts[picked.uuid]++;
  }
  assert.ok(counts.a > counts.b, `权重 5 应多于权重 1（a=${counts.a} b=${counts.b}）`);
  assert.strictEqual(counts.a, 10, `12 次中按 5:1 应为 10 次，实际 ${counts.a}`);
});
t('冷却中的 Key 被跳过', () => {
  const ch = channels.getChannel('sensenova').id;
  recordFailure('u-pri-hi', 'm-cd', { action: 'cooldown', nextRetryAt: Date.now() + 60_000 });
  keys.addKey({ channel: 'sensenova', key: 'sk-cd-x', uuid: 'u-cd-x', priority: 10 });
  const k = sched.pickKey(ch, 'm-cd');
  assert.ok(k.uuid !== 'u-pri-hi', '冷却中的 Key 不应被选中');
});
t('错误分类决策：request_fault 不换 Key', () => {
  const act = sched.decideAction('x', 'm', ErrClass.REQUEST_FAULT, 0);
  assert.strictEqual(act.retry, false);
  assert.strictEqual(act.action, 'none');
});
t('错误分类决策：quota 换 Key，但只做「软冷却」（不打 Key）', () => {
  // ⭐ 2026-10-07 语义变更：QUOTA(429) 常是**模型级**限流，换 Key 打同一模型照样 429。
  //    用户要求「ban 的话只 ban 模型，不 ban key」—— 所以 Key 只短暂让位，
  //    **不累加 fail_streak**（否则一个坏模型连打 10 次就能把好 Key 禁用）。
  const act = sched.decideAction('x', 'm', ErrClass.QUOTA, 0);
  assert.strictEqual(act.retry, true, '仍要换下一个候选');
  assert.strictEqual(act.action, 'soft', 'Key 侧动作应是 soft（短暂让位）');
  assert.strictEqual(act.streak, 0, '软冷却不累加连续失败次数');
  assert.ok(act.nextRetryAt > Date.now(), '要给一个冷却到期时间');
  assert.strictEqual(act.cooldownMs, config.keySoftCooldownMs, '冷却时长 = keySoftCooldownMs');
});

t('★ QUOTA 连打 10 次也不会禁用 Key（模型侧问题不烧 Key）', () => {
  let prev = 0;
  for (let i = 0; i < 12; i++) {
    const act = sched.decideAction('x', 'm', ErrClass.QUOTA, prev);
    assert.strictEqual(act.action, 'soft', `第 ${i + 1} 次 QUOTA 仍应是 soft，不能 disable`);
    assert.strictEqual(act.streak, prev, 'streak 始终不增长');
    prev = act.streak;
  }
  assert.strictEqual(prev, 0);
});

t('错误分类决策：auth 连败达阈值则停用', () => {
  // 用户要求：第 10 次连续失败才禁用。
  // ⭐ AUTH 是**唯一**该 ban Key 的场景（Key 真死了，换模型也一样）。
  const before = sched.decideAction('x', 'm', ErrClass.AUTH, 8);
  assert.strictEqual(before.action, 'cooldown', '第 9 次失败仍应冷却');
  const act = sched.decideAction('x', 'm', ErrClass.AUTH, 9);
  assert.strictEqual(act.action, 'disable', '第 10 次连续失败应禁用');
  assert.strictEqual(act.streak, 10);
});
t('线性冷却：10min × 连续失败次数，第 10 次禁用（AUTH 场景）', () => {
  const min = 60_000;
  assert.strictEqual(sched.cooldownFor(1), 10 * min);
  assert.strictEqual(sched.cooldownFor(2), 20 * min);
  assert.strictEqual(sched.cooldownFor(3), 30 * min);
  assert.strictEqual(sched.cooldownFor(9), 90 * min);
  // 第 10 次不再冷却，直接禁用（用 AUTH —— 只有它会走递增冷却）
  const act = sched.decideAction('x', 'm', ErrClass.AUTH, 9);
  assert.strictEqual(act.action, 'disable');
  assert.strictEqual(act.cooldownMs, 0);
});
t('成功一次即清零连续失败（恢复健康）', () => {
  const ch = channels.getChannel('sensenova').id;
  keys.addKey({ channel: 'sensenova', key: 'sk-hx', uuid: 'u-hx', priority: 0 });
  // 连失败 3 次
  state.recordFailure('u-hx', 'm-hx', { action: 'cooldown', nextRetryAt: Date.now() + 1000, streak: 3, error: 'x' });
  assert.strictEqual(state.getState('u-hx', 'm-hx').fail_streak, 3);
  // 成功一次
  state.recordSuccess('u-hx', 'm-hx');
  const st = state.getState('u-hx', 'm-hx');
  assert.strictEqual(st.fail_streak, 0, '成功后连续失败计数应清零');
  assert.strictEqual(st.state, 'READY');
  assert.strictEqual(st.next_retry_at, null);
  void ch;
});
t('禁用 24 小时后自动恢复，且清零连续失败', () => {
  keys.addKey({ channel: 'sensenova', key: 'sk-dz', uuid: 'u-dz', priority: 0 });
  state.recordFailure('u-dz', 'm-dz', { action: 'disable', streak: 10, error: '爆了' });
  const st1 = state.getState('u-dz', 'm-dz');
  assert.strictEqual(st1.state, 'DISABLED');
  assert.ok(st1.disabled_until > Date.now() + 23 * 3600_000, '应约 24 小时后恢复');
  // 未到期：不恢复
  state.reviveExpired(Date.now());
  assert.strictEqual(state.getState('u-dz', 'm-dz').state, 'DISABLED', '未到期不应恢复');
  // 到期后：恢复并清零
  state.reviveExpired(st1.disabled_until + 1);
  const st2 = state.getState('u-dz', 'm-dz');
  assert.strictEqual(st2.state, 'READY');
  assert.strictEqual(st2.fail_streak, 0, '恢复后连续失败必须清零，否则下次失败立刻又禁用');
});

/**
 * 这条测试锁住一个**很容易误判**的语义。
 *
 * 曾有人（我）在线上连发 11 次请求，发现 streak 一直停在 1，以为递增坏了 ——
 * 其实不是：第 1 次失败后 Key 立刻进冷却，**后续请求根本不会碰它**，
 * streak 自然冻结。要走完 10 次必须**跨 10 个冷却周期**（每次到期后再失败一次）。
 *
 * 所以这里用「时间快进」的方式模拟：每次失败 → 把时钟推到冷却到期 → 再失败。
 */
t('冷却到期后再次失败 → streak 递增（不是连续请求就能涨）', () => {
  const uuid = 'u-inc';
  keys.addKey({ channel: 'sensenova', key: 'sk-inc', uuid, priority: 0 });
  const model = 'm-inc';
  const expectedMin = [10, 20, 30, 40, 50, 60, 70, 80, 90];

  for (let i = 1; i <= 9; i++) {
    const prev = state.getState(uuid, model);
    const act = sched.decideAction(uuid, model, ErrClass.AUTH, prev.fail_streak);
    assert.strictEqual(act.streak, i, `第 ${i} 次失败的 streak 应为 ${i}`);
    assert.strictEqual(act.action, 'cooldown');
    assert.strictEqual(act.cooldownMs, expectedMin[i - 1] * 60_000,
      `第 ${i} 次冷却应为 ${expectedMin[i - 1]} 分钟，实际 ${act.cooldownMs / 60_000}`);
    state.recordFailure(uuid, model, {
      action: act.action, nextRetryAt: act.nextRetryAt, streak: act.streak, error: 'e',
    });
    // 时间快进：把冷却推到过期 → 下一次 pickKey 时才可能再选中它
    const cur = state.getState(uuid, model);
    state.reviveExpired(cur.next_retry_at + 1);
    assert.strictEqual(state.getState(uuid, model).state, 'READY',
      `第 ${i} 次冷却到期后应恢复为 READY`);
  }

  // 第 10 次 → 禁用
  const prev = state.getState(uuid, model);
  const act = sched.decideAction(uuid, model, ErrClass.AUTH, prev.fail_streak);
  assert.strictEqual(act.action, 'disable', '第 10 次连续失败应禁用');
  state.recordFailure(uuid, model, { action: act.action, streak: act.streak, error: 'e' });
  assert.strictEqual(state.getState(uuid, model).state, 'DISABLED');

  // 禁用到期 → 从 1 重新开始（不是第 11 次）
  const dis = state.getState(uuid, model);
  state.reviveExpired(dis.disabled_until + 1);
  const after = state.getState(uuid, model);
  assert.strictEqual(after.state, 'READY');
  assert.strictEqual(after.fail_streak, 0);
  const act2 = sched.decideAction(uuid, model, ErrClass.AUTH, after.fail_streak);
  assert.strictEqual(act2.streak, 1, '恢复后应从第 1 次重新计数');
  assert.strictEqual(act2.cooldownMs, 10 * 60_000, '恢复后首次失败回到 10 分钟冷却');
});
t('冷却中的 Key 会被调度器跳过 —— streak 才会"冻结"（解释线上现象）', () => {
  const uuid = 'u-freeze';
  keys.addKey({ channel: 'openrouter', key: 'sk-freeze', uuid, priority: 0 });
  const ch = channels.getChannel('openrouter').id;
  const model = 'm-freeze';
  rate.clearAll();

  // 让它进入冷却
  state.recordFailure(uuid, model, {
    action: 'cooldown', nextRetryAt: Date.now() + 600_000, streak: 1, error: 'e',
  });
  // 冷却期内反复挑选，都不该选中它 —— 这正是 streak 冻结的原因
  for (let i = 0; i < 5; i++) {
    const k = sched.pickKey(ch, model);
    assert.ok(!k || k.uuid !== uuid, '冷却中的 Key 不应被选中');
  }
  assert.strictEqual(state.getState(uuid, model).fail_streak, 1, '未被选中 → streak 不会增长');
});
t('默认策略为填满优先：连续用同一把，用满 RPM 才换（不是轮询）', () => {
  // 用**独立渠道**避免受前面测试已加的 Key 影响
  const ch = channels.getChannel('openrouter').id;
  keys.addKey({ channel: 'openrouter', key: 'sk-ff1', uuid: 'u-ff1', priority: 9 });
  keys.addKey({ channel: 'openrouter', key: 'sk-ff2', uuid: 'u-ff2', priority: 9 });
  rate.clearAll();
  // 每 Key RPM=2：前 2 次必是同一把（填满优先的核心特征），
  // 第 3 次才因为 RPM 用满换到另一把。
  const seq = [];
  for (let i = 0; i < 4; i++) {
    const k = sched.pickKey(ch, 'm-ff');
    assert.ok(k, '应能选到 Key');
    seq.push(k.uuid);
    rate.recordHit(k.uuid);
  }
  assert.strictEqual(seq[0], seq[1], `填满优先：前两次应是同一把，实际 ${seq.join(',')}`);
  const first = seq[0];
  const second = seq.find((u) => u !== first);
  assert.ok(second, `用满 ${rate.limit()} 次后应换到另一把，实际序列 ${seq.join(',')}`);
  // 切到第二把后也应连续用满
  assert.strictEqual(seq[2], second, `换过后应继续填满第二把，实际 ${seq.join(',')}`);
});

t('RPM 软约束：单 Key 达上限仍可用（不能因此不可用）', () => {
  const ch = channels.getChannel('sensenova').id;
  // 优先级 99 → 独立成桶，桶里只有它一把
  keys.addKey({ channel: 'sensenova', key: 'sk-solo', uuid: 'u-solo', priority: 99 });
  rate.clearAll();
  for (let i = 0; i < 10; i++) rate.recordHit('u-solo');
  const k = sched.pickKey(ch, 'm-solo');
  assert.ok(k && k.uuid === 'u-solo', '唯一一把 Key 达 RPM 上限时仍必须可用');
});
t('RPM 计数与剩余时间', () => {
  rate.clearAll();
  assert.strictEqual(rate.usage('u-rpm'), 0);
  rate.recordHit('u-rpm');
  rate.recordHit('u-rpm');
  assert.strictEqual(rate.usage('u-rpm'), 2);
  assert.strictEqual(rate.isLimited('u-rpm'), 2 >= rate.limit());
  if (rate.limit() > 0) assert.ok(rate.retryAfterMs('u-rpm') > 0, '达上限后应有等待时间');
  rate.clear('u-rpm');
  assert.strictEqual(rate.usage('u-rpm'), 0);
});
t('stateSummary 同时给出 Key 维度与 key×模型 维度（两页数字才能对上）', () => {
  // 造一个"同一把 Key 在 2 个模型上冷却"的场景 —— 这正是两口径会分叉的地方
  keys.addKey({ channel: 'openrouter', key: 'sk-sum1', uuid: 'u-sum1', priority: 5 });
  const now = Date.now();
  for (const m of ['mA', 'mB']) {
    state.recordFailure('u-sum1', m, { action: 'cooldown', nextRetryAt: now + 60_000, streak: 1, error: 'x' });
  }
  const s = state.stateSummary();
  const cellCooling = s.byCell.find((x) => x.state === 'COOLDOWN')?.n ?? 0;
  const keyCooling = s.byKey.find((x) => x.state === 'COOLDOWN')?.n ?? 0;
  assert.ok(cellCooling >= 2, `key×模型 维度应至少 2 条冷却，实际 ${cellCooling}`);
  assert.ok(keyCooling >= 1, `Key 维度应至少 1 把冷却，实际 ${keyCooling}`);
  assert.ok(cellCooling > keyCooling,
    `同 Key 多模型时应 cell > key（cell=${cellCooling} key=${keyCooling}）`);
  assert.strictEqual(s.unhealthyKeys, (s.byKey.find((x) => x.state === 'COOLDOWN')?.n ?? 0)
    + (s.byKey.find((x) => x.state === 'DISABLED')?.n ?? 0));
});
t('stateSummary 剔除已过期的冷却（惰性维护没跑也不该显示"冷却中"）', () => {
  keys.addKey({ channel: 'openrouter', key: 'sk-sum2', uuid: 'u-sum2', priority: 6 });
  // 写入一个**已经过期**的冷却
  state.recordFailure('u-sum2', 'mX', {
    action: 'cooldown', nextRetryAt: Date.now() - 1000, streak: 1, error: 'x',
  });
  const s = state.stateSummary();
  const hit = s.byCell.find((x) => x.state === 'COOLDOWN')?.n ?? 0;
  // u-sum2 那条已过期，不该被计为 COOLDOWN
  const keyCooling = s.byKey.find((x) => x.state === 'COOLDOWN')?.n ?? 0;
  assert.ok(hit >= 0);
  // 关键断言：过期的那把不应出现在"异常 Key"里
  const health = state.keyHealthMap();
  const h2 = health.get('u-sum2');
  assert.ok(!h2 || h2.state === 'READY', `过期冷却应视为 READY，实际 ${h2?.state}`);
  void keyCooling;
});

console.log('\n[5b] owner 归属隔离（桥做代理层的基础）');

t('addKey 记录 owner；listKeys 按 owner 精确过滤', () => {
  keys.addKey({ channel: 'openrouter', key: 'sk-own-a', uuid: 'u-own-a', owner: 'alice' });
  keys.addKey({ channel: 'openrouter', key: 'sk-own-b', uuid: 'u-own-b', owner: 'bob' });
  keys.addKey({ channel: 'openrouter', key: 'sk-own-sys', uuid: 'u-own-sys' }); // 系统 Key

  const a = keys.listKeys({ owner: 'alice' }).map((k) => k.uuid);
  const b = keys.listKeys({ owner: 'bob' }).map((k) => k.uuid);
  const sys = keys.listKeys({ owner: '' }).map((k) => k.uuid);

  assert.deepStrictEqual(a, ['u-own-a']);
  assert.deepStrictEqual(b, ['u-own-b']);
  assert.ok(sys.includes('u-own-sys'), '系统 Key 应在 owner="" 里');
  assert.ok(!sys.includes('u-own-a'), '系统查询不该看到用户的 Key');

  // 不过滤（undefined）能看到全部 —— 管理后台用
  const allList = keys.listKeys().map((k) => k.uuid);
  assert.ok(allList.includes('u-own-a') && allList.includes('u-own-sys'));
});

t('ownerKeyUuids 只返回该 owner 的 uuid（越权删除的判据）', () => {
  const set = keys.ownerKeyUuids('alice');
  assert.ok(set.has('u-own-a'));
  assert.ok(!set.has('u-own-b'), '绝不能包含别人的 Key');
  assert.ok(!set.has('u-own-sys'), '绝不能包含系统 Key');
});

t('listKeys(owner 三态)：undefined=全部 / ""=仅系统 / 具体值=仅该用户', () => {
  const total = keys.listKeys().length;
  const onlySys = keys.listKeys({ owner: '' }).length;
  const onlyAlice = keys.listKeys({ owner: 'alice' }).length;
  assert.strictEqual(onlyAlice, 1);
  assert.ok(onlySys < total, '系统子集应小于全部');
  assert.ok(total > onlySys + onlyAlice - 1);
});

console.log('\n[5c] 「调用过但零成功」判定（桥据此提醒换 Key）');

t('窗口内零成功 → keysWithNoSuccess 命中；有成功则不命中', () => {
  const mk = (uuid) => keys.addKey({ channel: 'openrouter', key: `sk-${uuid}`, uuid, owner: 'carol' });
  mk('u-ns-bad');
  mk('u-ns-good');
  mk('u-ns-untouched');

  // 坏的：调用 3 次全失败
  for (let i = 0; i < 3; i++) state.recordFailure('u-ns-bad', 'm1', { action: 'cooldown', nextRetryAt: Date.now() + 1000, streak: 1, error: 'e' });
  // 好的：失败 2 次但成功过 1 次
  state.recordFailure('u-ns-good', 'm1', { action: 'cooldown', nextRetryAt: Date.now() + 1000, streak: 1, error: 'e' });
  state.recordSuccess('u-ns-good', 'm1');
  // 从没被调用：u-ns-untouched 什么都不写

  const bad = state.keysWithNoSuccess(3).map((x) => x.uuid);
  assert.ok(bad.includes('u-ns-bad'), '调用过但零成功 → 应判为失效');
  assert.ok(!bad.includes('u-ns-good'), '有成功过 → 不该判失效');
  assert.ok(!bad.includes('u-ns-untouched'), '没被调用过 → 不参与判定（用户明确）');
});

t('dailySummaryByKey 能看出「调用过」与「零成功」', () => {
  const s = state.dailySummaryByKey(3);
  const bad = s.get('u-ns-bad');
  const untouched = s.get('u-ns-untouched');
  assert.strictEqual(bad.ok, 0);
  assert.strictEqual(bad.fail, 3);
  assert.strictEqual(untouched, undefined, '没调用过 → 汇总里没有这条');
});

t('探针（__probe__）不计入调用统计 —— 否则没被路由用过的 Key 会被误判', () => {
  keys.addKey({ channel: 'openrouter', key: 'sk-probe-only', uuid: 'u-probe-only', owner: 'carol' });
  state.recordFailure('u-probe-only', '__probe__', { action: 'none', error: 'e' });
  state.recordSuccess('u-probe-only', '__probe__');
  const s = state.dailySummaryByKey(3);
  assert.strictEqual(s.get('u-probe-only'), undefined,
    '只被探针碰过的 Key 不该出现在调用统计里');
  const bad = state.keysWithNoSuccess(3).map((x) => x.uuid);
  assert.ok(!bad.includes('u-probe-only'), '只有探针 → 不算"调用过"');
});

t('宽限期：刚绑定的 Key 不参与失效判定', () => {
  keys.addKey({ channel: 'openrouter', key: 'sk-fresh', uuid: 'u-fresh', owner: 'carol' });
  state.recordFailure('u-fresh', 'm1', { action: 'cooldown', nextRetryAt: Date.now() + 1000, streak: 1, error: 'e' });
  // 不给宽限：会命中
  assert.ok(state.keysWithNoSuccess(3).some((x) => x.uuid === 'u-fresh'));
  // 给 1 天宽限（刚绑定 < 1 天）：不该命中
  const graced = state.keysWithNoSuccess(3, { minAgeMs: 24 * 3600_000 });
  assert.ok(!graced.some((x) => x.uuid === 'u-fresh'), '刚绑定的 Key 应被宽限保护');
});

t('listOwners：只列出用户 Key 的 owner，排除系统 Key（owner=""）', () => {
  keys.addKey({ channel: 'openrouter', key: 'sk-ownlist-1', uuid: 'u-ownlist-1', owner: 'dave' });
  keys.addKey({ channel: 'openrouter', key: 'sk-ownlist-2', uuid: 'u-ownlist-2', owner: 'dave' });
  const owners = keys.listOwners();
  const byOwner = new Map(owners.map((o) => [o.owner, o.keyCount]));
  assert.ok(byOwner.has('dave'), 'dave 应出现在 owner 列表里');
  assert.strictEqual(byOwner.get('dave'), 2, 'dave 应有 2 把');
  assert.ok(!byOwner.has(''), '系统 Key（owner=""）不该出现 —— 桥不管系统 Key');
});

console.log('\n[5d] 桥「自动踢分组」的判据：allFailed 必须计入宽限期');

t('allFailed 的宽限语义：新绑的 Key 在宽限期内不能算失效', () => {
  // 复现曾经的 bug：overview.noSuccess 无年龄宽限 →
  // 新绑的 Key 一失败就 allFailed=true → 接上自动踢人会刚绑上就被踢。
  //
  // 这里直接验证底层两个口径的差异（HTTP 层在 e2e 里测）：
  //   无宽限（旧 allFailed 用的）→ 命中
  //   有宽限（新 allFailed 用的）→ 不命中
  const uuid = 'u-grace-newbie';
  keys.addKey({ channel: 'openrouter', key: 'sk-grace-newbie', uuid, owner: 'erin' });
  state.recordFailure(uuid, 'm1', { action: 'cooldown', nextRetryAt: Date.now() + 1000, streak: 1, error: 'e' });

  const daily = state.dailySummaryByKey(3);
  const d = daily.get(uuid);
  assert.ok(d && d.fail > 0 && d.ok === 0, '底层事实：调用过且零成功');

  // 旧口径（无宽限）—— 会误判
  const rawSet = new Set([...daily.entries()]
    .filter(([, v]) => v.fail > 0 && v.ok === 0).map(([k]) => k));
  assert.ok(rawSet.has(uuid), '无宽限口径会把它算作失效（这就是曾经的 bug）');

  // 新口径（带宽限）—— 正确放过
  const graced = new Set(state.keysWithNoSuccess(3, { minAgeMs: 3 * 24 * 3600_000 }).map((x) => x.uuid));
  assert.ok(!graced.has(uuid), '带 3 天宽限的口径不该算它失效 —— 新绑的 Key 受保护');
});

t('宽限期默认值是 3 天（用户明确选择），不是 1 天', () => {
  // 用户原话：「新绑的 key 有 3 天宽限」
  assert.strictEqual(config.keyNoSuccessGraceMs, 3 * 24 * 3600 * 1000,
    `宽限期应为 3 天，实际 ${config.keyNoSuccessGraceMs / 3600000} 小时`);
});

console.log('\n[6] 适配器 · 错误壳识别');
t('商汤 gRPC code 16 → AUTH', () => {
  const v = sensenova.classify(401, {}, JSON.stringify({ error: { code: 16, message: 'Forbidden' } }));
  assert.strictEqual(v.errClass, ErrClass.AUTH);
  assert.strictEqual(v.code, 16);
});
t('商汤 gRPC code 8 → QUOTA', () => {
  const v = sensenova.classify(429, {}, JSON.stringify({ error: { code: 8, message: 'ResourceExhausted' } }));
  assert.strictEqual(v.errClass, ErrClass.QUOTA);
});
t('商汤 gRPC code 3 → REQUEST_FAULT', () => {
  const v = sensenova.classify(400, {}, JSON.stringify({ error: { code: 3, message: 'InvalidArgument' } }));
  assert.strictEqual(v.errClass, ErrClass.REQUEST_FAULT);
});
t('商汤 成功状态 → OK', () => {
  const v = sensenova.classify(200, {}, '{}');
  assert.strictEqual(v.errClass, ErrClass.OK);
});
t('书生标准 OpenAI 壳 → AUTH', () => {
  const body = JSON.stringify({ error: { message: 'invalid API key', type: 'invalid_request_error', code: 'invalid_api_key', trace_id: 'abc123' }, request_id: 'req_x' });
  const v = intern.classify(401, {}, body);
  assert.strictEqual(v.errClass, ErrClass.AUTH);
  assert.strictEqual(v.traceId, 'abc123');
});
t('书生 rate_limit_exceeded → QUOTA', () => {
  const v = intern.classify(429, {}, JSON.stringify({ error: { message: 'rate limited', code: 'rate_limit_exceeded' } }));
  assert.strictEqual(v.errClass, ErrClass.QUOTA);
});
t('书生 model_not_found → CONFIG_FAULT', () => {
  const v = intern.classify(404, {}, JSON.stringify({ error: { message: 'model not found', code: 'model_not_found' } }));
  assert.strictEqual(v.errClass, ErrClass.CONFIG_FAULT);
});

// ===== 以下为 2026-10-06 用真 Key 实测到的原始响应，锁死防回归 =====
console.log('  --- 真 Key 实测样本 ---');

t('商汤 429 RateLimitExceeded.EndpointRPMExceeded → QUOTA（不是 transient）', () => {
  // 原始壳：{"error":{"message":"inference exceeds tpm/rpm limit",
  //          "type":"rate_limit_error","code":"RateLimitExceeded.EndpointRPMExceeded"}}
  const body = JSON.stringify({
    error: {
      message: 'inference exceeds tpm/rpm limit',
      type: 'rate_limit_error',
      code: 'RateLimitExceeded.EndpointRPMExceeded',
    },
  });
  const v = sensenova.classify(429, {}, body);
  assert.strictEqual(v.errClass, ErrClass.QUOTA, `实际 ${v.errClass}`);
});

t('商汤 404 code "5" → CONFIG_FAULT（模型不在该渠道，必须能落下一渠道）', () => {
  // 原始壳：{"error":{"message":"model route not found","type":"invalid_request_error","code":"5"}}
  const body = JSON.stringify({ error: { message: 'model route not found', type: 'invalid_request_error', code: '5' } });
  const v = sensenova.classify(404, {}, body);
  assert.strictEqual(v.errClass, ErrClass.CONFIG_FAULT, `实际 ${v.errClass}`);
});

t('商汤 400 code "3" + MaxTokens → REQUEST_FAULT（不能被 token.*invalid 误判成 AUTH）', () => {
  const body = JSON.stringify({
    error: { message: 'field MaxTokens invalid, should be in [1, 131072]', type: 'invalid_request_error', param: 'max_tokens', code: '3' },
  });
  const v = sensenova.classify(400, {}, body);
  assert.strictEqual(v.errClass, ErrClass.REQUEST_FAULT, `实际 ${v.errClass}`);
});

t('★★ 商汤 403 code 7 +「不在 token plan」→ CONFIG_FAULT（不是 AUTH！）', () => {
  // 真 Key 实测（2026-10-07）：`deepseek-v4.1-flash` 返回
  //   HTTP 403, {"error":{"code":7,"message":"model is not available in the current token plan"}}
  //
  // ⚠️ 这是**必须锁住**的坑：gRPC 7 = PERMISSION_DENIED → 按表会被归成 AUTH，
  //    而 AUTH 的动作是**递增冷却直到禁用整把 Key** ——
  //    一个"套餐里没这个模型"的错误会把一把好 Key 废掉，
  //    直接违反用户要求「ban 的话只 ban 模型，不 ban key」。
  const body = JSON.stringify({
    error: { message: 'model is not available in the current token plan', code: 7 },
  });
  const v = sensenova.classify(403, {}, body);
  assert.strictEqual(v.errClass, ErrClass.CONFIG_FAULT,
    `模型不在套餐应归为 CONFIG_FAULT（跳过渠道、不惩罚 Key），实际 ${v.errClass}`);
});

t('★★ 但真正的「Key 无权限」仍必须归 AUTH（不能被上一条覆盖过头）', () => {
  // PERMISSION_DENIED 也可能是真的 Key 权限问题 —— 那种消息里通常是 key/token/unauthorized
  const body = JSON.stringify({
    error: { message: 'invalid api key: unauthorized', code: 7 },
  });
  const v = sensenova.classify(403, {}, body);
  assert.strictEqual(v.errClass, ErrClass.AUTH, `真 Key 权限问题应仍是 AUTH，实际 ${v.errClass}`);
});

t('书生 404 model_not_available → CONFIG_FAULT（不是 transient）', () => {
  // 原始壳：{"error":{"message":"deepseek-v4-pro is not supported by TokenPlan",
  //          "type":"model_not_available","code":"model_not_available","trace_id":"..."}}
  const body = JSON.stringify({
    error: {
      message: 'deepseek-v4-pro is not supported by TokenPlan',
      type: 'model_not_available', param: null,
      code: 'model_not_available', trace_id: 'ffd26fc3cee72ee6f7611da1ae96e1a1',
    },
    request_id: 'req_2a3941aa',
  });
  const v = intern.classify(404, {}, body);
  assert.strictEqual(v.errClass, ErrClass.CONFIG_FAULT, `实际 ${v.errClass}`);
  assert.strictEqual(v.traceId, 'ffd26fc3cee72ee6f7611da1ae96e1a1');
});

t('基类兜底：识别不出时以 HTTP 状态纠正 TRANSIENT', () => {
  // 故意用一条不含任何语义关键词的未知错误 —— 适配器只能返回 TRANSIENT，
  // 基类应据 HTTP 429 纠正为 QUOTA。
  const v = sensenova.classify(429, {}, JSON.stringify({ error: { message: 'zzz unknown novel wording' } }));
  assert.strictEqual(v.errClass, ErrClass.QUOTA, `实际 ${v.errClass}`);
  // 反向：状态也是 5xx（TRANSIENT）时，保持 TRANSIENT
  const v2 = sensenova.classify(500, {}, JSON.stringify({ error: { message: 'zzz unknown novel wording' } }));
  assert.strictEqual(v2.errClass, ErrClass.TRANSIENT, `实际 ${v2.errClass}`);
});

t('CONFIG_FAULT 语义：可重试（换渠道）而非 fatal', () => {
  assert.ok(RETRYABLE.has(ErrClass.CONFIG_FAULT), 'CONFIG_FAULT 应在 RETRYABLE 里');
  assert.ok(!FATAL_FOR_REQUEST.has(ErrClass.CONFIG_FAULT), 'CONFIG_FAULT 不应在 FATAL_FOR_REQUEST 里');
  assert.ok(FATAL_FOR_CHANNEL.has(ErrClass.CONFIG_FAULT), 'CONFIG_FAULT 应在 FATAL_FOR_CHANNEL 里');
});

t('CONFIG_FAULT 决策 → skip_channel（不惩罚 Key，直接换渠道）', () => {
  const act = sched.decideAction('x', 'm', ErrClass.CONFIG_FAULT, 0);
  assert.strictEqual(act.action, 'skip_channel');
  assert.strictEqual(act.retry, true);
});

t('REQUEST_FAULT 决策 → 不重试（请求本身有问题）', () => {
  const act = sched.decideAction('x', 'm', ErrClass.REQUEST_FAULT, 0);
  assert.strictEqual(act.retry, false);
  assert.strictEqual(act.action, 'none');
});

console.log('\n[4c] OpenRouter 适配器（免费模型过滤 + 错误壳）');
const openrouter = (await import('../src/adapters/openrouter.mjs')).default;
const { isFreeModel } = await import('../src/adapters/openrouter.mjs');

t('免费判定：pricing 全 0 视为免费', () => {
  assert.ok(isFreeModel({ id: 'x/y:free', pricing: { prompt: '0', completion: '0' } }));
  assert.ok(!isFreeModel({ id: 'x/y', pricing: { prompt: '0.000001', completion: '0.000002' } }));
  // 只有 input 免费、output 收费 → 不算免费
  assert.ok(!isFreeModel({ id: 'x/y:free', pricing: { prompt: '0', completion: '0.000002' } }));
});

t('免费判定：免费但不带 :free 后缀的例外', () => {
  assert.ok(isFreeModel({ id: 'openrouter/free', pricing: { prompt: '0', completion: '0' } }));
  // 无 pricing 字段时回落白名单
  assert.ok(isFreeModel({ id: 'openrouter/free' }));
  assert.ok(!isFreeModel({ id: 'openai/gpt-4o' }));
});

t('parseModels 默认只保留免费模型（465 → 16 的真实比例）', () => {
  const json = {
    data: [
      { id: 'nvidia/nemotron-3-super-120b-a12b:free', pricing: { prompt: '0', completion: '0' } },
      { id: 'google/gemma-4-31b-it:free', pricing: { prompt: '0', completion: '0' } },
      { id: 'openai/gpt-4o', pricing: { prompt: '0.0000025', completion: '0.00001' } },
      { id: 'anthropic/claude-x', pricing: { prompt: '0.000003', completion: '0.000015' } },
    ],
  };
  const free = openrouter.parseModels(json);
  assert.deepStrictEqual(free, ['nvidia/nemotron-3-super-120b-a12b:free', 'google/gemma-4-31b-it:free']);
  // 显式要求全量时才给全部
  const all = openrouter.parseModels(json, { freeOnly: false });
  assert.strictEqual(all.length, 4);
});

t('OpenRouter 401 错误壳 → AUTH（数字 code）', () => {
  const v = openrouter.classify(401, {}, JSON.stringify({ error: { message: 'User not found.', code: 401 } }));
  assert.strictEqual(v.errClass, ErrClass.AUTH, `实际 ${v.errClass}`);
  const v2 = openrouter.classify(401, {}, JSON.stringify({ error: { message: 'No cookie auth credentials found', code: 401 } }));
  assert.strictEqual(v2.errClass, ErrClass.AUTH, `实际 ${v2.errClass}`);
});

t('OpenRouter 402 余额不足 → QUOTA', () => {
  const v = openrouter.classify(402, {}, JSON.stringify({ error: { message: 'Insufficient credits', code: 402 } }));
  assert.strictEqual(v.errClass, ErrClass.QUOTA, `实际 ${v.errClass}`);
});

t('OpenRouter 模型无可用提供方 → CONFIG_FAULT（可换渠道）', () => {
  const v = openrouter.classify(404, {}, JSON.stringify({ error: { message: 'No allowed providers are available for the selected model', code: 404 } }));
  assert.strictEqual(v.errClass, ErrClass.CONFIG_FAULT, `实际 ${v.errClass}`);
});

// 真 Key 实测（2026-10-06）：OpenRouter 的 `Provider returned error` 是**包装壳**，
// 真原因藏在 metadata.raw 里。不剥开会误判成 request_fault → 不换渠道 → 白等。
t('OpenRouter metadata.raw 剥壳：地区限制 → CONFIG_FAULT（可换渠道）', () => {
  const body = JSON.stringify({
    error: {
      message: 'Provider returned error',
      code: 400,
      metadata: {
        raw: JSON.stringify({
          error: { code: 400, message: 'User location is not supported for the API use.', status: 'FAILED_PRECONDITION' },
        }),
        provider_name: 'Google AI Studio',
        provider_error_code: '400',
      },
    },
  });
  const v = openrouter.classify(400, {}, body);
  assert.strictEqual(v.errClass, ErrClass.CONFIG_FAULT, `实际 ${v.errClass}（不能是 request_fault，否则不会换渠道）`);
  // 消息必须带出真原因，否则日志里看不出为什么换渠道
  assert.ok(v.message.includes('location is not supported'), `message 应含真原因，实际: ${v.message}`);
  assert.ok(v.message.includes('Google AI Studio'), 'message 应标明是哪个提供方');
});

t('OpenRouter agentic harness 门禁 → CONFIG_FAULT', () => {
  const body = JSON.stringify({
    error: {
      message: 'thinkingmachines/inkling-small:free is only available on agentic harnesses. Try plugging it into a coding agent',
      code: 403,
      metadata: { failed_routing_step: 'Gate Free Endpoints by Agentic Harness' },
    },
  });
  const v = openrouter.classify(403, {}, body);
  assert.strictEqual(v.errClass, ErrClass.CONFIG_FAULT, `实际 ${v.errClass}`);
});

t('OpenRouter 真 AUTH 错误不被 provider 剥壳误伤', () => {
  // 没有 metadata 时按原逻辑走
  const v = openrouter.classify(401, {}, JSON.stringify({ error: { message: 'User not found.', code: 401 } }));
  assert.strictEqual(v.errClass, ErrClass.AUTH, `实际 ${v.errClass}`);
});

t('OpenRouter 提供方侧限流 → QUOTA（可恢复，不是 404）', () => {
  // 真 Key 实测：免费模型经常被上游 provider 限流
  const body = JSON.stringify({
    error: {
      message: 'Provider returned error',
      code: 429,
      metadata: {
        raw: JSON.stringify({ error: { code: 429, message: 'google/gemma-4-31b-it:free is temporarily rate-limited upstream. Please retry shortly' } }),
        provider_name: 'Google AI Studio',
      },
    },
  });
  const v = openrouter.classify(429, {}, body);
  assert.strictEqual(v.errClass, ErrClass.QUOTA, `实际 ${v.errClass}（不能报 404 骗客户端说模型不存在）`);
  assert.ok(v.message.includes('限流'), `message 应说明是限流: ${v.message}`);
});

console.log('\n[4d] 模型名友好化（去供应商前缀 + 去 :free 标签 + 大小写两形态）');
const fr = await import('../src/util/friendly.mjs');

t('stripVendor：去掉供应商前缀', () => {
  assert.strictEqual(fr.stripVendor('deepseek.ai/deepseek-v4.1-flash:free'), 'deepseek-v4.1-flash:free');
  assert.strictEqual(fr.stripVendor('google/gemma-4-31b-it:free'), 'gemma-4-31b-it:free');
  assert.strictEqual(fr.stripVendor('glm-5.2'), 'glm-5.2');
});

t('stripTags：去掉尾部 :free 等标签', () => {
  assert.strictEqual(fr.stripTags('deepseek-v4.1-flash:free'), 'deepseek-v4.1-flash');
  assert.strictEqual(fr.stripTags('gemma-4-31b-it:free'), 'gemma-4-31b-it');
  assert.strictEqual(fr.stripTags('glm-5.2'), 'glm-5.2');
});

t('friendlyName：需求里的主例子', () => {
  // deepseek.ai/deepseek-v4.1-flash:free → deepseek-v4.1-flash
  assert.strictEqual(fr.friendlyName('deepseek.ai/deepseek-v4.1-flash:free'), 'deepseek-v4.1-flash');
  assert.strictEqual(fr.friendlyName('nvidia/nemotron-3-super-120b-a12b:free'), 'nemotron-3-super-120b-a12b');
});

t('pascalName：分段首字母大写，数字与点号保持原样', () => {
  assert.strictEqual(fr.pascalName('deepseek.ai/deepseek-v4.1-flash:free'), 'Deepseek-V4.1-Flash');
  assert.strictEqual(fr.pascalName('google/gemma-4-31b-it:free'), 'Gemma-4-31b-It');
  assert.strictEqual(fr.pascalName('minimax-m3'), 'Minimax-M3');
});

t('friendlyVariants：一个上游名 → 两种友好形态', () => {
  assert.deepStrictEqual(
    fr.friendlyVariants('deepseek.ai/deepseek-v4.1-flash:free'),
    ['deepseek-v4.1-flash', 'Deepseek-V4.1-Flash'],
  );
});

t('needsFriendlyAlias：干净的名字不造别名', () => {
  assert.ok(fr.needsFriendlyAlias('deepseek.ai/x:free'), '带前缀+标签 → 需要');
  assert.ok(fr.needsFriendlyAlias('x/y'), '带前缀 → 需要');
  assert.ok(fr.needsFriendlyAlias('gemma-4-31b-it:free'), '带标签 → 需要');
  assert.ok(!fr.needsFriendlyAlias('glm-5.2'), '干净名 → 不需要');
  assert.ok(!fr.needsFriendlyAlias('intern-s2'), '干净名 → 不需要');
});

console.log('\n[4e] 自动生成友好别名（拉取时）');
t('seedFriendlyAliases：为噪音模型名建两种别名，原名保留', () => {
  const ch = channels.getChannel('openrouter');
  const ids = [
    'deepseek.ai/deepseek-v4.1-flash:free',   // 需友好化
    'nvidia/nemotron-3-super-120b-a12b:free', // 需友好化
    'glm-5.2',                                 // 干净，不造别名
  ];
  const res = catalog.seedFriendlyAliases(ch.id, ids);
  assert.ok(res.created >= 4, `应至少建 4 条（2 个模型 × 2 形态），实际 ${res.created}`);

  // 用小写的友好名解析 → 应命中 openrouter 渠道，上游名是带前缀的原文
  const c1 = aliases.resolveCandidates('deepseek-v4.1-flash');
  const or1 = c1.find((x) => x.channelName === 'openrouter');
  assert.ok(or1, 'openrouter 渠道应有该别名');
  assert.strictEqual(or1.upstreamName, 'deepseek.ai/deepseek-v4.1-flash:free');

  // 大写的友好名同样能解析
  const c2 = aliases.resolveCandidates('Deepseek-V4.1-Flash');
  const or2 = c2.find((x) => x.channelName === 'openrouter');
  assert.ok(or2, '首字母大写形态也应能解析');
  assert.strictEqual(or2.upstreamName, 'deepseek.ai/deepseek-v4.1-flash:free');

  // 原名照样能用（同名直通）
  const c3 = aliases.resolveCandidates('deepseek.ai/deepseek-v4.1-flash:free');
  assert.ok(c3.length > 0, '上游原名必须仍然可调用');
});

t('seedFriendlyAliases：幂等（重复跑不产生重复记录）', () => {
  const ch = channels.getChannel('openrouter');
  const before = aliases.listAliases({ channel: 'openrouter' }).length;
  catalog.seedFriendlyAliases(ch.id, ['deepseek.ai/deepseek-v4.1-flash:free']);
  const after = aliases.listAliases({ channel: 'openrouter' }).length;
  assert.strictEqual(after, before, '重复拉取不应重复建别名');
});

t('removeFriendlyAliases：只删自动生成的，不动手工映射', () => {
  const ch = channels.getChannel('openrouter');
  // 手工建一条不该被删
  aliases.addAlias({ public_name: 'my-manual-name', upstream_name: 'glm-5.2', channel: 'openrouter' });
  const removed = catalog.removeFriendlyAliases(ch.id);
  assert.ok(removed >= 2, `应删掉自动生成的别名，实际 ${removed}`);
  // listAliases 返回下划线字段（仓储层原始形态）
  const left = aliases.listAliases({ channel: 'openrouter' }).map((a) => a.public_name);
  assert.ok(!left.includes('deepseek-v4.1-flash'), '自动别名应已删除');
  assert.ok(left.includes('my-manual-name'), `手工映射必须保留，实际剩: ${left.join(',')}`);
});

console.log('[7] token');
await ta('创建与校验 token', async () => {
  const { token } = tokens.createToken('tester');
  assert.ok(token.startsWith('sk-api2api-'));
  assert.strictEqual(tokens.verifyToken(token), true);
  assert.strictEqual(tokens.verifyToken('bogus'), false);
  const list = tokens.listTokens();
  assert.ok(list.length >= 1);
  assert.ok(!JSON.stringify(list).includes(token), '列表不得含明文 token');
});

// ---------- 验活：顺序试模型，首个成功即返回 ----------
console.log('\n[9] 验活 · 「发 hi 等首字」逐个试模型');

t('候选模型按上游声明顺序（seq），不做名字打分重排', () => {
  // 造一个渠道的目录，顺序刻意与字母序不同
  const ch = channels.getChannel('sensenova');
  catalog.replaceChannelModels(ch.id, ['zzz-last-model', 'aaa-first-model', 'mmm-mid-model']);
  const cands = firstbyte.listProbeCandidates('sensenova');
  assert.deepStrictEqual(cands, ['zzz-last-model', 'aaa-first-model', 'mmm-mid-model'],
    '必须严格按写入顺序（= 上游声明顺序），不能按字母序或名字特征重排');
});

await ta('第 1 个模型限流失败 → 第 2 个成功 → 立刻返回，不试第 3 个', async () => {
  const ch = channels.getChannel('sensenova');
  catalog.replaceChannelModels(ch.id, ['m1-rate-limited', 'm2-ok', 'm3-should-not-try']);

  const tried = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opt) => {
    const model = JSON.parse(opt.body).model;
    tried.push(model);
    if (model === 'm1-rate-limited') {
      return new Response(JSON.stringify({ error: { code: 'RateLimitExceeded', message: 'inference exceeds tpm/rpm limit' } }),
        { status: 429, headers: { 'Content-Type': 'application/json' } });
    }
    // m2-ok：返回一个 SSE 流，首帧即带内容
    const sse = 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'hi' } }] }) + '\n\n';
    return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };

  try {
    const r = await firstbyte.verifyKeyFirstByte('sk-test', 'sensenova');
    assert.strictEqual(r.ok, true, '第 2 个模型能出字 → 整体应成功');
    assert.strictEqual(r.model, 'm2-ok', `应用 m2-ok，实际 ${r.model}`);
    assert.strictEqual(r.attempted, 2, `应只试 2 个模型，实际 ${r.attempted}`);
    assert.deepStrictEqual(tried, ['m1-rate-limited', 'm2-ok'],
      '第 3 个模型绝不能被尝试（首个成功即返回）');
  } finally {
    globalThis.fetch = origFetch;
  }
});

await ta('限流不会被当成"Key 坏了"→ 继续试下一个模型（这正是绑不上的原因）', async () => {
  const ch = channels.getChannel('sensenova');
  catalog.replaceChannelModels(ch.id, ['m1-limited', 'm2-limited', 'm3-ok']);

  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opt) => {
    const model = JSON.parse(opt.body).model;
    if (model !== 'm3-ok') {
      return new Response(JSON.stringify({ error: { code: 'RateLimitExceeded', message: 'inference exceeds tpm/rpm limit' } }),
        { status: 429, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: 'x' } }] }) + '\n\n',
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
  try {
    const r = await firstbyte.verifyKeyFirstByte('sk-test', 'sensenova');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.model, 'm3-ok');
    assert.strictEqual(r.attempted, 3);
  } finally {
    globalThis.fetch = origFetch;
  }
});

await ta('全部模型都失败 → ok=false，且 tried 记录每一个模型', async () => {
  const ch = channels.getChannel('sensenova');
  catalog.replaceChannelModels(ch.id, ['a1', 'a2']);

  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ error: { code: 'RateLimitExceeded', message: 'limit' } }),
    { status: 429, headers: { 'Content-Type': 'application/json' } },
  );
  try {
    const r = await firstbyte.verifyKeyFirstByte('sk-test', 'sensenova');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.attempted, 2);
    assert.deepStrictEqual(r.tried.map((x) => x.model), ['a1', 'a2']);
  } finally {
    globalThis.fetch = origFetch;
  }
});

await ta('★ 严格串行：任一时刻最多只有 1 个请求在飞（用户明确要求"不能同时打"）', async () => {
  const ch = channels.getChannel('sensenova');
  catalog.replaceChannelModels(ch.id, ['s1', 's2', 's3', 's4-ok']);

  let inflight = 0;
  let maxInflight = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opt) => {
    inflight += 1;
    maxInflight = Math.max(maxInflight, inflight);
    await new Promise((r) => setTimeout(r, 20));
    inflight -= 1;
    const model = JSON.parse(opt.body).model;
    if (model !== 's4-ok') {
      return new Response(JSON.stringify({ error: { code: 'RateLimitExceeded', message: 'tpm/rpm limit' } }),
        { status: 429, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: 'hi' } }] }) + '\n\n',
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
  try {
    const r = await firstbyte.verifyKeyFirstByte('sk-test', 'sensenova');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.model, 's4-ok');
    assert.strictEqual(maxInflight, 1,
      `必须是严格串行（maxInflight 应为 1，实际 ${maxInflight}）—— 并发会加剧上游限流`);
  } finally {
    globalThis.fetch = origFetch;
  }
});

await ta('模型不存在（CONFIG_FAULT）→ 继续试下一个，不误判 Key 坏了', async () => {
  const ch = channels.getChannel('sensenova');
  catalog.replaceChannelModels(ch.id, ['c1-missing', 'c2-missing', 'c3-missing', 'c4-ok']);

  const tried = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opt) => {
    const model = JSON.parse(opt.body).model;
    tried.push(model);
    if (model !== 'c4-ok') {
      // 商汤「模型不存在」= 字符串 code "5"
      return new Response(JSON.stringify({ error: { code: '5', message: 'model not found' } }),
        { status: 404, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: 'hi' } }] }) + '\n\n',
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
  try {
    const r = await firstbyte.verifyKeyFirstByte('sk-test', 'sensenova');
    assert.strictEqual(r.ok, true, '第 4 个能用 → 整体应成功');
    assert.strictEqual(r.model, 'c4-ok');
    assert.deepStrictEqual(tried, ['c1-missing', 'c2-missing', 'c3-missing', 'c4-ok'],
      '必须按顺序跳过所有"不存在的模型"');
  } finally {
    globalThis.fetch = origFetch;
  }
});

await ta('认证失败也要试完全部模型（单模型无权限 ≠ Key 坏了）', async () => {
  const ch = channels.getChannel('sensenova');
  catalog.replaceChannelModels(ch.id, ['p1', 'p2', 'p3']);

  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ error: { code: 16, message: 'Forbidden' } }),
    { status: 401, headers: { 'Content-Type': 'application/json' } });
  try {
    const r = await firstbyte.verifyKeyFirstByte('sk-test', 'sensenova');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.attempted, 3, '应把 3 个模型都试完（商汤 PERMISSION_DENIED 可能只是单模型无权限）');
    assert.strictEqual(r.errClass, 'auth', '全失败时主导错误应是认证错误（信息最明确）');
  } finally {
    globalThis.fetch = origFetch;
  }
});

t('★ 验活超时配置必须存在 —— 否则 deadline=NaN 会让每个模型被瞬间中断', () => {
  assert.strictEqual(typeof config.verifyTotalBudgetMs, 'number',
    'config.verifyTotalBudgetMs 必须是数字（曾为 undefined → NaN → 每个请求秒断）');
  assert.ok(Number.isFinite(config.verifyTotalBudgetMs) && config.verifyTotalBudgetMs > 0,
    `verifyTotalBudgetMs 应 > 0，实际 ${config.verifyTotalBudgetMs}`);
  assert.ok(Number.isFinite(Date.now() + config.verifyTotalBudgetMs),
    'deadline 必须是有限数字');
  assert.ok(Number.isFinite(config.verifyPerModelTimeoutMs) && config.verifyPerModelTimeoutMs > 0);
});

console.log('\n[10] 复核续期 · 「复核通过 → 再保 3 天」（滑动窗口）');

t('renewGrace / graceUntilOf 基本读写', () => {
  const uuid = 'u-renew-1';
  keys.addKey({ channel: 'intern', key: 'sk-renew-1', uuid, owner: 'frank' });
  assert.strictEqual(keys.graceUntilOf(uuid), 0, '初始无豁免');

  const now = Date.now();
  const until = keys.renewGrace(uuid, 3 * 24 * 3600_000, now);
  assert.strictEqual(until, now + 3 * 24 * 3600_000);
  assert.strictEqual(keys.graceUntilOf(uuid), until, '写入应可读回');
});

t('★ renewGrace 取 max：晚到的复核不会把窗口缩短', () => {
  const uuid = 'u-renew-2';
  keys.addKey({ channel: 'intern', key: 'sk-renew-2', uuid, owner: 'frank' });
  const t0 = 1_000_000_000_000;
  const a = keys.renewGrace(uuid, 3 * 24 * 3600_000, t0);           // 先到
  const b = keys.renewGrace(uuid, 3 * 24 * 3600_000, t0 - 3600_000); // 后到但时钟更早
  assert.strictEqual(keys.graceUntilOf(uuid), a, '取 max，不应该被更早的时间戳覆盖');
  assert.strictEqual(b, t0 - 3600_000 + 3 * 24 * 3600_000, 'b 是它自己算出来的值');
});

t('★ 复核续期内（grace_until > now）→ 不参与零成功判定', () => {
  const uuid = 'u-renew-3';
  keys.addKey({ channel: 'intern', key: 'sk-renew-3', uuid, owner: 'frank' });
  state.recordFailure(uuid, 'm1', { action: 'cooldown', nextRetryAt: Date.now() + 1000, streak: 1, error: 'e' });

  const now = Date.now();
  // 不加豁免时：命中（而且它够老 —— 用 minAgeMs=0 破除年龄门槛干扰）
  const before = new Set(state.keysWithNoSuccess(3, { minAgeMs: 0, now }).map((x) => x.uuid));
  assert.ok(before.has(uuid), '续期前应命中失效');

  // 续期后：不再命中
  keys.renewGrace(uuid, 3 * 24 * 3600_000, now);
  const after = new Set(state.keysWithNoSuccess(3, { minAgeMs: 0, now }).map((x) => x.uuid));
  assert.ok(!after.has(uuid), '复核续期内必须豁免 —— 这就是「通过后继续三天缓冲」');
});

t('★ 续期到期后又恢复判定（窗口是滑动的，不是永久豁免）', () => {
  const uuid = 'u-renew-4';
  keys.addKey({ channel: 'intern', key: 'sk-renew-4', uuid, owner: 'frank' });
  state.recordFailure(uuid, 'm1', { action: 'cooldown', nextRetryAt: Date.now() + 1000, streak: 1, error: 'e' });

  const now = Date.now();
  // ⚠️ 用短续期（1 小时）来测：若续 3 天，快进到到期时 key_daily 已落在 3 天窗口外，
  //    查询本身查不到记录，测不出「恢复判定」这件事。
  const until = keys.renewGrace(uuid, 3600_000, now);
  // 到期前一刻：仍豁免
  const justBefore = new Set(state.keysWithNoSuccess(3, { minAgeMs: 0, now: until - 1 }).map((x) => x.uuid));
  assert.ok(!justBefore.has(uuid), '到期前应仍豁免');
  // 到期后：重新命中
  const justAfter = new Set(state.keysWithNoSuccess(3, { minAgeMs: 0, now: until + 1 }).map((x) => x.uuid));
  assert.ok(justAfter.has(uuid), '到期后应恢复判定 —— 不能永久豁免');
});

t('★ 复核续期与「新绑宽限」是两重独立豁免', () => {
  // 一把不新（created_at 拨到 10 天前）、但复核续期中的 Key
  const uuid = 'u-renew-5';
  keys.addKey({ channel: 'intern', key: 'sk-renew-5', uuid, owner: 'frank' });
  const now = Date.now();
  // 手工把 created_at 拨老
  getDb().prepare('UPDATE channel_key SET created_at = ? WHERE uuid = ?')
    .run(now - 10 * 24 * 3600_000, uuid);
  state.recordFailure(uuid, 'm1', { action: 'cooldown', nextRetryAt: now + 1000, streak: 1, error: 'e' });

  // 无豁免 + 够老 → 命中
  const noGrace = new Set(state.keysWithNoSuccess(3, { minAgeMs: 3 * 24 * 3600_000, now }).map((x) => x.uuid));
  assert.ok(noGrace.has(uuid), '10 天前绑定且无豁免 → 应命中');

  // 加复核续期 → 即使够老也豁免
  keys.renewGrace(uuid, 3 * 24 * 3600_000, now);
  const withGrace = new Set(state.keysWithNoSuccess(3, { minAgeMs: 3 * 24 * 3600_000, now }).map((x) => x.uuid));
  assert.ok(!withGrace.has(uuid), '复核续期应能豁免「够老」的 Key');
});

t('续期配置项存在且为 3 天（用户明确要求）', () => {
  assert.strictEqual(config.keyGraceRenewMs, 3 * 24 * 3600 * 1000,
    `复核续期应为 3 天，实际 ${config.keyGraceRenewMs / 3600000} 小时`);
});

/* ============================================================
 * ⭐ [11] 熔断预算（最多试四分之一的号）
 * ============================================================ */
console.log('\n[11] 熔断预算 · 「最多尝试四分之一的号」');

t('★ 8 把可用 Key → 预算 2（四分之一）', () => {
  assert.strictEqual(sched.channelBudget(8), 2);
});
t('★ 11 把可用 Key → 预算 3（ceil(11/4)=3）', () => {
  assert.strictEqual(sched.channelBudget(11), 3);
});
t('★ 大池子被 maxAttemptsPerChannel 截断（用户硬上限）', () => {
  assert.strictEqual(sched.channelBudget(100), config.maxAttemptsPerChannel);
});
t('★★ 小池子有下限：3 把 Key 仍可试 2 次（否则连换 Key 都做不到）', () => {
  // 这是真实回归：ceil(3/4)=1 会让商汤只试 1 把就放弃，e2e 三条路由用例全落到下一渠道。
  const b = sched.channelBudget(3);
  assert.strictEqual(b, 2, `3 把 Key 的预算应为 2（能换一次），实际 ${b}`);
});
t('★ 单 Key 渠道仍可用（预算=1，不会被 clamp 成 0）', () => {
  assert.strictEqual(sched.channelBudget(1), 1);
});
t('★ 池子被打掉一批时，分母跟着变小（不烧剩下那两把）', () => {
  // 40 把的池子只剩 4 把可用 → ceil(4/4)=1 → clamp 到 2（下限）
  // 关键：不能按"原有 40 把"算成 10，否则剩下那几把会被烧光
  assert.ok(sched.channelBudget(4) <= 2, '池子缩水时预算必须跟着缩');
});
t('★ 预算永远不超过池子规模', () => {
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20]) {
    assert.ok(sched.channelBudget(n) <= n, `${n} 把 Key 的预算不应超过 ${n}`);
    assert.ok(sched.channelBudget(n) >= 1, `${n} 把 Key 的预算至少 1`);
  }
});

/* ============================================================
 * ⭐ [12] 模型级健康度（正常 → 降级 → 不可用）
 * ============================================================ */
console.log('\n[12] 模型级健康度 · 「分多级，不然全池子死了」');
const snCh = channels.getChannel('sensenova').id;

t('★ 连续失败 3 次 → DEGRADED（降级，只试 1 次）', () => {
  mh.resetModelHealth(snCh, 'm-degrade');
  for (let i = 0; i < 2; i++) mh.recordModelFailure(snCh, 'm-degrade', ErrClass.QUOTA, 'x', 'sensenova');
  const g1 = sched.modelGate(snCh, 'm-degrade', { channelName: 'sensenova' });
  assert.strictEqual(g1.state, 'NORMAL', '前 2 次失败仍应正常');
  assert.strictEqual(g1.attempts, 0, 'NORMAL 用渠道预算（0 = 不特殊限制）');

  mh.recordModelFailure(snCh, 'm-degrade', ErrClass.QUOTA, 'x', 'sensenova');
  const g2 = sched.modelGate(snCh, 'm-degrade', { channelName: 'sensenova' });
  assert.strictEqual(g2.state, 'DEGRADED', '第 3 次失败应降级');
  assert.strictEqual(g2.attempts, 1, '降级时只允许试 1 次');
  assert.strictEqual(g2.allow, true, '降级仍允许参与调度');
});

t('★ 继续失败到 6 次 → UNAVAILABLE（直接跳过）', () => {
  for (let i = 0; i < 3; i++) mh.recordModelFailure(snCh, 'm-degrade', ErrClass.QUOTA, 'x', 'sensenova');
  const g = sched.modelGate(snCh, 'm-degrade', { channelName: 'sensenova' });
  assert.strictEqual(g.state, 'UNAVAILABLE');
  assert.strictEqual(g.allow, false, '不可用应默认跳过');
  assert.strictEqual(g.attempts, 0);
});

t('★ UNAVAILABLE 兜底：全渠道都不可用时允许试 1 次（不能让请求直接失败）', () => {
  const g = sched.modelGate(snCh, 'm-degrade', { fallback: true, channelName: 'sensenova' });
  assert.strictEqual(g.allow, true);
  assert.strictEqual(g.attempts, 1);
});

t('★★ 成功一次立刻回 NORMAL（成功即恢复健康）', () => {
  mh.recordModelSuccess(snCh, 'm-degrade', 'sensenova');
  const g = sched.modelGate(snCh, 'm-degrade', { channelName: 'sensenova' });
  assert.strictEqual(g.state, 'NORMAL', '成功一次就该恢复');
  const h = mh.getModelHealth(snCh, 'm-degrade', Date.now(), 'sensenova');
  assert.strictEqual(h.fail_streak, 0, '连续失败计数应清零');
});

t('★★ AUTH 不计入模型健康度（Key 死了不连坐模型）', () => {
  mh.resetModelHealth(snCh, 'm-auth');
  const out = sched.applyModelFailure(snCh, 'm-auth', ErrClass.AUTH, 'invalid key', 'sensenova');
  assert.strictEqual(out, null, 'AUTH 应被判定为"不是模型的锅"');
  const h = mh.getModelHealth(snCh, 'm-auth', Date.now(), 'sensenova');
  assert.strictEqual(h.fail_streak, 0, 'AUTH 不应累加模型的失败次数');
});

t('★ REQUEST_FAULT 不计入模型健康度（请求体问题不是模型的锅）', () => {
  mh.resetModelHealth(snCh, 'm-req');
  assert.strictEqual(sched.applyModelFailure(snCh, 'm-req', ErrClass.REQUEST_FAULT, 'bad', 'sensenova'), null);
  assert.strictEqual(mh.getModelHealth(snCh, 'm-req', Date.now(), 'sensenova').fail_streak, 0);
});

t('★ UNAVAILABLE 到期后降到 DEGRADED 观察（不直接回 NORMAL）', () => {
  mh.resetModelHealth(snCh, 'm-recover');
  for (let i = 0; i < 6; i++) mh.recordModelFailure(snCh, 'm-recover', ErrClass.QUOTA, 'x', 'sensenova');
  const h = mh.getModelHealth(snCh, 'm-recover', Date.now(), 'sensenova');
  assert.strictEqual(h.state, 'UNAVAILABLE');
  // 快进时钟：读侧按 after 判定 → 应显示 DEGRADED（不是 NORMAL）
  const after = (h.disabled_until ?? Date.now()) + 1;
  const h2 = mh.getModelHealth(snCh, 'm-recover', after, 'sensenova');
  assert.strictEqual(h2.state, 'DEGRADED', '到期应降到 DEGRADED（不是 NORMAL）');
  // 惰性维护真的把库里那行改掉
  mh.reviveExpired(after);
  const row = dbx.one('SELECT state FROM model_health WHERE channel_id=? AND model=?', snCh, 'm-recover');
  assert.strictEqual(row.state, 'DEGRADED', '库里的状态也应被降到 DEGRADED');
  // 降到 DEGRADED 后只试 1 次 —— 一个真坏的模型不会每 24h 又被全池子烧一轮
  const g = sched.modelGate(snCh, 'm-recover', { channelName: 'sensenova' });
  assert.strictEqual(g.state, 'DEGRADED');
  assert.strictEqual(g.attempts, 1);
});

t('★ 模型健康度按 (渠道 × 模型) 隔离，互不影响', () => {
  const itCh = channels.getChannel('intern').id;
  mh.resetModelHealth(snCh, 'm-iso');
  mh.resetModelHealth(itCh, 'm-iso');
  for (let i = 0; i < 3; i++) mh.recordModelFailure(snCh, 'm-iso', ErrClass.QUOTA, 'x', 'sensenova');
  assert.strictEqual(mh.getModelHealth(snCh, 'm-iso', Date.now(), 'sensenova').state, 'DEGRADED');
  assert.strictEqual(mh.getModelHealth(itCh, 'm-iso', Date.now(), 'intern').state, 'NORMAL',
    '同一模型在别的渠道不该受影响');
});

/* ============================================================
 * ⭐ [13] 内置问题模型规则
 * ============================================================ */
console.log('\n[13] 内置问题模型规则 · 「组成一个内置规则」');

t('★ 画图模型（商汤 u1*）被识别为「非 chat 端点」', () => {
  assert.ok(modelRules.isNonChatModel('sensenova', 'sensenova-u1-fast'), 'sensenova-u1-fast 应识别为画图模型');
  assert.ok(modelRules.isNonChatModel('sensenova', 'sensenova-u1.5-lite'), 'u1.5-lite 应识别为画图模型');
  assert.ok(!modelRules.isNonChatModel('sensenova', 'glm-5.2'), 'glm-5.2 不是画图模型');
});

t('★★ 画图模型的「路径 404」不计入健康度（失效了不判真失效）', () => {
  // 用户原话：「有些画图模型 失效了不判真失效」——
  // 画图模型走 /v1/images/generations，用 chat 打必然 404，
  // 那是路径不对，不是模型坏。累计 6 次也不能把它熔断。
  mh.resetModelHealth(snCh, 'sensenova-u1-fast');
  for (let i = 0; i < 8; i++) {
    const out = mh.recordModelFailure(snCh, 'sensenova-u1-fast', ErrClass.CONFIG_FAULT, 'model route not found', 'sensenova');
    assert.strictEqual(out, null, '画图模型的路径 404 应被豁免');
  }
  const h = mh.getModelHealth(snCh, 'sensenova-u1-fast', Date.now(), 'sensenova');
  assert.strictEqual(h.state, 'NORMAL', '画图模型不该因 chat 404 被熔断');
  assert.strictEqual(h.fail_streak, 0);
});

t('★ 爱 429 的模型首次见即 DEGRADED（预置，不必先烧 Key）', () => {
  // deepseek-v4-pro 在商汤被内置规则标为"限流严格"
  const seed = modelRules.initialModelState('sensenova', 'deepseek-v4-pro');
  assert.strictEqual(seed.state, 'DEGRADED');
  assert.strictEqual(seed.kind, modelRules.RuleKind.RATE_LIMIT_PRONE);
});

t('★ OpenRouter 的 :free 模型被预置为 DEGRADED', () => {
  const seed = modelRules.initialModelState('openrouter', 'google/gemma-4-31b-it:free');
  assert.strictEqual(seed.state, 'DEGRADED');
});

t('★ 内置规则只影响"没有记录时"的初值；有记录则运行时结论优先', () => {
  const seedCh = channels.getChannel('sensenova').id;
  // 预置为 DEGRADED 的模型，实际成功一次后就该回 NORMAL
  mh.recordModelSuccess(seedCh, 'deepseek-v4-pro', 'sensenova');
  const h = mh.getModelHealth(seedCh, 'deepseek-v4-pro', Date.now(), 'sensenova');
  assert.strictEqual(h.state, 'NORMAL', '运行时成功的结论必须覆盖静态规则');
  assert.strictEqual(h.fromRule, false);
});

t('★ 普通模型不受内置规则影响（保持 NORMAL）', () => {
  const seed = modelRules.initialModelState('sensenova', 'glm-5.2');
  assert.strictEqual(seed.state, 'NORMAL');
});

t('★ modelGate 对内置规则预置的降级模型只给 1 次机会', () => {
  const seedCh = channels.getChannel('sensenova').id;
  // 该模型没有任何记录 → 走内置规则
  dbx.run('DELETE FROM model_health WHERE channel_id=? AND model=?', seedCh, 'kimi-k3');
  const g = sched.modelGate(seedCh, 'kimi-k3', { channelName: 'sensenova' });
  assert.strictEqual(g.state, 'DEGRADED', '内置规则应预置为降级');
  assert.strictEqual(g.attempts, 1, '降级只试 1 次 —— 不占熔断预算');
  assert.strictEqual(g.fromRule, true, '应标记来源是内置规则');
});

t('★ 规则可由环境变量叠加', () => {
  const fakeCfg = { builtinModelRules: 1, rateLimitProneModels: 'my-slow-model', nonChatModels: '' };
  const seed = modelRules.initialModelState('sensenova', 'my-slow-model', fakeCfg);
  assert.strictEqual(seed.state, 'DEGRADED', 'env 指定的模型也应预置降级');
});

t('★ 内置规则可整体关闭（BUILTIN_MODEL_RULES=0）', () => {
  const off = { builtinModelRules: 0, rateLimitProneModels: '', nonChatModels: '' };
  const seed = modelRules.initialModelState('sensenova', 'deepseek-v4-pro', off);
  assert.strictEqual(seed.state, 'NORMAL', '关掉后不该预置');
});

/* ============================================================
 * ⭐ [14] 「最后调用的模型」+ 成功率口径
 * ============================================================ */
console.log('\n[14] 最后调用的模型 · 「冷却中要显示最后调用什么模型」');

t('★ keyHealthMap 给出该 Key 最后调用的模型与时间', () => {
  keys.addKey({ channel: 'sensenova', key: 'sk-lastmodel', uuid: 'u-lastmodel' });
  const t0 = Date.now();
  state.recordFailure('u-lastmodel', 'model-A', { action: 'soft', nextRetryAt: t0 + 60000, error: 'e' });
  state.recordFailure('u-lastmodel', 'model-B', { action: 'soft', nextRetryAt: t0 + 60000, error: 'e' });
  // 手工把 model-A 的 last_used_at 拨到更早，确保 model-B 是"最后一次"
  dbx.run('UPDATE key_state SET last_used_at = ? WHERE key_uuid=? AND model=?', t0 - 10000, 'u-lastmodel', 'model-A');
  dbx.run('UPDATE key_state SET last_used_at = ? WHERE key_uuid=? AND model=?', t0, 'u-lastmodel', 'model-B');

  const h = state.keyHealthMap().get('u-lastmodel');
  assert.strictEqual(h.lastModel, 'model-B', `最后调用的应是 model-B，实际 ${h.lastModel}`);
  assert.ok(h.lastModelAt > 0, '应带时间戳');
});

t('★ 最后调用的模型若正处于异常 → 能指出"就是它打挂的"', () => {
  keys.addKey({ channel: 'sensenova', key: 'sk-lastbad', uuid: 'u-lastbad' });
  const now = Date.now();
  state.recordFailure('u-lastbad', 'bad-model', {
    action: 'cooldown', nextRetryAt: now + 10 * 60_000, streak: 1, error: '429',
  });
  const h = state.keyHealthMap().get('u-lastbad');
  assert.strictEqual(h.lastModel, 'bad-model');
  assert.strictEqual(h.state, 'COOLDOWN');
  // keyHealthMap 给出该模型自己的状态
  assert.strictEqual(h.lastModelState, 'COOLDOWN', 'keyHealthMap 应给出该模型的状态');
  // 上层 shape() 把它折算成布尔，供前端直接渲染
  const k = keys.getKey('u-lastbad');
  const shaped = shapeFn(k, h, null);
  assert.strictEqual(shaped.lastModel, 'bad-model');
  assert.strictEqual(shaped.lastModelBad, true, '该模型异常时 lastModelBad 应为 true');
  assert.ok(shaped.lastModelAgoMs >= 0, '应给出"多久之前"');
});

t('★ 从未被调用过的 Key：lastModel 为 null（不是空字符串）', () => {
  keys.addKey({ channel: 'sensenova', key: 'sk-never', uuid: 'u-never' });
  const h = state.keyHealthMap().get('u-never');
  // 该 Key 没有 key_state 行 → 聚合里根本没有它 → undefined 也对
  assert.ok(h === undefined || h.lastModel === null, '未调用过的 Key 不该有 lastModel');
});

t('★ last_used_at 相同的两条记录不会互相覆盖出意外结果', () => {
  keys.addKey({ channel: 'sensenova', key: 'sk-tie', uuid: 'u-tie' });
  const ts = Date.now();
  state.recordFailure('u-tie', 'model-X', { action: 'soft', nextRetryAt: ts + 60000, error: 'e' });
  state.recordFailure('u-tie', 'model-Y', { action: 'soft', nextRetryAt: ts + 60000, error: 'e' });
  dbx.run('UPDATE key_state SET last_used_at = ? WHERE key_uuid=?', ts, 'u-tie');
  const h = state.keyHealthMap().get('u-tie');
  assert.ok(h.lastModel === 'model-X' || h.lastModel === 'model-Y', '时间相同时取任一都不该崩');
});

console.log('\n[15] 成功率统计（流水维度）');

t('★ successRates 返回三个维度，且 ok+fail == req', () => {
  const now = Date.now();
  for (let i = 0; i < 6; i++) {
    logsDb.logRequest({
      model: 'rate-model', publicModel: 'rate-model', channelId: snCh, keyUuid: 'u-rate',
      status: i < 4 ? 200 : 429, errClass: i < 4 ? ErrClass.OK : ErrClass.QUOTA,
      latencyMs: 100, attempts: 1, chain: null,
    });
  }
  const r = logsDb.successRates({ limit: 1000 });
  const row = r.byModel.find((x) => x.model === 'rate-model');
  assert.ok(row, '应能找到该模型');
  assert.strictEqual(row.req, 6);
  assert.strictEqual(row.ok, 4);
  assert.strictEqual(row.fail, 2);
  assert.strictEqual(row.ratePct, 66.7, `成功率应是 4/6=66.7%，实际 ${row.ratePct}`);
  assert.strictEqual(row.ok + row.fail, row.req, 'ok+fail 必须等于 req');
});

t('★ 无流水的维度返回空数组（不是报错）', () => {
  const r = logsDb.successRates({ limit: 5 });
  assert.ok(Array.isArray(r.byModel) && Array.isArray(r.byKey) && Array.isArray(r.byChannel));
});

t('★ modelChannelRates 分解错误分类（看得出"就是爱 429"）', () => {
  const rows = logsDb.modelChannelRates({ limit: 1000 });
  const hit = rows.find((x) => x.upstream_model === 'rate-model');
  assert.ok(hit, '应能找到该模型');
  assert.strictEqual(hit.quota_fail, 2, '应统计出 2 次 quota 失败');
});

console.log('\n[10] NVIDIA NIM 渠道 + 「只接快速模型」开关');

const nvidia = (await import('../src/adapters/nvidia.mjs')).default;
const fast = await import('../src/db/fast-models.mjs');
const settings = await import('../src/db/settings.mjs');
const adapterIndex = await import('../src/adapters/index.mjs');

t('NVIDIA 适配器已注册，base_url 正确', () => {
  assert.ok(adapterIndex.adapterIds().includes('nvidia'), 'nvidia 应在注册表里');
  assert.strictEqual(channels.getChannel('nvidia').base_url, 'https://integrate.api.nvidia.com/v1');
});

t('NVIDIA 401 → AUTH（标准 error 壳）', () => {
  const v = nvidia.classify(401, {}, JSON.stringify({ error: { message: 'Invalid API key.', type: 'AuthError' } }));
  assert.strictEqual(v.errClass, ErrClass.AUTH, `实际 ${v.errClass}`);
});

t('NVIDIA 429 → QUOTA', () => {
  const v = nvidia.classify(429, {}, JSON.stringify({ error: { message: 'Rate limit exceeded', type: 'RateLimitError' } }));
  assert.strictEqual(v.errClass, ErrClass.QUOTA, `实际 ${v.errClass}`);
});

t('NVIDIA 顶层 404（无 error 壳）→ CONFIG_FAULT', () => {
  // 实测形态：目录里有、本账号没订阅 → {"status":404,"title":"Not Found","detail":"Function ..."}
  const v = nvidia.classify(404, {}, JSON.stringify({ status: 404, title: 'Not Found', detail: "Function 'x' Not found for account" }));
  assert.strictEqual(v.errClass, ErrClass.CONFIG_FAULT, `实际 ${v.errClass}`);
});

t('NVIDIA 410 Gone（模型退役）→ CONFIG_FAULT', () => {
  const v = nvidia.classify(410, {}, JSON.stringify({ type: 'about:blank', title: 'Gone', status: 410, detail: "The model 'x' has reached its end of life" }));
  assert.strictEqual(v.errClass, ErrClass.CONFIG_FAULT, `实际 ${v.errClass}`);
});

t('★ 快速模型白名单：只含实测可用且快的（排除挂死/退役）', () => {
  const list = fast.fastModelsOf('nvidia');
  assert.ok(list.includes('nvidia/nemotron-3-super-120b-a12b'), '最稳的 super 应在白名单');
  assert.ok(!list.includes('z-ai/glm-5.3'), '挂死的 glm-5.3 不该在');
  assert.ok(!list.includes('moonshotai/kimi-k3'), '挂死的 kimi-k3 不该在');
  assert.ok(!list.includes('deepseek-ai/deepseek-v4.1-flash'), '挂死的 deepseek 不该在');
});

t('★ filterFastModels 只放行白名单内的', () => {
  const out = fast.filterFastModels('nvidia', [
    'nvidia/nemotron-3-super-120b-a12b', 'z-ai/glm-5.3', 'openai/gpt-oss-20b',
  ]);
  assert.deepStrictEqual(out, ['nvidia/nemotron-3-super-120b-a12b', 'openai/gpt-oss-20b']);
});

t('★ 非快速渠道不过滤（商汤/书生原样放行）', () => {
  const ids = ['glm-5.2', 'SenseChat-5-0903'];
  assert.deepStrictEqual(fast.filterFastModels('sensenova', ids), ids);
  assert.strictEqual(fast.isFastModel('sensenova', 'anything'), true);
});

t('★ 开关默认打开（出厂值）', () => {
  assert.strictEqual(settings.fastModelsOnly(), true, '默认应为「只接快速模型」');
  assert.strictEqual(settings.allSettings().fastModelsOnlyDefault, true);
});

t('★ 开关可切换并持久化', () => {
  settings.setFastModelsOnly(false);
  assert.strictEqual(settings.fastModelsOnly(), false);
  settings.setFastModelsOnly(true);
  assert.strictEqual(settings.fastModelsOnly(), true);
});

console.log('\n[11] 魔搭 ModelScope 渠道');

const msAdapter = (await import('../src/adapters/modelscope.mjs')).default;

t('ModelScope 适配器已注册，base_url 正确', () => {
  assert.ok(adapterIndex.adapterIds().includes('modelscope'), 'modelscope 应在注册表里');
  assert.strictEqual(channels.getChannel('modelscope').base_url, 'https://api-inference.modelscope.cn/v1');
});

t('ModelScope 未绑阿里云账号（401）→ AUTH（不是 CONFIG_FAULT）', () => {
  // 实测形态：token 能列模型，但 chat 被账号门挡住
  const v = msAdapter.classify(401, {}, JSON.stringify({
    error: { message: 'Please bind your Alibaba Cloud account before use.' },
    request_id: '3f854604-db29-48d9-9b4b-930dcb08079b',
  }));
  assert.strictEqual(v.errClass, ErrClass.AUTH, `实际 ${v.errClass}`);
  assert.strictEqual(v.traceId, '3f854604-db29-48d9-9b4b-930dcb08079b', '应解析顶层 request_id');
});

t('ModelScope 无效 token（401）→ AUTH', () => {
  const v = msAdapter.classify(401, {}, JSON.stringify({
    error: { message: 'Authentication failed, please make sure that a valid ModelScope token is supplied.' },
    request_id: 'req_x',
  }));
  assert.strictEqual(v.errClass, ErrClass.AUTH, `实际 ${v.errClass}`);
});

t('ModelScope 429 → QUOTA', () => {
  const v = msAdapter.classify(429, {}, JSON.stringify({
    error: { message: 'Too many requests, rate limit exceeded for this model.' }, request_id: 'r',
  }));
  assert.strictEqual(v.errClass, ErrClass.QUOTA, `实际 ${v.errClass}`);
});

t('ModelScope 模型不存在 → CONFIG_FAULT', () => {
  const v = msAdapter.classify(404, {}, JSON.stringify({
    error: { message: "The model 'x/y' does not exist." }, request_id: 'r',
  }));
  assert.strictEqual(v.errClass, ErrClass.CONFIG_FAULT, `实际 ${v.errClass}`);
});

t('★ ModelScope 不在「快速模型」过滤范围内（目录本身可用）', () => {
  assert.strictEqual(fast.isFastOnlyChannel('modelscope'), false);
  const ids = ['Qwen/Qwen3.5-35B-A3B', 'deepseek-ai/DeepSeek-V4-Pro'];
  assert.deepStrictEqual(fast.filterFastModels('modelscope', ids), ids);
});

console.log('\n[12] LLM7.io 渠道');

const llm7Adapter = (await import('../src/adapters/llm7.mjs')).default;

t('LLM7 适配器已注册，base_url 正确', () => {
  assert.ok(adapterIndex.adapterIds().includes('llm7'), 'llm7 应在注册表里');
  assert.strictEqual(channels.getChannel('llm7').base_url, 'https://api.llm7.io/v1');
});

t('★ LLM7 402 insufficient_balance → CONFIG_FAULT（付费档模型，跳过渠道，不罚 Key）', () => {
  // ⚠️ 这是关键：通用 openai_compat 会因文本含 insufficient 归成 QUOTA → 错误地冷却 Key + 反复重试
  const v = llm7Adapter.classify(402, {}, JSON.stringify({
    error: { message: 'Insufficient balance. Please top up your balance to continue.',
      type: 'insufficient_quota', code: 'insufficient_balance' },
  }));
  assert.strictEqual(v.errClass, ErrClass.CONFIG_FAULT, `实际 ${v.errClass}`);
});

t('★ LLM7 402 pro_access_required → CONFIG_FAULT', () => {
  const v = llm7Adapter.classify(402, {}, JSON.stringify({
    error: { message: 'Pro models require balance or an active subscription.', code: 'pro_access_required' },
  }));
  assert.strictEqual(v.errClass, ErrClass.CONFIG_FAULT, `实际 ${v.errClass}`);
});

t('LLM7 429 rate_limit_exceeded → QUOTA（带 retry_after）', () => {
  const v = llm7Adapter.classify(429, {}, JSON.stringify({
    error: { message: 'Rate limit exceeded. Retry after 919 seconds.', code: 'rate_limit_exceeded', retry_after: 919 },
  }));
  assert.strictEqual(v.errClass, ErrClass.QUOTA, `实际 ${v.errClass}`);
});

t('LLM7 400 model_unavailable → CONFIG_FAULT（目录里有、当前下线）', () => {
  const v = llm7Adapter.classify(400, {}, JSON.stringify({
    error: { message: "Model 'glm-5.3-flash' is currently unavailable.", code: 'model_unavailable' },
  }));
  assert.strictEqual(v.errClass, ErrClass.CONFIG_FAULT, `实际 ${v.errClass}`);
});

t('LLM7 无效 key（401）→ AUTH', () => {
  const v = llm7Adapter.classify(401, {}, JSON.stringify({
    error: { message: 'Your API key is invalid, expired, or revoked.', type: 'invalid_request_error' },
  }));
  assert.strictEqual(v.errClass, ErrClass.AUTH, `实际 ${v.errClass}`);
});

t('★ LLM7 也不在「快速模型」过滤范围内（免费档模型本就少）', () => {
  assert.strictEqual(fast.isFastOnlyChannel('llm7'), false);
});

/* ============================================================
 * [30] ⭐ 模型归并（同义名 → 规范名）—— 用户 2026-10-08
 * ============================================================ */
const syn = await import('../src/db/synonyms.mjs');
const ban = await import('../src/db/channel-ban.mjs');
const settingsDb = await import('../src/db/settings.mjs');

console.log('\n[30] 模型归并（同义名 → 规范名）');

t('归并：别名解析被重定向到规范名', () => {
  syn.addSynonym({ name: 'DeepSeek-V4-Flash-0731', canonical: 'deepseek-v4-flash' });
  assert.strictEqual(syn.canonicalOf('DeepSeek-V4-Flash-0731'), 'deepseek-v4-flash');
  // 大小写不敏感
  assert.strictEqual(syn.canonicalOf('deepseek-v4-flash-0731'), 'deepseek-v4-flash');
  // 规范名自身原样返回
  assert.strictEqual(syn.canonicalOf('deepseek-v4-flash'), 'deepseek-v4-flash');
  // 没配过的不受影响
  assert.strictEqual(syn.canonicalOf('glm-5.2'), 'glm-5.2');
});

t('归并：resolveCandidates 走规范名的候选', () => {
  catalog.replaceChannelModels(channels.getChannel('intern').id, ['deepseek-v4-flash']);
  const c = aliases.resolveCandidates('DeepSeek-V4-Flash-0731');
  assert.ok(c.length > 0, '别名应能解析出候选');
  assert.ok(c.some((x) => x.channelName === 'intern'), '应命中书生那条同名直通');
});

t('归并：别名不再单独出现在对外清单，只留规范名', () => {
  const ids = aliases.publicModelList().map((x) => x.id);
  assert.ok(ids.includes('deepseek-v4-flash'), `规范名应在，实际: ${ids.join(',')}`);
  assert.ok(!ids.includes('DeepSeek-V4-Flash-0731'), '别名应被折叠');
});

t('归并：同规范名下多个别名一起折叠', () => {
  syn.addSynonym({ name: 'deepseek-v4-flash:0731', canonical: 'deepseek-v4-flash' });
  syn.addSynonym({ name: 'Deepseek-V4-Flash', canonical: 'deepseek-v4-flash' });
  const ids = aliases.publicModelList().map((x) => x.id);
  assert.ok(!ids.includes('deepseek-v4-flash:0731'));
  assert.ok(!ids.includes('Deepseek-V4-Flash'));
  const entry = aliases.publicModelList().find((x) => x.id === 'deepseek-v4-flash');
  assert.strictEqual(entry.kind, 'synonym');
  assert.ok(entry.aliases.length >= 3, `应记录全部别名，实际 ${JSON.stringify(entry.aliases)}`);
});

t('归并：别名与规范名完全相同被拒（仅大小写不同是合法的）', () => {
  assert.throws(() => syn.addSynonym({ name: 'x', canonical: 'x' }), /相同/);
});

t('归并：删除后别名恢复为独立条目', () => {
  syn.deleteSynonym('Deepseek-V4-Flash');
  assert.strictEqual(syn.canonicalOf('Deepseek-V4-Flash'), 'Deepseek-V4-Flash');
});

/* ============================================================
 * [31] ⭐ 模型黑名单（原始渠道 × 原始上游模型）—— 用户 2026-10-08
 * ============================================================ */

console.log('\n[31] 模型黑名单');

t('内置"已确定用不了"名单已播种（商汤 6 个）', () => {
  const rows = ban.listBanned({ channel: 'sensenova' });
  const models = rows.map((r) => r.model).sort();
  assert.deepStrictEqual(models, [
    'deepseek-flash', 'deepseek-v4-pro', 'deepseek-v4.1-flash',
    'kimi-k3', 'sensenova-u1-fast', 'sensenova-u1.5-lite',
  ]);
  assert.ok(rows.every((r) => r.reason && r.reason.length > 10), '每条都要有可读理由（用户要求）');
});

t('黑名单键 = 原始渠道名 + 原始上游模型名', () => {
  const r = ban.ban({ channel: 'intern', model: 'bad-model-xyz', reason: '测试' });
  assert.strictEqual(r.channel, 'intern');
  assert.strictEqual(r.model, 'bad-model-xyz');
  assert.ok(ban.isBanned('intern', 'bad-model-xyz'));
  assert.ok(!ban.isBanned('sensenova', 'bad-model-xyz'), '同模型在别的渠道不受影响');
});

t('被拉黑的 (渠道,模型) 从对外清单里消失', () => {
  const it = channels.getChannel('intern').id;
  catalog.replaceChannelModels(it, ['good-model-abc', 'bad-model-xyz']);
  const ids = aliases.publicModelList().map((x) => x.id);
  assert.ok(ids.includes('good-model-abc'), '未拉黑的应在');
  assert.ok(!ids.includes('bad-model-xyz'), `被拉黑的不应出现，实际: ${ids.join(',')}`);
});

t('黑名单幂等：重复加入不报错、只更新理由', () => {
  ban.ban({ channel: 'intern', model: 'bad-model-xyz', reason: '第二次' });
  const rows = ban.listBanned({ channel: 'intern' });
  assert.strictEqual(rows.filter((r) => r.model === 'bad-model-xyz').length, 1);
  assert.strictEqual(rows.find((r) => r.model === 'bad-model-xyz').reason, '第二次');
});

t('解禁后重新出现在清单里', () => {
  ban.unban({ channel: 'intern', model: 'bad-model-xyz' });
  assert.ok(!ban.isBanned('intern', 'bad-model-xyz'));
  const ids = aliases.publicModelList().map((x) => x.id);
  assert.ok(ids.includes('bad-model-xyz'), '解禁后应重新可见');
});

t('bannedPairSet 给出 `${channelId}::${model}` 集合（relay 用）', () => {
  const set = ban.bannedPairSet();
  const sn = channels.getChannel('sensenova').id;
  assert.ok(set.has(`${sn}::kimi-k3`));
});

t('★ 自动拉黑：从未成功过 && 累计失败达阈值 → 自动加入', () => {
  const it = channels.getChannel('intern').id;
  const model = 'never-ok-model';
  settingsDb.setAutoBlacklistEnabled(true);
  for (let i = 0; i < 10; i++) {
    mh.recordModelFailure(it, model, 'quota', 'boom', 'intern');
  }
  assert.ok(ban.isBanned('intern', model), '从未成功 + 失败 10 次 应被自动拉黑');
  const row = ban.listBanned({ channel: 'intern' }).find((r) => r.model === model);
  assert.strictEqual(row.source, 'auto');
  assert.match(row.reason, /从未成功/);
});

t('★ 自动拉黑：成功过一次就不拉黑（失败率高交给健康度熔断）', () => {
  const it = channels.getChannel('intern').id;
  const model = 'sometimes-ok-model';
  mh.recordModelSuccess(it, model, 'intern');
  for (let i = 0; i < 15; i++) {
    mh.recordModelFailure(it, model, 'quota', 'boom', 'intern');
  }
  assert.ok(!ban.isBanned('intern', model), '成功过就不该被永久拉黑');
});

t('自动拉黑开关关闭时不加入', () => {
  const it = channels.getChannel('intern').id;
  const model = 'autoban-off-model';
  settingsDb.setAutoBlacklistEnabled(false);
  for (let i = 0; i < 12; i++) mh.recordModelFailure(it, model, 'quota', 'boom', 'intern');
  assert.ok(!ban.isBanned('intern', model));
  settingsDb.setAutoBlacklistEnabled(true);
});

t('★ 快速模式：NVIDIA 未收录模型默认拉黑；关掉开关则移除', () => {
  const nv = channels.getChannel('nvidia');
  assert.ok(nv, 'nvidia 渠道应存在');
  catalog.replaceChannelModels(nv.id, ['definitely-not-fast-model', 'nvidia/nemotron-3-super-120b-a12b']);
  let r = ban.applyFastModeBans(true);
  assert.ok(r.added >= 1, '应把未收录的拉黑');
  assert.ok(ban.isBanned('nvidia', 'definitely-not-fast-model'));
  assert.ok(!ban.isBanned('nvidia', 'nvidia/nemotron-3-super-120b-a12b'), '白名单内的不拉黑');

  r = ban.applyFastModeBans(false);
  assert.ok(r.removed >= 1, '关掉开关应移除 fast-mode 拉黑');
  assert.ok(!ban.isBanned('nvidia', 'definitely-not-fast-model'));
});

t('黑名单不影响内置来源：重算 fast-mode 不动 builtin', () => {
  ban.applyFastModeBans(true);
  ban.applyFastModeBans(false);
  assert.ok(ban.isBanned('sensenova', 'kimi-k3'), 'builtin 记录必须保留');
});

t('黑名单来源枚举完整（前端筛选用）', () => {
  const labels = Object.keys(ban.SOURCE_LABEL).sort();
  assert.deepStrictEqual(labels, ['auto', 'builtin', 'fast-mode', 'manual']);
});

t('★ banMany：批量拉黑（拉目录时被快速白名单挡掉的模型用这条路径）', () => {
  const nv = channels.getChannel('nvidia');
  const r = ban.banMany({
    channel: 'nvidia',
    models: ['a/slow-1', 'a/slow-2', 'a/slow-3'],
    reason: '快速模式未收录：测试',
    source: 'fast-mode',
  });
  assert.strictEqual(r.added, 3);
  assert.ok(ban.isBanned('nvidia', 'a/slow-1'));
  // 幂等：再来一次不再新增
  assert.strictEqual(ban.banMany({
    channel: 'nvidia', models: ['a/slow-1', 'a/slow-2'], reason: 'x', source: 'fast-mode',
  }).added, 0);
  return nv;
});

const orAdapterMod = (await import('../src/adapters/openrouter.mjs')).default;

await ta('★ OpenRouter 400「is not a valid model ID」→ CONFIG_FAULT（跳过渠道，不是 request_fault）', () => {
  const v = orAdapterMod.classify(400, {}, JSON.stringify({
    error: { message: 'nvidia/riva-translate-4b-instruct is not a valid model ID', code: 400 },
  }));
  assert.strictEqual(v.errClass, ErrClass.CONFIG_FAULT, `实际 ${v.errClass}`);
});

t('OpenRouter 400 纯参数错仍归 REQUEST_FAULT（不换渠道）', () => {
  const v = orAdapterMod.classify(400, {}, JSON.stringify({
    error: { message: 'invalid parameter: temperature must be <= 2', code: 400 },
  }));
  assert.strictEqual(v.errClass, ErrClass.REQUEST_FAULT, `实际 ${v.errClass}`);
});

t('★ ModelScope 400「Invalid model id」→ CONFIG_FAULT（跳过渠道，不是 request_fault）', () => {
  const v = msAdapter.classify(400, {}, JSON.stringify({
    error: { message: 'Invalid model id: nvidia/riva-translate-4b-instruct' },
  }));
  assert.strictEqual(v.errClass, ErrClass.CONFIG_FAULT, `实际 ${v.errClass}`);
});

t('ModelScope 400 真参数错仍归 REQUEST_FAULT', () => {
  const v = msAdapter.classify(400, {}, JSON.stringify({
    error: { message: 'invalid max_tokens: must be >= 1' },
  }));
  assert.strictEqual(v.errClass, ErrClass.REQUEST_FAULT, `实际 ${v.errClass}`);
});

t('设置项：黑名单总开关 / 自动加入 默认打开', () => {
  const s = settingsDb.allSettings();
  assert.strictEqual(s.blacklistEnabled, true);
  assert.strictEqual(s.autoBlacklistEnabled, true);
  assert.ok(s.autoBanAfterFails >= 1);
});

t('设置项：可切换并持久化', () => {
  settingsDb.setBlacklistEnabled(false);
  assert.strictEqual(settingsDb.blacklistEnabled(), false);
  settingsDb.setBlacklistEnabled(true);
  assert.strictEqual(settingsDb.blacklistEnabled(), true);
});

closeDb();
fs.rmSync(TMP, { recursive: true, force: true });

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===\n`);
process.exit(fail > 0 ? 1 : 0);
