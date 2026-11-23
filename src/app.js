const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const config = require('./config');
const mongoose = require('mongoose');
const { notFoundHandler, errorHandler } = require('./middleware/error');
const requestLog = require('./middleware/requestLog');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(requestLog);
  app.use(helmet());
  app.use(compression()); // JSON compresses ~5-10x; large on slow mobile networks
  app.use(
    cors({
      origin(origin, cb) {
        // Mobile apps and curl send no Origin header; browsers must be on the allowlist.
        if (!origin || config.corsOrigins.includes(origin)) return cb(null, true);
        cb(null, false);
      },
    })
  );
  app.use(express.json({ limit: '100kb' }));

  const limiter = (windowMs, max) =>
    config.rateLimitEnabled
      ? rateLimit({ windowMs, limit: max, standardHeaders: true, legacyHeaders: false,
          message: { success: false, data: null, message: '', error: 'Too many requests. Please try again later.' } })
      : (_req, _res, next) => next();

  app.get('/api/health', (_req, res) => res.json({ success: true, data: { status: 'ok' }, message: '', error: null }));

  // Readiness: only "ready" when the database connection is up (liveness above stays cheap and DB-free).
  app.get('/api/health/ready', async (_req, res) => {
    try {
      if (mongoose.connection.readyState !== 1) throw new Error('db not connected');
      await mongoose.connection.db.admin().ping();
      res.json({ success: true, data: { status: 'ready' }, message: '', error: null });
    } catch {
      res.status(503).json({ success: false, data: null, message: '', error: 'Database not ready' });
    }
  });

  app.use('/api', limiter(60 * 1000, 300));
  app.use('/api/auth/login', limiter(15 * 60 * 1000, 20));
  app.use('/api/auth/register', limiter(60 * 60 * 1000, 20));
  app.use('/api/auth/forgot-password', limiter(60 * 60 * 1000, 10));
  app.use('/api/auth/reset-password', limiter(60 * 60 * 1000, 20));

  app.use('/api/auth', require('./routes/auth'));
  const media = require('./routes/media');
  app.use('/api/admin/media', media.admin); // before /api/admin so the raw-body parser handles it
  app.use('/api/media', media.pub);
  const video = require('./routes/video.routes');
  app.use('/api/videos', video.videos);
  app.use('/api/video-progress', video.progress);
  app.use('/api/reviews', require('./routes/reviews'));
  app.use('/api/placed-students', require('./routes/placedStudents'));
  app.use('/api/quizzes', require('./routes/quizzes'));
  app.use('/api/admin', require('./routes/admin'));
  app.use('/api/live-classes', require('./routes/live'));
  app.use('/api', require('./routes/catalog'));
  app.use('/api', require('./routes/learning'));
  app.use('/api', require('./routes/me'));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
