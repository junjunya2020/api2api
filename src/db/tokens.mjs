/**
 * 下游客户端 token 仓储。只存 sha256，明文仅在创建时返回一次。
 */
import fs from 'node:fs';
import config from '../config.mjs';
import { all, one, run } from './index.mjs';
import { generateToken, tokenHash, safeEqual } from '../util/crypto.mjs';
import log from '../util/log.mjs';

let cachedAdminToken = null;

/**
 * 启动时确保存在至少一个 token（管理员 token）。
 * 明文写到 adminTokenFile（默认 <dataDir>/admin_token，chmod 600），供本地 curl 使用。
 * ⚠️ 日志里必须用 config.adminTokenFile 的实际值 —— 写死 "data/admin_token"
 *    在设了 DATA_DIR 时会把人指到错误路径。
 */
export function ensureAdminToken() {
  const count = one('SELECT COUNT(*) AS n FROM client_token')?.n ?? 0;
  if (count > 0) return null;

  const token = generateToken();
  run('INSERT INTO client_token (token_hash, name, enabled, created_at) VALUES (?, ?, 1, ?)',
    tokenHash(token), 'admin', Date.now());
  try {
    fs.writeFileSync(config.adminTokenFile, token, { mode: 0o600 });
  } catch (e) {
    log.warn('[tokens] 无法写入 admin_token 文件:', e.message);
  }
  log.info(`[tokens] 已生成初始 admin token，见 ${config.adminTokenFile}`);
  return token;
}

export function createToken(name = null) {
  const token = generateToken();
  run('INSERT INTO client_token (token_hash, name, enabled, created_at) VALUES (?, ?, 1, ?)',
    tokenHash(token), name, Date.now());
  return { token, name };
}

export function listTokens() {
  return all('SELECT token_hash, name, enabled, created_at, last_used_at FROM client_token ORDER BY created_at');
}

export function deleteToken(tokenOrName) {
  const h = tokenHash(tokenOrName);
  let res = run('DELETE FROM client_token WHERE token_hash = ?', h);
  if (res.changes === 0) res = run('DELETE FROM client_token WHERE name = ?', String(tokenOrName));
  return res.changes > 0;
}

/** 校验下游 token。返回 true/false，并刷新 last_used_at */
export function verifyToken(presented) {
  if (!presented) return false;
  const h = tokenHash(presented);
  const row = one('SELECT token_hash, enabled FROM client_token WHERE token_hash = ?', h);
  if (!row || !row.enabled) return false;
  if (!safeEqual(row.token_hash, h)) return false;
  // 异步刷新，不阻塞请求
  try { run('UPDATE client_token SET last_used_at = ? WHERE token_hash = ?', Date.now(), h); } catch { /* ignore */ }
  return true;
}

/** 供本地/测试使用：读取 admin token 明文文件 */
export function readAdminTokenFile() {
  if (cachedAdminToken) return cachedAdminToken;
  try {
    cachedAdminToken = fs.readFileSync(config.adminTokenFile, 'utf8').trim();
    return cachedAdminToken;
  } catch {
    return null;
  }
}

export default { ensureAdminToken, createToken, listTokens, deleteToken, verifyToken, readAdminTokenFile };
