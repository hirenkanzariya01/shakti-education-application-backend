const express = require('express');
const mongoose = require('mongoose');
const { z } = require('zod');
const { Review, Enrollment, User } = require('../models');
const { requireAuth, requireAdmin, optionalAuth } = require('../middleware/auth');
const { validate, idParams } = require('../middleware/validate');
const { ok, notFound, forbidden, conflict, badRequest } = require('../utils/http');
const { pageQuery, pageResult } = require('../utils/paginate');
const serialize = require('../utils/serialize');

const router = express.Router();
const oid = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id');
const rating = z.number().int().min(1, 'Choose 1 to 5 stars').max(5, 'Choose 1 to 5 stars');
const text = z.string().trim().min(10, 'Write at least 10 characters').max(1000, 'Keep it under 1000 characters');
const placement = z.object({ company: z.string().trim().max(80).default(''), role: z.string().trim().max(80).default('') }).strict();
const STATUSES = ['pending', 'approved', 'rejected'];

// Students can only write about themselves and cannot attach placement claims (staff add those after verifying).
const studentCreate = z.object({ courseId: oid, rating, review: text }).strict();
const adminCreate = z.object({ studentId: oid, courseId: oid, rating, review: text, placementInfo: placement.optional(), approvalStatus: z.enum(STATUSES).default('approved') }).strict();
const studentEdit = z.object({ rating: rating.optional(), review: text.optional() }).strict();
const adminEdit = z.object({ rating: rating.optional(), review: text.optional(), placementInfo: placement.optional(), approvalStatus: z.enum(STATUSES).optional() }).strict();
const approveSchema = z.object({ approvalStatus: z.enum(STATUSES) }).strict();

const populate = (q) => q.populate('student', 'name avatarUrl').populate('course', 'title');
const isAdmin = (req) => req.user && req.user.role === 'admin';

// Public: only approved reviews. Admins may pass ?status=pending|rejected|approved|all.
router.get('/', optionalAuth, async (req, res) => {
  const q = pageQuery(10, 50).parse({ page: req.query.page, limit: req.query.limit });
  const filter = { approvalStatus: 'approved' };
  if (isAdmin(req) && req.query.status) {
    if (req.query.status === 'all') delete filter.approvalStatus;
    else if (STATUSES.includes(req.query.status)) filter.approvalStatus = req.query.status;
    else throw badRequest('Invalid status');
  }
  if (req.query.course) {
    if (!/^[a-f\d]{24}$/i.test(String(req.query.course))) throw badRequest('Invalid course');
    filter.course = req.query.course;
  }
  const approvedMatch = { approvalStatus: 'approved', ...(filter.course ? { course: filter.course } : {}) };
  const [total, rows, stats, approvedCount] = await Promise.all([
    Review.countDocuments(filter),
    populate(Review.find(filter).sort({ createdAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit)),
    Review.aggregate([{ $match: { approvalStatus: 'approved', ...(filter.course ? { course: new mongoose.Types.ObjectId(filter.course) } : {}) } }, { $group: { _id: null, total: { $sum: '$rating' } } }]),
    Review.countDocuments(approvedMatch),
  ]);
  ok(res, {
    ...pageResult(rows.map((r) => serialize.review(r, { includeStatus: isAdmin(req) })), total, q),
    summary: { count: approvedCount, average: stats[0] && approvedCount ? Math.round((stats[0].total / approvedCount) * 10) / 10 : 0 },
  });
});

// A student's own reviews, including pending/rejected ones.
router.get('/mine', requireAuth, async (req, res) => {
  const rows = await populate(Review.find({ student: req.user._id }).sort({ createdAt: -1 }).limit(100));
  ok(res, rows.map((r) => serialize.review(r, { includeStatus: true })));
});

async function assertEnrolled(studentId, courseId) {
  if (!(await Enrollment.exists({ student: studentId, course: courseId }))) {
    throw forbidden('Only students enrolled in a course can review it');
  }
}

router.post('/', requireAuth, async (req, res) => {
  const admin = isAdmin(req);
  const b = (admin ? adminCreate : studentCreate).parse(req.body);
  const studentId = admin ? b.studentId : req.user._id;
  if (admin && !(await User.exists({ _id: studentId, role: 'student' }))) throw badRequest('Student does not exist');
  await assertEnrolled(studentId, b.courseId);
  if (await Review.exists({ student: studentId, course: b.courseId })) throw conflict('A review already exists for this student and course');
  const doc = await Review.create({
    student: studentId, course: b.courseId, rating: b.rating, review: b.review,
    ...(admin ? { placementInfo: b.placementInfo, approvalStatus: b.approvalStatus, reviewedBy: req.user._id, reviewedAt: new Date() } : {}),
  });
  const full = await populate(Review.findById(doc._id));
  ok(res, serialize.review(full, { includeStatus: true }), admin ? 'Review added' : 'Thanks! Your review will appear after the institute approves it.', 201);
});

async function loadOwned(req) {
  const r = await Review.findById(req.params.reviewId);
  // Someone else's review looks the same as a missing one.
  if (!r || (!isAdmin(req) && String(r.student) !== String(req.user._id))) throw notFound('Review not found');
  return r;
}

router.put('/:reviewId', requireAuth, idParams('reviewId'), async (req, res) => {
  const r = await loadOwned(req);
  const b = (isAdmin(req) ? adminEdit : studentEdit).parse(req.body);
  ['rating', 'review'].forEach((k) => b[k] !== undefined && (r[k] = b[k]));
  if (isAdmin(req)) {
    if (b.placementInfo !== undefined) r.placementInfo = b.placementInfo;
    if (b.approvalStatus !== undefined) { r.approvalStatus = b.approvalStatus; r.reviewedBy = req.user._id; r.reviewedAt = new Date(); }
  } else {
    // An edited review must be approved again.
    r.approvalStatus = 'pending'; r.reviewedBy = null; r.reviewedAt = null;
  }
  await r.save();
  ok(res, serialize.review(await populate(Review.findById(r._id)), { includeStatus: true }), 'Review updated');
});

router.delete('/:reviewId', requireAuth, idParams('reviewId'), async (req, res) => {
  const r = await loadOwned(req);
  await r.deleteOne();
  ok(res, null, 'Review deleted');
});

router.patch('/:reviewId/approve', requireAuth, requireAdmin, idParams('reviewId'), validate(approveSchema), async (req, res) => {
  const r = await Review.findById(req.params.reviewId);
  if (!r) throw notFound('Review not found');
  r.approvalStatus = req.body.approvalStatus; r.reviewedBy = req.user._id; r.reviewedAt = new Date();
  await r.save();
  ok(res, serialize.review(await populate(Review.findById(r._id)), { includeStatus: true }), `Review ${r.approvalStatus}`);
});

module.exports = router;
