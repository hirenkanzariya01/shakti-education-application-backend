const logger = require('../utils/logger');

// Logs method, path (WITHOUT the query string), status and duration. Never logs headers or bodies,
// so Authorization tokens and passwords cannot end up in the logs.
module.exports = function requestLog(req, res, next) {
  if (req.path === '/api/health' || req.path === '/api/health/ready') return next();
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    logger[level]('request', {
      httpRequest: { requestMethod: req.method, requestUrl: req.originalUrl.split('?')[0], status: res.statusCode, latency: `${(ms / 1000).toFixed(3)}s` },
      userId: req.user ? String(req.user._id) : undefined,
    });
  });
  next();
};
