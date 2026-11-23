const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const config = require('../config');
const M = require('../models');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { validate, idParams } = require('../middleware/validate');
const { ok, notFound, conflict, badRequest, escapeRegex } = require('../utils/http');
const serialize = require('../utils/serialize');

const router = express.Router();
router.use(requireAuth, requireAdmin);

const oid = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id');
const date = z.coerce.date();
const url = z.string().trim().url().max(500).refine((u) => /^https?:\/\//i.test(u), 'Must be an http(s) link');
const optUrl = z.union([url, z.literal('')]).optional();
const str = (max, min = 1) => z.string().trim().min(min).max(max);
// PATCH schemas: every field optional and WITHOUT defaults (zod 4 would otherwise re-apply defaults and reset stored values).
const partial = (schema) =>
  z.object(
    Object.fromEntries(
      Object.entries(schema.shape).map(([k, v]) => [k, (v.def && v.def.type === 'default' ? v.def.innerType : v).optional()])
    )
  ).strict();

// ---------- Dashboard ----------
router.get('/stats', async (_req, res) => {
  const now = new Date();
  const [students, courses, enrollments, upcoming, paid, pending, certs, placements] = await Promise.all([
    M.User.countDocuments({ role: 'student' }),
    M.Course.countDocuments(),
    M.Enrollment.countDocuments(),
    M.LiveClass.countDocuments({ startsAt: { $gte: now } }),
    M.Payment.find({ status: 'Paid' }).select('amount'),
    M.Payment.find({ status: 'Pending' }).select('amount'),
    M.Certificate.countDocuments(),
    M.Placement.countDocuments(),
  ]);
  const sum = (l) => l.reduce((t, p) => t + p.amount, 0);
  const recent = await M.User.find({ role: 'student' }).sort({ createdAt: -1 }).limit(5);
  ok(res, {
    students, courses, enrollments, upcomingLiveClasses: upcoming, certificates: certs, placements,
    totalCollected: sum(paid), totalPending: sum(pending), pendingCount: pending.length,
    recentStudents: recent.map(serialize.user),
  });
});

const mustExist = async (Model, id, label) => {
  if (!(await Model.exists({ _id: id }))) throw badRequest(`${label} does not exist`);
};

// ---------- Generic CRUD builder ----------
function crud(path, Model, { create, update, populate, list, out, sort = { createdAt: -1 }, onDelete, searchFields = [], refs = {} }) {
  // refs: { field: [RefModel, 'Label'] } - referenced documents must exist.
  const checkRefs = async (body) => {
    for (const [field, [Ref, label]] of Object.entries(refs)) {
      if (body[field]) await mustExist(Ref, body[field], label);
    }
  };
  const q = (query) => (populate ? query.populate(populate) : query);
  router.get(`/${path}`, async (req, res) => {
    const filter = list ? await list(req) : {};
    const s = String(req.query.search || '').trim().slice(0, 80);
    if (s && searchFields.length) filter.$or = searchFields.map((f) => ({ [f]: new RegExp(escapeRegex(s), 'i') }));
    const items = await q(Model.find(filter).sort(sort).limit(1000));
    ok(res, items.map((i) => out(i)));
  });
  router.get(`/${path}/:id`, idParams('id'), async (req, res) => {
    const item = await q(Model.findById(req.params.id));
    if (!item) throw notFound('Not found');
    ok(res, out(item));
  });
  router.post(`/${path}`, validate(create), async (req, res) => {
    await checkRefs(req.body);
    const doc = await Model.create(req.body);
    ok(res, out(await q(Model.findById(doc._id))), 'Created', 201);
  });
  router.patch(`/${path}/:id`, idParams('id'), validate(update), async (req, res) => {
    const item = await Model.findById(req.params.id);
    if (!item) throw notFound('Not found');
    await checkRefs(req.body);
    item.set(req.body);
    await item.save();
    ok(res, out(await q(Model.findById(item._id))), 'Updated');
  });
  router.delete(`/${path}/:id`, idParams('id'), async (req, res) => {
    const item = await Model.findById(req.params.id);
    if (!item) throw notFound('Not found');
    if (onDelete) await onDelete(item);
    await item.deleteOne();
    ok(res, null, 'Deleted');
  });
}

// ---------- Categories ----------
const categoryShape = z.object({ name: str(60), icon: str(60).default('book-outline'), order: z.number().int().min(0).max(999).default(0) }).strict();
crud('categories', M.Category, {
  create: categoryShape, update: partial(categoryShape), sort: { order: 1, name: 1 }, out: (c) => serialize.category(c),
  onDelete: async (c) => {
    if (await M.Course.exists({ category: c._id })) throw conflict('Move or delete the courses in this category first');
  },
});

// ---------- Courses ----------
const courseShape = z.object({
  title: str(120), category: oid, icon: str(60).default('book-outline'), imageKey: z.string().trim().max(60).optional(),
  imageUrl: optUrl, shortDescription: str(200), description: str(4000), duration: str(40),
  level: z.enum(['Beginner', 'Intermediate', 'Advanced']).default('Beginner'), fee: z.number().min(0).max(10000000),
  instructor: str(80), rating: z.number().min(0).max(5).default(0), syllabus: z.array(str(120)).max(30).default([]),
  published: z.boolean().default(true),
}).strict();
const courseOut = (c) => serialize.course(c);
crud('courses', M.Course, {
  create: courseShape, update: partial(courseShape), populate: { path: 'category', select: 'name' }, out: courseOut,
  sort: { createdAt: 1 }, searchFields: ['title', 'instructor'], refs: { category: [M.Category, 'Category'] },
  onDelete: async (c) => {
    await Promise.all([
      M.Lesson.deleteMany({ course: c._id }), M.LessonProgress.deleteMany({ course: c._id }),
      M.Enrollment.deleteMany({ course: c._id }), M.LiveClass.deleteMany({ course: c._id }),
    ]);
  },
});
// ---------- Lessons ----------
const lessonShape = z.object({
  course: oid, order: z.number().int().min(1).max(999), title: str(140), duration: str(20).default('10 min'),
  description: z.string().trim().max(1000).default(''), videoUrl: optUrl, published: z.boolean().default(true),
}).strict();
crud('lessons', M.Lesson, {
  create: lessonShape, update: partial(lessonShape), refs: { course: [M.Course, 'Course'] }, sort: { course: 1, order: 1 }, searchFields: ['title'],
  list: async (req) => (req.query.course && /^[a-f\d]{24}$/i.test(req.query.course) ? { course: req.query.course } : {}),
  out: (l) => serialize.lesson(l, { showVideo: true, admin: true }),
  onDelete: (l) => M.LessonProgress.deleteMany({ lesson: l._id }),
});

// ---------- Live classes ----------
const liveShape = z.object({
  course: oid, title: str(140), instructor: str(80), startsAt: date, durationMinutes: z.number().int().min(5).max(600),
  meetingUrl: url, description: z.string().trim().max(1000).default(''),
}).strict();
crud('live-classes', M.LiveClass, {
  create: liveShape, update: partial(liveShape), refs: { course: [M.Course, 'Course'] }, populate: { path: 'course', select: 'title' }, sort: { startsAt: -1 },
  out: (c) => serialize.liveClass(c, { includeUrl: true }),
});

// ---------- Placements ----------
const placementShape = z.object({
  company: str(120), role: str(120), location: str(80), type: z.enum(['Full-time', 'Part-time', 'Internship', 'Contract']).default('Full-time'),
  salaryRange: z.string().trim().max(60).default(''), openings: z.number().int().min(1).max(1000).default(1), deadline: date,
  relatedCourse: oid.nullable().optional(), description: z.string().trim().max(2000).default(''),
  requirements: z.array(str(120)).max(20).default([]), isSample: z.boolean().default(false),
}).strict();
crud('placements', M.Placement, {
  create: placementShape, update: partial(placementShape), refs: { relatedCourse: [M.Course, 'Course'] }, sort: { deadline: 1 }, searchFields: ['company', 'role'],
  out: (p) => serialize.placement(p, false),
  onDelete: (p) => M.PlacementInterest.deleteMany({ placement: p._id }),
});

// ---------- Banners ----------
const bannerShape = z.object({
  title: str(80), subtitle: z.string().trim().max(140).default(''), cta: str(30).default('Learn more'),
  target: z.enum(['Courses', 'LiveClasses', 'Placement', 'MyLearning']).default('Courses'), icon: str(60).default('rocket-outline'),
  imageKey: z.string().trim().max(60).optional(), imageUrl: optUrl, order: z.number().int().min(0).max(999).default(0), active: z.boolean().default(true),
}).strict();
crud('banners', M.Banner, { create: bannerShape, update: partial(bannerShape), sort: { order: 1 }, out: serialize.banner });

// ---------- Notifications (announcements) ----------
const notifShape = z.object({
  title: str(120), message: str(500), type: z.enum(['general', 'course', 'live-class', 'payment', 'placement']).default('general'),
  student: oid.nullable().optional(),
}).strict();
crud('notifications', M.Notification, {
  create: notifShape, update: partial(notifShape), refs: { student: [M.User, 'Student'] }, out: (n) => ({ ...serialize.notification(n, false), student: n.student ? String(n.student) : null }),
  onDelete: (n) => M.NotificationRead.deleteMany({ notification: n._id }),
});

// ---------- Modules (sections of a course) ----------
const moduleShape = z.object({ course: oid, title: str(120), description: z.string().trim().max(500).default(''), order: z.number().int().min(1).max(999).default(1), published: z.boolean().default(true) }).strict();
crud('modules', M.Module, {
  create: moduleShape, update: partial(moduleShape), refs: { course: [M.Course, 'Course'] }, sort: { course: 1, order: 1 },
  list: async (req) => (req.query.course && /^[a-f\d]{24}$/i.test(req.query.course) ? { course: req.query.course } : {}),
  out: (m) => ({ id: String(m._id), courseId: String(m.course), title: m.title, description: m.description, order: m.order, published: m.published }),
  onDelete: (m) => M.Lesson.updateMany({ module: m._id }, { module: null }), // lectures stay, just ungrouped
});

// ---------- Students ----------
const studentOut = async (u) => {
  const [ids, paid, pending] = await Promise.all([
    M.Enrollment.find({ student: u._id }).select('course'),
    M.Payment.find({ student: u._id, status: 'Paid' }).select('amount'),
    M.Payment.find({ student: u._id, status: 'Pending' }).select('amount'),
  ]);
  const sum = (l) => l.reduce((t, p) => t + p.amount, 0);
  return { ...serialize.user(u), isActive: u.isActive, enrolledCount: ids.length, totalPaid: sum(paid), totalPending: sum(pending), createdAt: u.createdAt };
};

router.get('/students', async (req, res) => {
  const filter = { role: 'student' };
  const s = String(req.query.search || '').trim().slice(0, 80);
  if (s) { const rx = new RegExp(escapeRegex(s), 'i'); filter.$or = [{ name: rx }, { email: rx }, { phone: rx }]; }
  const users = await M.User.find(filter).sort({ createdAt: -1 }).limit(1000);
  ok(res, await Promise.all(users.map(studentOut)));
});

const newStudent = z.object({ name: str(80, 2), email: z.string().trim().toLowerCase().email().max(120), phone: z.string().trim().regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit mobile number'), password: z.string().min(8).max(72), city: z.string().trim().max(80).optional(), courses: z.array(oid).max(100).optional() }).strict();
router.post('/students', validate(newStudent), async (req, res) => {
  if (await M.User.exists({ email: req.body.email })) throw conflict('An account with this email already exists');
  const { password, courses = [], ...rest } = req.body;
  const courseIds = [...new Set(courses)];
  if (courseIds.length && (await M.Course.countDocuments({ _id: { $in: courseIds } })) !== courseIds.length) throw badRequest('One of the selected courses does not exist');
  const u = await M.User.create({ ...rest, passwordHash: await bcrypt.hash(password, config.bcryptRounds), role: 'student' });
  if (courseIds.length) await setStudentCourses(u._id, courseIds);
  ok(res, await studentOut(u), courseIds.length ? `Student created and enrolled in ${courseIds.length} course${courseIds.length === 1 ? '' : 's'}` : 'Student created (no courses yet)', 201);
});

const studentLoad = async (id) => {
  const u = await M.User.findOne({ _id: id, role: 'student' });
  if (!u) throw notFound('Student not found');
  return u;
};

router.get('/students/:id', idParams('id'), async (req, res) => {
  const u = await studentLoad(req.params.id);
  const [enr, payments, certs] = await Promise.all([
    M.Enrollment.find({ student: u._id }).populate({ path: 'course', populate: { path: 'category', select: 'name' } }),
    M.Payment.find({ student: u._id }).populate('course', 'title').sort({ dueDate: -1 }),
    M.Certificate.find({ student: u._id }).populate('course', 'title duration').populate('student', 'name'),
  ]);
  const courseIds = enr.filter((e) => e.course).map((e) => e.course._id);
  const P = require('../utils/progress');
  const [lessons, done] = await Promise.all([P.lessonsByCourse(courseIds), P.completedMap(u._id, courseIds)]);
  ok(res, {
    ...(await studentOut(u)),
    enrollments: enr.filter((e) => e.course).map((e) => ({ course: serialize.course(e.course), enrolledBy: e.enrolledBy, progress: P.computeProgress(e.course._id, lessons.get(String(e.course._id)), done) })),
    payments: payments.map(serialize.payment),
    certificates: certs.map(serialize.certificate),
  });
});

const studentPatch = z.object({ name: str(80, 2).optional(), phone: z.string().trim().regex(/^[6-9]\d{9}$/).optional(), city: z.string().trim().max(80).optional(), isActive: z.boolean().optional() }).strict();
router.patch('/students/:id', idParams('id'), validate(studentPatch), async (req, res) => {
  const u = await studentLoad(req.params.id);
  u.set(req.body);
  if (req.body.isActive === false) u.tokenVersion += 1; // sign out immediately
  await u.save();
  ok(res, await studentOut(u), 'Student updated');
});

// Sets a temporary password the student is told in person. Returned once.
router.post('/students/:id/reset-password', idParams('id'), async (req, res) => {
  const u = await studentLoad(req.params.id);
  const temp = crypto.randomBytes(6).toString('base64url') + '#9';
  u.passwordHash = await bcrypt.hash(temp, config.bcryptRounds);
  u.tokenVersion += 1;
  await u.save();
  ok(res, { temporaryPassword: temp }, 'Temporary password set. Share it with the student securely.');
});

router.delete('/students/:id', idParams('id'), async (req, res) => {
  const u = await studentLoad(req.params.id);
  const id = u._id;
  await Promise.all([M.Enrollment.deleteMany({ student: id }), M.LessonProgress.deleteMany({ student: id }), M.Payment.deleteMany({ student: id }),
    M.Certificate.deleteMany({ student: id }), M.PlacementInterest.deleteMany({ student: id }), M.NotificationRead.deleteMany({ student: id }),
    M.Notification.deleteMany({ student: id })]);
  await u.deleteOne();
  ok(res, null, 'Student deleted');
});

// Makes the student's enrollments EXACTLY this list: adds the missing courses and removes the others
// (removing also deletes that student's lesson progress in the removed course).
async function setStudentCourses(studentId, courseIds) {
  const want = new Set(courseIds.map(String));
  const have = await M.Enrollment.find({ student: studentId });
  const haveIds = new Set(have.map((e) => String(e.course)));
  const add = [...want].filter((c) => !haveIds.has(c));
  const remove = [...haveIds].filter((c) => !want.has(c));
  for (const c of add) {
    await M.Enrollment.create({ student: studentId, course: c, enrolledBy: 'admin' });
    await M.Course.updateOne({ _id: c }, { $inc: { studentsEnrolled: 1 } });
  }
  for (const c of remove) {
    await M.Enrollment.deleteOne({ student: studentId, course: c });
    await M.LessonProgress.deleteMany({ student: studentId, course: c });
    await M.Course.updateOne({ _id: c, studentsEnrolled: { $gt: 0 } }, { $inc: { studentsEnrolled: -1 } });
  }
  return { added: add.length, removed: remove.length };
}

router.put('/students/:id/courses', idParams('id'), validate(z.object({ courses: z.array(oid).max(100) }).strict()), async (req, res) => {
  const u = await studentLoad(req.params.id);
  const ids = [...new Set(req.body.courses)];
  if (ids.length && (await M.Course.countDocuments({ _id: { $in: ids } })) !== ids.length) throw badRequest('One of the selected courses does not exist');
  const r = await setStudentCourses(u._id, ids);
  ok(res, r, `Course access updated (${r.added} added, ${r.removed} removed)`);
});

router.post('/students/:id/enroll', idParams('id'), validate(z.object({ course: oid }).strict()), async (req, res) => {
  const u = await studentLoad(req.params.id);
  await mustExist(M.Course, req.body.course, 'Course');
  if (await M.Enrollment.exists({ student: u._id, course: req.body.course })) throw conflict('Already enrolled');
  await M.Enrollment.create({ student: u._id, course: req.body.course, enrolledBy: 'admin' });
  await M.Course.updateOne({ _id: req.body.course }, { $inc: { studentsEnrolled: 1 } });
  ok(res, null, 'Student enrolled', 201);
});

router.delete('/students/:id/enrollments/:courseId', idParams('id', 'courseId'), async (req, res) => {
  const r = await M.Enrollment.findOneAndDelete({ student: req.params.id, course: req.params.courseId });
  if (!r) throw notFound('Enrollment not found');
  await M.LessonProgress.deleteMany({ student: req.params.id, course: req.params.courseId });
  await M.Course.updateOne({ _id: req.params.courseId, studentsEnrolled: { $gt: 0 } }, { $inc: { studentsEnrolled: -1 } });
  ok(res, null, 'Enrollment removed');
});

// ---------- Payments ----------
const payOut = (p) => ({ ...serialize.payment(p), student: p.student && p.student.name ? { id: String(p.student._id), name: p.student.name, email: p.student.email } : String(p.student), dueDate: p.dueDate });
const nextReceipt = () => `RCPT-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;

router.get('/payments', async (req, res) => {
  const filter = {};
  if (['Paid', 'Pending'].includes(req.query.status)) filter.status = req.query.status;
  if (req.query.student && /^[a-f\d]{24}$/i.test(req.query.student)) filter.student = req.query.student;
  const list = await M.Payment.find(filter).populate('course', 'title').populate('student', 'name email').sort({ dueDate: -1 }).limit(1000);
  ok(res, list.map(payOut));
});

const payCreate = z.object({ student: oid, course: oid, title: str(140), amount: z.number().min(1).max(10000000), dueDate: date, status: z.enum(['Pending', 'Paid']).default('Pending'), method: z.string().trim().max(40).optional() }).strict();
router.post('/payments', validate(payCreate), async (req, res) => {
  await studentLoad(req.body.student);
  await mustExist(M.Course, req.body.course, 'Course');
  const data = { ...req.body, recordedBy: req.user._id };
  if (data.status === 'Paid') { data.paidAt = new Date(); data.receiptNo = nextReceipt(); data.method = data.method || 'Recorded by institute'; }
  const p = await M.Payment.create(data);
  ok(res, payOut(await M.Payment.findById(p._id).populate('course', 'title').populate('student', 'name email')), 'Payment added', 201);
});

const payPatch = z.object({ title: str(140).optional(), amount: z.number().min(1).max(10000000).optional(), dueDate: date.optional() }).strict();
router.patch('/payments/:id', idParams('id'), validate(payPatch), async (req, res) => {
  const p = await M.Payment.findById(req.params.id);
  if (!p) throw notFound('Payment not found');
  if (p.status === 'Paid' && req.body.amount !== undefined) throw badRequest('A recorded payment amount cannot be changed. Delete and re-add it instead.');
  p.set(req.body);
  await p.save();
  ok(res, payOut(await M.Payment.findById(p._id).populate('course', 'title').populate('student', 'name email')), 'Payment updated');
});

router.post('/payments/:id/mark-paid', idParams('id'), validate(z.object({ method: str(40).default('Cash') }).strict()), async (req, res) => {
  const p = await M.Payment.findById(req.params.id);
  if (!p) throw notFound('Payment not found');
  if (p.status === 'Paid') throw conflict('This payment is already recorded as paid');
  p.set({ status: 'Paid', paidAt: new Date(), method: req.body.method, receiptNo: nextReceipt(), recordedBy: req.user._id });
  await p.save();
  ok(res, payOut(await M.Payment.findById(p._id).populate('course', 'title').populate('student', 'name email')), 'Payment recorded');
});

router.delete('/payments/:id', idParams('id'), async (req, res) => {
  const p = await M.Payment.findByIdAndDelete(req.params.id);
  if (!p) throw notFound('Payment not found');
  ok(res, null, 'Payment deleted');
});

// ---------- Certificates ----------
router.get('/certificates', async (_req, res) => {
  const list = await M.Certificate.find().populate('course', 'title duration').populate('student', 'name email').sort({ issuedOn: -1 }).limit(1000);
  ok(res, list.map((c) => ({ ...serialize.certificate(c), studentId: String(c.student._id), studentEmail: c.student.email })));
});
const certShape = z.object({ student: oid, course: oid, grade: z.string().trim().max(10).default(''), issuedOn: date.optional(), isSample: z.boolean().default(false) }).strict();
router.post('/certificates', validate(certShape), async (req, res) => {
  const u = await studentLoad(req.body.student);
  const course = await M.Course.findById(req.body.course);
  if (!course) throw badRequest('Course does not exist');
  if (await M.Certificate.exists({ student: u._id, course: course._id })) throw conflict('A certificate already exists for this student and course');
  const no = `${req.body.isSample ? 'SAMPLE' : 'CERT'}-${new Date().getFullYear()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  const c = await M.Certificate.create({ student: u._id, course: course._id, title: `${course.title} - Certificate of Completion`, certificateNo: no, grade: req.body.grade, issuedOn: req.body.issuedOn || new Date(), isSample: req.body.isSample, issuedBy: req.user._id });
  ok(res, serialize.certificate(await M.Certificate.findById(c._id).populate('course', 'title duration').populate('student', 'name')), 'Certificate issued', 201);
});
router.delete('/certificates/:id', idParams('id'), async (req, res) => {
  const c = await M.Certificate.findByIdAndDelete(req.params.id);
  if (!c) throw notFound('Certificate not found');
  ok(res, null, 'Certificate revoked');
});

module.exports = router;
