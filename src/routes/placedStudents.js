const express = require('express');
const { z } = require('zod');
const { PlacedStudent, User } = require('../models');
const { requireAuth, requireAdmin, optionalAuth } = require('../middleware/auth');
const { validate, idParams } = require('../middleware/validate');
const { ok, notFound, badRequest } = require('../utils/http');
const { pageQuery, pageResult } = require('../utils/paginate');
const serialize = require('../utils/serialize');

const router = express.Router();
const oid = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id');
const img = z.union([z.literal(''), z.string().regex(serialize.MEDIA_OR_HTTPS, 'Use an https:// link or an uploaded image')]);
const str = (max) => z.string().trim().min(1).max(max);
const year = z.number().int().min(2000).max(new Date().getFullYear() + 1);

const base = {
  studentName: str(80), profileImage: img, companyName: str(80), companyLogo: img, designation: str(80), courseName: str(120),
  placementYear: year, studentId: oid.nullable(),
  verificationStatus: z.enum(['pending', 'verified', 'rejected']), isPublished: z.boolean(),
};
const createSchema = z.object({ ...base, profileImage: img.default(''), companyLogo: img.default(''), studentId: base.studentId.optional(),
  verificationStatus: base.verificationStatus.default('pending'), isPublished: z.boolean().default(false) }).strict();
const updateSchema = z.object(Object.fromEntries(Object.entries(base).map(([k, v]) => [k, v.optional()]))).strict();

const PUBLIC = { isPublished: true, verificationStatus: 'verified' };
const isAdmin = (req) => req.user && req.user.role === 'admin';

// Public: only verified AND published records. Admins can pass ?all=1 to see everything.
router.get('/', optionalAuth, async (req, res) => {
  const q = pageQuery(10, 50).parse({ page: req.query.page, limit: req.query.limit });
  const all = isAdmin(req) && req.query.all === '1';
  const filter = all ? {} : PUBLIC;
  const [total, rows] = await Promise.all([
    PlacedStudent.countDocuments(filter),
    PlacedStudent.find(filter).sort({ placementYear: -1, createdAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit),
  ]);
  ok(res, pageResult(rows.map((p) => serialize.placedStudent(p, { admin: all })), total, q));
});

// "Only verified placement records can be published."
function checkRules(state) {
  if (state.isPublished && state.verificationStatus !== 'verified') throw badRequest('Only verified records can be published. Verify the placement first.');
}

router.post('/', requireAuth, requireAdmin, validate(createSchema), async (req, res) => {
  const { studentId, ...b } = req.body;
  checkRules(b);
  if (studentId && !(await User.exists({ _id: studentId, role: 'student' }))) throw badRequest('Student does not exist');
  const doc = await PlacedStudent.create({ ...b, student: studentId || null, verifiedBy: b.verificationStatus === 'verified' ? req.user._id : null });
  ok(res, serialize.placedStudent(doc, { admin: true }), 'Placement record added', 201);
});

router.put('/:placementId', requireAuth, requireAdmin, idParams('placementId'), validate(updateSchema), async (req, res) => {
  const p = await PlacedStudent.findById(req.params.placementId);
  if (!p) throw notFound('Placement record not found');
  const { studentId, ...b } = req.body;
  if (studentId !== undefined) {
    if (studentId && !(await User.exists({ _id: studentId, role: 'student' }))) throw badRequest('Student does not exist');
    p.student = studentId || null;
  }
  // Moving away from "verified" automatically unpublishes.
  if (b.verificationStatus && b.verificationStatus !== 'verified' && b.isPublished === undefined) b.isPublished = false;
  checkRules({ isPublished: b.isPublished ?? p.isPublished, verificationStatus: b.verificationStatus ?? p.verificationStatus });
  if (b.verificationStatus === 'verified' && p.verificationStatus !== 'verified') p.verifiedBy = req.user._id;
  p.set(b);
  await p.save();
  ok(res, serialize.placedStudent(p, { admin: true }), 'Placement record updated');
});

router.delete('/:placementId', requireAuth, requireAdmin, idParams('placementId'), async (req, res) => {
  const p = await PlacedStudent.findByIdAndDelete(req.params.placementId);
  if (!p) throw notFound('Placement record not found');
  ok(res, null, 'Placement record deleted');
});

module.exports = router;
