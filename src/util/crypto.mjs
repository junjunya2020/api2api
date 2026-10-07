/**
 * Key 加密与指纹。
 * - 明文 Key 永不落盘：AES-256-GCM 加密后存 BLOB
 * - 判重不靠明文：sha256 指纹前 16 字节
 * - 下游 token 也只存 sha256
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import config from '../config.mjs';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;

let cachedKey = null;

/** 载入主密钥：env > 文件 > 自动生成。返回 32 字节 Buffer */
export function masterKey() {
  if (cachedKey) return cachedKey;

  if (config.masterKey) {
    const buf = Buffer.from(config.masterKey, 'hex');
    if (buf.length !== 32) throw new Error('MASTER_KEY 必须是 64 位 hex（32 字节）');
    cachedKey = buf;
    return cachedKey;
  }

  try {
    const raw = fs.readFileSync(config.masterKeyFile, 'utf8').trim();
    const buf = Buffer.from(raw, 'hex');
    if (buf.length === 32) {
      cachedKey = buf;
      return cachedKey;
    }
  } catch {
    /* 文件不存在，落到下面生成 */
  }

  const fresh = crypto.randomBytes(32);
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(config.masterKeyFile, fresh.toString('hex'), { mode: 0o600 });
  cachedKey = fresh;
  return cachedKey;
}

/**
 * 加密。返回 Buffer：[iv(12) | tag(16) | ciphertext]
 */
export function encryptSecret(plain) {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, masterKey(), iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

/** 解密。输入为 Buffer/Uint8Array */
export function decryptSecret(blob) {
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + 16);
  const ct = buf.subarray(IV_LEN + 16);
  const decipher = crypto.createDecipheriv(ALGO, masterKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/** 密钥指纹：sha256 前 16 字节 hex。用于同渠道内判重 */
export function fingerprint(plain) {
  return crypto.createHash('sha256').update(String(plain)).digest('hex').slice(0, 32);
}

/** 下游 token 的存储哈希 */
export function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/** 生成一个新的下游 token（带前缀便于识别） */
export function generateToken() {
  return 'sk-api2api-' + crypto.randomBytes(24).toString('base64url');
}

/** 生成 uuid v4（用于渠道 id 等） */
export function uuid() {
  return crypto.randomUUID();
}

/** 恒定时间比较，避免时序侧信道 */
export function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** 抖动：base 的 0~jitterRatio 倍随机附加 */
export function jitter(base, jitterRatio = 0.2) {
  return Math.round(base * (1 + Math.random() * jitterRatio));
}
