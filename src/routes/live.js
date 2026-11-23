const express = require('express');
const { LiveClass } = require('../models');
const { requireAuth } = require('../middleware/auth');
const { idParams } = require('../middleware/validate');
const { ok, notFound, forbidden } = require('../utils/http');
const serialize = require('../utils/serialize');
const P = require('../utils/progress');

const router = express.Router();
router.use(requireAuth);

router.get('/', async (_req, res) => {
  const classes = await LiveClass.find().populate('course', 'title').sort({ startsAt: 1 });
  ok(res, classes.map((c) => serialize.liveClass(c)));
});

router.get('/:id', idParams('id'), async (req, res) => {
  const item = await LiveClass.findById(req.params.id).populate('course', 'title');
  if (!item) throw notFound('Live class not found');
  ok(res, serialize.liveClass(item));
});

// The meeting link is only given to students enrolled in the class's course.
router.get('/:id/join', idParams('id'), async (req, res) => {
  const item = await LiveClass.findById(req.params.id);
  if (!item) throw notFound('Live class not found');
  if (req.user.role !== 'admin' && !(await P.isEnrolled(req.user._id, item.course))) {
    throw forbidden('Enroll in this course to join its live classes');
  }
  ok(res, { url: item.meetingUrl });
});

module.exports = router;
