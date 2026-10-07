/**
 * 极简日志。带级别过滤，输出到 stdout（systemd 接管）。
 */
import config from '../config.mjs';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[config.logLevel] ?? LEVELS.info;

function emit(level, args) {
  if (LEVELS[level] < threshold) return;
  const ts = new Date().toISOString();
  const line = `${ts} [${level.toUpperCase()}]`;
  if (level === 'error') console.error(line, ...args);
  else console.log(line, ...args);
}

export const log = {
  debug: (...a) => emit('debug', a),
  info: (...a) => emit('info', a),
  warn: (...a) => emit('warn', a),
  error: (...a) => emit('error', a),
  /** 请求流水专用：紧凑一行，便于 grep */
  req: (fields) => emit('info', [JSON.stringify(fields)]),
};

export default log;
