/**
 * 静态文件服务。
 * 严格：不把 JS 塞进 HTML —— HTML 只引用外部 .css / .js 文件。
 *
 * 安全取舍：**不向页面注入 admin token**。
 * 本服务监听 127.0.0.1，但容器网络（172.17.0.1）等其它本机 uid 也能访问，
 * 一旦把 admin token 写进 HTML，任何本机可发起 HTTP 的进程都能拿到管理凭证，
 * 比「读 0600 的 data/admin_token 文件」权限要求低得多。
 * 因此 token 必须由用户从服务端读取后手动粘贴一次（存在浏览器 localStorage）。
 */
import fs from 'node:fs';
import path from 'node:path';
import config from '../config.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** 只允许这些扩展名被静态服务，其余一律 404（避免误暴露 .db / .key 等） */
const ALLOWED_EXT = new Set(Object.keys(MIME));

/**
 * 提供静态文件。pathname 形如 /ui/css/app.css
 * 做了目录穿越防护。
 */
export function serveStatic(req, res, pathname) {
  let rel = pathname.replace(/^\/+/, '');
  if (rel === '' || rel === 'ui' || rel === 'ui/') rel = 'index.html';
  if (rel.startsWith('ui/')) rel = rel.slice(3);

  const target = path.resolve(config.webDir, rel);
  // 目录穿越防护（必须带分隔符比较，否则 webfoo 会误判为 web 的子路径）
  const rootWithSep = config.webDir.endsWith(path.sep) ? config.webDir : config.webDir + path.sep;
  if (target !== config.webDir && !target.startsWith(rootWithSep)) {
    res.writeHead(403).end('Forbidden');
    return true;
  }

  const ext = path.extname(target).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) return false; // 交给上层返回 404

  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    return false; // 交给上层返回 404
  }
  if (stat.isDirectory()) return false;

  const type = MIME[ext];

  // 一律 no-cache：允许浏览器缓存但每次必须回源校验，避免改了 CSS/JS 却看不到效果。
  // （本项目无构建步骤，没有指纹文件名，强缓存是纯粹的坑。）
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache',
  });
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  fs.createReadStream(target).pipe(res);
  return true;
}

export default { serveStatic };

