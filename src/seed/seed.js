// Usage: npm run seed            (adds the admin; demo data too unless NODE_ENV=production)
//        npm run seed:reset      (wipes the database first)
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const config = require('../config');
const { connect, disconnect } = require('../db');
const M = require('../models');

const load = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, 'data', `${n}.json`), 'utf8'));
const DAY = 86400000;

async function seed() {
  const reset = process.argv.includes('--reset');
  // ---- Admin ----
  const adminEmail = (process.env.ADMIN_EMAIL || 'admin@shakti.local').toLowerCase();
  let adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) {
    if (config.isProduction) throw new Error('Set ADMIN_PASSWORD to create the first admin in production.');
    adminPassword = 'Admin@12345';
  }
  if (config.isProduction && adminPassword.length < 12) throw new Error('ADMIN_PASSWORD must be at least 12 characters in production.');
  await connect(config.mongoUri);
  if (reset) {
    if (config.isProduction) throw new Error('Refusing to reset a production database.');
    await Promise.all(Object.values(M).filter((m) => m.deleteMany).map((m) => m.deleteMany({})));
  }

  if (!(await M.User.exists({ email: adminEmail }))) {
    await M.User.create({ name: 'Institute Admin', email: adminEmail, phone: '9000000000', role: 'admin', passwordHash: await bcrypt.hash(adminPassword, config.bcryptRounds) });
    console.log(`Admin created: ${adminEmail}${process.env.ADMIN_PASSWORD ? '' : ` / ${adminPassword} (development default)`}`);
  } else console.log(`Admin already exists: ${adminEmail}`);

  // Demo data is for development. In production it is never added unless SEED_DEMO=true is set on purpose.
  const demo = process.env.SEED_DEMO ? process.env.SEED_DEMO === 'true' : !config.isProduction;
  if (!demo) { console.log('Skipping demo data.'); return; }
  if (await M.Course.exists({})) { console.log('Catalogue already present, skipping demo data.'); return; }

  // ---- Catalogue ----
  const catId = {};
  for (const [i, c] of load('categories').entries()) {
    catId[c.id] = (await M.Category.create({ name: c.name, icon: c.icon, order: i })).id;
  }
  const courseId = {};
  for (const c of load('courses')) {
    const doc = await M.Course.create({
      title: c.title, category: catId[c.categoryId], icon: c.icon, imageKey: c.id, shortDescription: c.shortDescription,
      description: c.description, duration: c.duration, level: c.level, fee: c.fee, instructor: c.instructor,
      rating: c.rating, studentsEnrolled: 0, syllabus: c.syllabus || [],
    });
    courseId[c.id] = doc.id;
  }
  const lessonId = {};
  for (const l of load('lessons')) {
    const doc = await M.Lesson.create({ course: courseId[l.courseId], order: l.order, title: l.title, duration: l.duration, description: l.description, videoUrl: l.videoUrl });
    lessonId[l.id] = doc.id;
  }
  for (const [i, b] of load('banners').entries()) await M.Banner.create({ ...b, id: undefined, imageKey: b.id, order: i });

  // Live classes keep their original spacing but are shifted so "today" lands on the first upcoming one.
  const live = load('liveClasses');
  const shift = Date.now() - new Date('2026-11-04T00:00:00+05:30').getTime();
  for (const c of live) {
    await M.LiveClass.create({ course: courseId[c.courseId], title: c.title, instructor: c.instructor, startsAt: new Date(new Date(c.startsAt).getTime() + shift), durationMinutes: c.durationMinutes, meetingUrl: c.meetingUrl, description: c.description });
  }
  for (const p of load('placements')) {
    await M.Placement.create({ ...p, id: undefined, relatedCourse: courseId[p.relatedCourseId] || null, relatedCourseId: undefined, deadline: new Date(new Date(p.deadline).getTime() + shift), isSample: true });
  }

  // ---- Demo students ----
  const hash = await bcrypt.hash('Demo@1234', config.bcryptRounds);
  const stuId = {};
  const progress = load('progress');
  for (const s of load('students')) {
    const u = await M.User.create({ name: s.name, email: s.email, phone: s.phone, city: s.city, dob: s.dob, passwordHash: hash, role: 'student',
      lastLesson: lessonId[(progress[s.id] || {}).lastLessonId] || null });
    stuId[s.id] = u.id;
    for (const cid of s.enrolledCourseIds) {
      await M.Enrollment.create({ student: u.id, course: courseId[cid], enrolledBy: 'admin' });
      await M.Course.updateOne({ _id: courseId[cid] }, { $inc: { studentsEnrolled: 1 } });
    }
    for (const [lid, at] of Object.entries((progress[s.id] || {}).completed || {})) {
      const l = load('lessons').find((x) => x.id === lid);
      await M.LessonProgress.create({ student: u.id, lesson: lessonId[lid], course: courseId[l.courseId], completedAt: new Date(at) });
    }
  }
  let n = 1;
  for (const p of load('payments')) {
    const paid = p.status === 'Paid';
    await M.Payment.create({ student: stuId[p.studentId], course: courseId[p.courseId], title: p.title, amount: p.amount, dueDate: new Date(p.date), status: p.status,
      ...(paid ? { paidAt: new Date(p.date), method: 'Recorded by institute', receiptNo: `SEED-RCPT-${String(n++).padStart(4, '0')}` } : {}) });
  }
  for (const c of load('certificates')) {
    await M.Certificate.create({ student: stuId[c.studentId], course: courseId[c.courseId], title: c.title, certificateNo: c.certificateNo, grade: c.grade, issuedOn: new Date(c.issuedOn), isSample: true });
  }
  for (const nt of load('notifications')) {
    await M.Notification.create({ title: nt.title, message: nt.message, type: nt.type, student: null });
  }
  console.log('Demo data seeded. Students: aarav@example.com, diya@example.com, kabir@example.com (password Demo@1234)');
}

seed().then(() => disconnect()).catch(async (e) => { console.error('Seed failed:', e.message); await disconnect().catch(() => {}); process.exit(1); });
