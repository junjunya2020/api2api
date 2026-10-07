/**
 * 模块加载自检：逐个 import src 下所有 .mjs，暴露路径错误。
 * 这是被真实 bug（相对路径层级写错）驱动的检查脚本。
 */
import fs from 'node:fs';
import path from 'node:path';

const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.mjs')) files.push(p.replace(/\\/g, '/'));
  }
})('src');

let bad = 0;
for (const f of files.sort()) {
  try {
    await import('../' + f);
    console.log('OK    ' + f);
  } catch (err) {
    bad++;
    const code = err && err.code ? err.code : '';
    const msg = String(err && err.message).split('\n')[0];
    console.log('FAIL  ' + f + '  ' + code + ' ' + msg);
  }
}
console.log('\n共 ' + files.length + ' 个文件，失败 ' + bad + ' 个');
process.exit(bad ? 1 : 0);
