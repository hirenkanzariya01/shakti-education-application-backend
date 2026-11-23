const express = require('express');
const { Course, Category, Banner } = require('../models');
const { ok, notFound, escapeRegex, isId, badRequest } = require('../utils/http');
const { idParams } = require('../middleware/validate');
const serialize = require('../utils/serialize');

const router = express.Router();

// Public: the course catalogue is visible before signing in.
router.get('/courses', async (req, res) => {
  const filter = { published: true };
  const category = String(req.query.category || 'all');
  if (category !== 'all') {
    if (!isId(category)) throw badRequest('Invalid category');
    filter.category = category;
  }
  const search = String(req.query.search || '').trim().slice(0, 80);
  if (search) {
    const rx = new RegExp(escapeRegex(search), 'i');
    const cats = await Category.find({ name: rx }).select('_id');
    filter.$or = [{ title: rx }, { shortDescription: rx }, { instructor: rx }, { category: { $in: cats.map((c) => c._id) } }];
  }
  const courses = await Course.find(filter).populate('category', 'name').sort({ createdAt: 1, _id: 1 });
  ok(res, courses.map(serialize.course));
});

router.get('/courses/:id', idParams('id'), async (req, res) => {
  const course = await Course.findOne({ _id: req.params.id, published: true }).populate('category', 'name');
  if (!course) throw notFound('Course not found');
  ok(res, serialize.course(course));
});

router.get('/categories', async (_req, res) => {
  const [categories, counts] = await Promise.all([
    Category.find().sort({ order: 1, name: 1 }),
    Course.aggregate([{ $match: { published: true } }, { $group: { _id: '$category', n: { $sum: 1 } } }]),
  ]);
  const byId = new Map(counts.map((c) => [String(c._id), c.n]));
  ok(res, categories.map((c) => serialize.category(c, byId.get(String(c._id)) || 0)));
});

router.get('/banners', async (_req, res) => {
  const banners = await Banner.find({ active: true }).sort({ order: 1, createdAt: 1 });
  ok(res, banners.map(serialize.banner));
});

module.exports = router;
