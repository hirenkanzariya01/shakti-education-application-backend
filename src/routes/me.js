// Student-owned data: payments, certificates, placements and notifications.
const express = require('express');
const { Payment, Certificate, Placement, PlacementInterest, Notification, NotificationRead } = require('../models');
const { requireAuth } = require('../middleware/auth');
const { idParams } = require('../middleware/validate');
const { ok, notFound } = require('../utils/http');
const serialize = require('../utils/serialize');

const router = express.Router();

// ---- Payments (read-only for students; staff record payments) ----
const myPayments = (studentId) =>
  Payment.find({ student: studentId }).populate('course', 'title').sort({ dueDate: -1, _id: -1 });

router.get('/me/payments', requireAuth, async (req, res) => {
  const list = await myPayments(req.user._id);
  ok(res, list.map(serialize.payment).sort((a, b) => new Date(b.date) - new Date(a.date)));
});

router.get('/me/payments/summary', requireAuth, async (req, res) => {
  const list = await Payment.find({ student: req.user._id });
  const sum = (status) => list.filter((p) => p.status === status).reduce((t, p) => t + p.amount, 0);
  ok(res, { totalPaid: sum('Paid'), totalPending: sum('Pending'), count: list.length });
});

// ---- Certificates ----
router.get('/me/certificates', requireAuth, async (req, res) => {
  const list = await Certificate.find({ student: req.user._id })
    .populate('course', 'title duration')
    .populate('student', 'name')
    .sort({ issuedOn: -1 });
  ok(res, list.map(serialize.certificate));
});

router.get('/certificates/:id', requireAuth, idParams('id'), async (req, res) => {
  const cert = await Certificate.findById(req.params.id).populate('course', 'title duration').populate('student', 'name');
  // Someone else's certificate looks exactly like a missing one.
  if (!cert || (req.user.role !== 'admin' && String(cert.student._id) !== String(req.user._id))) {
    throw notFound('Certificate not found');
  }
  ok(res, serialize.certificate(cert));
});

// ---- Placements ----
router.get('/placements', requireAuth, async (req, res) => {
  const [list, interests] = await Promise.all([
    Placement.find().sort({ deadline: 1 }),
    PlacementInterest.find({ student: req.user._id }),
  ]);
  const mine = new Set(interests.map((i) => String(i.placement)));
  ok(res, list.map((p) => serialize.placement(p, mine.has(String(p._id)))));
});

router.get('/placements/:id', requireAuth, idParams('id'), async (req, res) => {
  const p = await Placement.findById(req.params.id);
  if (!p) throw notFound('Placement not found');
  const interested = Boolean(await PlacementInterest.exists({ student: req.user._id, placement: p._id }));
  ok(res, serialize.placement(p, interested));
});

// Bookmarks an opening for the student. No application is sent to the company.
router.post('/placements/:id/interest', requireAuth, idParams('id'), async (req, res) => {
  const p = await Placement.findById(req.params.id);
  if (!p) throw notFound('Placement not found');
  const existing = await PlacementInterest.findOneAndDelete({ student: req.user._id, placement: p._id });
  if (!existing) await PlacementInterest.create({ student: req.user._id, placement: p._id });
  const interested = !existing;
  ok(
    res,
    { placementId: String(p._id), interested },
    interested ? 'Saved to your interests' : 'Removed from your interests'
  );
});

// ---- Notifications ----
const visibleTo = (studentId) => ({ $or: [{ student: null }, { student: studentId }] });

router.get('/notifications', requireAuth, async (req, res) => {
  const [list, reads] = await Promise.all([
    Notification.find(visibleTo(req.user._id)).sort({ createdAt: -1 }).limit(200),
    NotificationRead.find({ student: req.user._id }),
  ]);
  const read = new Set(reads.map((r) => String(r.notification)));
  ok(res, list.map((n) => serialize.notification(n, read.has(String(n._id)))));
});

router.get('/notifications/unread-count', requireAuth, async (req, res) => {
  const [ids, reads] = await Promise.all([
    Notification.find(visibleTo(req.user._id)).select('_id'),
    NotificationRead.find({ student: req.user._id }).select('notification'),
  ]);
  const read = new Set(reads.map((r) => String(r.notification)));
  ok(res, ids.filter((n) => !read.has(String(n._id))).length);
});

router.post('/notifications/read-all', requireAuth, async (req, res) => {
  const ids = await Notification.find(visibleTo(req.user._id)).select('_id');
  if (ids.length) {
    await NotificationRead.bulkWrite(
      ids.map((n) => ({
        updateOne: {
          filter: { student: req.user._id, notification: n._id },
          update: { $setOnInsert: { student: req.user._id, notification: n._id } },
          upsert: true,
        },
      }))
    );
  }
  ok(res, true, 'All notifications marked as read');
});

router.post('/notifications/:id/read', requireAuth, idParams('id'), async (req, res) => {
  const n = await Notification.findOne({ _id: req.params.id, ...visibleTo(req.user._id) });
  if (!n) throw notFound('Notification not found');
  await NotificationRead.updateOne(
    { student: req.user._id, notification: n._id },
    { $setOnInsert: { student: req.user._id, notification: n._id } },
    { upsert: true }
  );
  ok(res, { id: String(n._id), read: true });
});

module.exports = router;
