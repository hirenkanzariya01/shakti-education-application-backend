const express = require('express');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const c = require('../controllers/video.controller');
const d = require('../controllers/driveImport.controller');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { validate, idParams } = require('../middleware/validate');

// Per-user (not per-IP) limits so a classroom sharing one Wi-Fi address is not blocked together.
const perUser = (limit, windowMs = 60 * 1000) =>
  config.rateLimitEnabled
    ? rateLimit({ windowMs, limit, standardHeaders: true, legacyHeaders: false, keyGenerator: (req) => String(req.user ? req.user._id : 'anon'),
        validate: { keyGeneratorIpFallback: false },
        message: { success: false, data: null, message: '', error: 'Too many requests. Please slow down.' } })
    : (_req, _res, next) => next();

const videos = express.Router();
videos.use(requireAuth);
videos.get('/options', requireAdmin, c.options);
// Import a Drive folder tree (course folder / subject folders / videos) as modules + lectures. Admin only.
videos.get('/drive/folders', requireAdmin, perUser(30), d.folders);
videos.get('/drive/preview', requireAdmin, perUser(20), d.preview);
videos.post('/drive/import', requireAdmin, perUser(10), validate(d.importSchema), d.doImport);
videos.get('/', requireAdmin, c.listAll);
videos.get('/course/:courseId', idParams('courseId'), c.listByCourse);
videos.get('/:videoId', idParams('videoId'), c.getOne);
videos.get('/:videoId/playback', idParams('videoId'), perUser(60), c.playback);
videos.get('/:videoId/thumbnail', idParams('videoId'), c.thumbnail);
videos.post('/', requireAdmin, validate(c.createSchema), c.create);
videos.put('/:videoId', requireAdmin, idParams('videoId'), validate(c.updateSchema), c.update);
videos.delete('/:videoId', requireAdmin, idParams('videoId'), c.remove);

const progress = express.Router();
progress.use(requireAuth);
progress.post('/', perUser(240), validate(c.progressSchema), c.saveProgress);
progress.get('/:videoId', idParams('videoId'), c.getProgress);

module.exports = { videos, progress };
