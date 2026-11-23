const config = require('./config');
const logger = require('./utils/logger');
const { connect, disconnect } = require('./db');
const { createApp } = require('./app');

// Cloud Run sends SIGTERM and then kills the container after ~10 s, so finish well before that.
const SHUTDOWN_GRACE_MS = 8000;

(async () => {
  await connect(config.mongoUri);
  const server = createApp().listen(config.port, '0.0.0.0', () => logger.info(`Shakti API listening on :${config.port}`, { env: config.env }));
  // Slightly longer than typical load-balancer idle timeouts so keep-alive connections are not dropped mid-request.
  server.keepAliveTimeout = 65 * 1000;
  server.headersTimeout = 66 * 1000;

  let stopping = false;
  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    logger.info('Shutting down', { signal });
    const force = setTimeout(() => { logger.error('Forced exit after grace period'); process.exit(1); }, SHUTDOWN_GRACE_MS);
    force.unref();
    // Stop taking new connections, let in-flight requests finish, then close the database.
    server.close(async () => {
      try { await disconnect(); } catch (e) { logger.error('Error closing database', { error: e.message }); }
      process.exit(0);
    });
    if (server.closeIdleConnections) server.closeIdleConnections();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => logger.error('Unhandled promise rejection', { error: String(reason && reason.message ? reason.message : reason) }));
})().catch((e) => { logger.error('Failed to start', { error: e.message }); console.error('Failed to start:', e.message); process.exit(1); });
