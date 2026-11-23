// One JSON object per line on stdout/stderr. Cloud Run / Cloud Logging reads `severity` and `message` automatically.
// Never pass tokens, passwords, keys or request bodies to the logger.
const config = require('../config');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const SEVERITY = { debug: 'DEBUG', info: 'INFO', warn: 'WARNING', error: 'ERROR' };
const threshold = LEVELS[process.env.LOG_LEVEL] || LEVELS.info;

function write(level, message, fields) {
  if (config.env === 'test' || LEVELS[level] < threshold) return;
  const line = JSON.stringify({ severity: SEVERITY[level], message, ...fields, time: new Date().toISOString() });
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
}

module.exports = {
  debug: (m, f) => write('debug', m, f),
  info: (m, f) => write('info', m, f),
  warn: (m, f) => write('warn', m, f),
  error: (m, f) => write('error', m, f),
};
