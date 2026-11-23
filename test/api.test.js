process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/shakti_test';
process.env.RATE_LIMIT = 'off';
process.env.SELF_ENROLLMENT = 'true'; // these tests cover the self-enrollment path; the .env file may say false
process.env.BCRYPT_ROUNDS = '4';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const { connect, disconnect } = require('../src/db');
const { createApp } = require('../src/app');
const M = require('../src/models');

const app = createApp();
const api = () => request(app);
let admin, aarav, diya, ids = {};
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const login = async (email, password) => (await api().post('/api/auth/login').send({ email, password })).body.data;

before(async () => {
  await connect(process.env.MONGODB_URI);
  await Promise.all(Object.values(M).map((m) => m.deleteMany({})));
  const h = await bcrypt.hash('Passw0rd!x', 4);
  await M.User.create({ name: 'Admin', email: 'admin@t.io', phone: '9000000000', role: 'admin', passwordHash: h });
  const cat = await M.Category.create({ name: 'Design', icon: 'x' });
  const c1 = await M.Course.create({ title: 'Course One', category: cat, shortDescription: 's', description: 'd', duration: '1 Month', fee: 1000, instructor: 'I', syllabus: ['a'] });
  const c2 = await M.Course.create({ title: 'Course Two', category: cat, shortDescription: 's', description: 'd', duration: '1 Month', fee: 2000, instructor: 'I' });
  const l1 = await M.Lesson.create({ course: c1, order: 1, title: 'L1', duration: '5 min', videoUrl: 'https://v.example/1' });
  await M.Lesson.create({ course: c1, order: 2, title: 'L2', duration: '5 min', videoUrl: 'https://v.example/2' });
  await M.LiveClass.create({ course: c1, title: 'Live', instructor: 'I', startsAt: new Date(Date.now() + 86400000), durationMinutes: 60, meetingUrl: 'https://meet.example/x' });
  ids = { cat: cat.id, c1: c1.id, c2: c2.id, l1: l1.id };
  admin = (await login('admin@t.io', 'Passw0rd!x')).token;
});
after(async () => { await disconnect(); });

test('health and unknown routes', async () => {
  assert.equal((await api().get('/api/health')).status, 200);
  const r = await api().get('/api/nope');
  assert.equal(r.status, 404);
  assert.equal(r.body.success, false);
});

test('register validates, creates a student only, and rejects duplicates and role escalation', async () => {
  const bad = await api().post('/api/auth/register').send({ name: 'A', email: 'x', phone: '1', password: 'short' });
  assert.equal(bad.status, 400);
  const mass = await api().post('/api/auth/register').send({ name: 'Hacker', email: 'h@t.io', phone: '9111111111', password: 'Passw0rd!x', role: 'admin' });
  assert.equal(mass.status, 400); // strict schema rejects unknown fields
  const r = await api().post('/api/auth/register').send({ name: 'Aarav P', email: 'Aarav@T.io', phone: '9111111111', password: 'Passw0rd!x' });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.user.role, 'student');
  assert.equal(r.body.data.user.email, 'aarav@t.io');
  assert.ok(!JSON.stringify(r.body).includes('passwordHash'));
  aarav = r.body.data.token;
  assert.equal((await api().post('/api/auth/register').send({ name: 'Dup', email: 'aarav@t.io', phone: '9111111112', password: 'Passw0rd!x' })).status, 409);
  const d = await api().post('/api/auth/register').send({ name: 'Diya S', email: 'diya@t.io', phone: '9222222222', password: 'Passw0rd!x' });
  diya = d.body.data.token;
});

test('login: wrong password and unknown email give the same message', async () => {
  const a = await api().post('/api/auth/login').send({ email: 'aarav@t.io', password: 'wrong-pass1' });
  const b = await api().post('/api/auth/login').send({ email: 'nobody@t.io', password: 'wrong-pass1' });
  assert.equal(a.status, 401); assert.equal(b.status, 401);
  assert.equal(a.body.error, b.body.error);
});

test('protected routes need a valid token', async () => {
  assert.equal((await api().get('/api/auth/me')).status, 401);
  assert.equal((await api().get('/api/auth/me').set(auth('garbage'))).status, 401);
  assert.equal((await api().get('/api/auth/me').set(auth(aarav))).status, 200);
});

test('students cannot reach admin routes', async () => {
  for (const p of ['/api/admin/stats', '/api/admin/students', '/api/admin/payments']) {
    assert.equal((await api().get(p).set(auth(aarav))).status, 403, p);
    assert.equal((await api().get(p)).status, 401, p);
  }
  assert.equal((await api().post('/api/admin/courses').set(auth(aarav)).send({})).status, 403);
});

test('public catalogue: list, search, filter, details, injection-safe', async () => {
  const list = await api().get('/api/courses');
  assert.equal(list.body.data.length, 2);
  assert.equal(list.body.data[0].category, 'Design');
  assert.equal((await api().get('/api/courses?search=two')).body.data.length, 1);
  assert.equal((await api().get('/api/courses?search=desig')).body.data.length, 2); // also matches category name
  assert.equal((await api().get('/api/courses?search=.*')).body.data.length, 0); // regex is escaped
  assert.equal((await api().get('/api/courses?category=' + ids.cat)).body.data.length, 2);
  assert.equal((await api().get('/api/courses?category[$ne]=x')).body.data.length, 2); // operator syntax is ignored, not executed
  assert.equal((await api().get('/api/courses?category=zzz')).status, 400);
  assert.equal((await api().get('/api/courses/not-an-id')).status, 400);
  assert.equal((await api().get('/api/courses/' + ids.c1)).body.data.title, 'Course One');
  assert.equal((await api().get('/api/categories')).body.data[0].courseCount, 2);
});

test('video URLs are hidden until enrolled; enrollment, progress and continue-learning work', async () => {
  let lessons = (await api().get(`/api/courses/${ids.c1}/lessons`).set(auth(aarav))).body.data;
  assert.equal(lessons.length, 2);
  assert.equal(lessons[0].videoUrl, '');
  assert.equal((await api().put(`/api/lessons/${ids.l1}/completion`).set(auth(aarav)).send({ completed: true })).status, 403);

  const e = await api().post(`/api/courses/${ids.c1}/enroll`).set(auth(aarav));
  assert.equal(e.status, 201);
  assert.equal((await api().post(`/api/courses/${ids.c1}/enroll`).set(auth(aarav))).body.data.alreadyEnrolled, true);
  assert.equal((await M.Course.findById(ids.c1)).studentsEnrolled, 1); // not double counted
  assert.equal((await api().get(`/api/courses/${ids.c1}/enrolled`).set(auth(aarav))).body.data, true);
  assert.equal((await api().get(`/api/courses/${ids.c1}/enrolled`).set(auth(diya))).body.data, false);

  lessons = (await api().get(`/api/courses/${ids.c1}/lessons`).set(auth(aarav))).body.data;
  assert.ok(lessons[0].videoUrl.startsWith('https://'));

  const c = await api().put(`/api/lessons/${ids.l1}/completion`).set(auth(aarav)).send({ completed: true });
  assert.equal(c.body.data.progress.percent, 50);
  await api().put(`/api/lessons/${ids.l1}/completion`).set(auth(aarav)).send({ completed: true }); // idempotent
  assert.equal(await M.LessonProgress.countDocuments({}), 1);
  assert.equal((await api().put(`/api/lessons/${ids.l1}/completion`).set(auth(aarav)).send({ completed: 'yes' })).status, 400);

  const cont = (await api().get('/api/me/continue').set(auth(aarav))).body.data;
  assert.equal(cont.lesson.title, 'L2');
  const learn = (await api().get('/api/me/learning').set(auth(aarav))).body.data;
  assert.equal(learn.inProgress.length, 1);
  // another student's progress is separate
  assert.equal((await api().get(`/api/courses/${ids.c1}/progress`).set(auth(diya))).body.data.percent, 0);
});

test('live class join link only for enrolled students', async () => {
  const lc = (await api().get('/api/live-classes').set(auth(diya))).body.data[0];
  assert.equal(lc.meetingUrl, undefined);
  assert.equal((await api().get(`/api/live-classes/${lc.id}/join`).set(auth(diya))).status, 403);
  assert.equal((await api().get(`/api/live-classes/${lc.id}/join`).set(auth(aarav))).body.data.url, 'https://meet.example/x');
  assert.equal((await api().get('/api/live-classes')).status, 401);
});

test('admin course CRUD validates input, references and partial updates', async () => {
  const bad = await api().post('/api/admin/courses').set(auth(admin)).send({ title: 'x' });
  assert.equal(bad.status, 400);
  const ghost = await api().post('/api/admin/courses').set(auth(admin)).send({ title: 'Ghost', category: '64b7f0f0f0f0f0f0f0f0f0f0', shortDescription: 's', description: 'd', duration: '1m', fee: 5, instructor: 'i' });
  assert.equal(ghost.status, 400);
  const neg = await api().post('/api/admin/courses').set(auth(admin)).send({ title: 'N', category: ids.cat, shortDescription: 's', description: 'd', duration: '1m', fee: -5, instructor: 'i' });
  assert.equal(neg.status, 400);
  const created = await api().post('/api/admin/courses').set(auth(admin)).send({ title: 'New Course', category: ids.cat, shortDescription: 's', description: 'd', duration: '2 Months', fee: 5000, instructor: 'Teacher', syllabus: ['one'], level: 'Advanced' });
  assert.equal(created.status, 201);
  const id = created.body.data.id;
  const patched = await api().patch(`/api/admin/courses/${id}`).set(auth(admin)).send({ fee: 6000 });
  assert.equal(patched.body.data.fee, 6000);
  assert.equal(patched.body.data.level, 'Advanced'); // PATCH must not reset other fields to defaults
  assert.deepEqual(patched.body.data.syllabus, ['one']);
  assert.equal(patched.body.data.published, true);
  await api().patch(`/api/admin/courses/${id}`).set(auth(admin)).send({ published: false });
  assert.equal((await api().get('/api/courses/' + id)).status, 404); // unpublished is hidden from students
  assert.equal((await api().delete(`/api/admin/courses/${id}`).set(auth(admin))).status, 200);
});

test('admin: students, enroll, payments, certificates and the student view of them', async () => {
  const list = (await api().get('/api/admin/students').set(auth(admin))).body.data;
  const sid = list.find((s) => s.email === 'diya@t.io').id;
  assert.equal((await api().post(`/api/admin/students/${sid}/enroll`).set(auth(admin)).send({ course: ids.c2 })).status, 201);
  assert.equal((await api().post(`/api/admin/students/${sid}/enroll`).set(auth(admin)).send({ course: ids.c2 })).status, 409);

  const pay = await api().post('/api/admin/payments').set(auth(admin)).send({ student: sid, course: ids.c2, title: 'Inst 1', amount: 1000, dueDate: '2026-12-01' });
  assert.equal(pay.status, 201);
  assert.equal(pay.body.data.status, 'Pending');
  const mine = await api().get('/api/me/payments').set(auth(diya));
  assert.equal(mine.body.data.length, 1);
  assert.equal((await api().get('/api/me/payments').set(auth(aarav))).body.data.length, 0);
  assert.equal((await api().get('/api/me/payments/summary').set(auth(diya))).body.data.totalPending, 1000);
  assert.equal((await api().post(`/api/admin/payments/${pay.body.data.id}/mark-paid`).set(auth(diya)).send({})).status, 403); // students can't pay themselves

  const paid = await api().post(`/api/admin/payments/${pay.body.data.id}/mark-paid`).set(auth(admin)).send({ method: 'UPI' });
  assert.equal(paid.body.data.status, 'Paid');
  assert.ok(paid.body.data.receiptNo);
  assert.equal((await api().post(`/api/admin/payments/${pay.body.data.id}/mark-paid`).set(auth(admin)).send({})).status, 409);
  assert.equal((await api().get('/api/me/payments/summary').set(auth(diya))).body.data.totalPaid, 1000);
  // a second pending payment must be allowed (no receipt collisions)
  const p2 = await api().post('/api/admin/payments').set(auth(admin)).send({ student: sid, course: ids.c2, title: 'Inst 2', amount: 500, dueDate: '2027-01-01' });
  const p3 = await api().post('/api/admin/payments').set(auth(admin)).send({ student: sid, course: ids.c2, title: 'Inst 3', amount: 500, dueDate: '2027-02-01' });
  assert.equal(p2.status, 201); assert.equal(p3.status, 201);

  const cert = await api().post('/api/admin/certificates').set(auth(admin)).send({ student: sid, course: ids.c2, grade: 'A' });
  assert.equal(cert.status, 201);
  assert.equal(cert.body.data.isSample, false);
  assert.equal((await api().post('/api/admin/certificates').set(auth(admin)).send({ student: sid, course: ids.c2 })).status, 409);
  assert.equal((await api().get('/api/me/certificates').set(auth(diya))).body.data.length, 1);
  // IDOR: aarav cannot open diya's certificate
  assert.equal((await api().get('/api/certificates/' + cert.body.data.id).set(auth(aarav))).status, 404);
  assert.equal((await api().get('/api/certificates/' + cert.body.data.id).set(auth(diya))).status, 200);

  const detail = (await api().get(`/api/admin/students/${sid}`).set(auth(admin))).body.data;
  assert.equal(detail.enrollments.length, 1);
  assert.equal(detail.payments.length, 3);
});

test('notifications: broadcast vs targeted, read state per student', async () => {
  const sid = (await api().get('/api/admin/students').set(auth(admin))).body.data.find((s) => s.email === 'diya@t.io').id;
  await api().post('/api/admin/notifications').set(auth(admin)).send({ title: 'All', message: 'Hello everyone' });
  await api().post('/api/admin/notifications').set(auth(admin)).send({ title: 'Only Diya', message: 'Hi Diya', student: sid });
  assert.equal((await api().get('/api/notifications/unread-count').set(auth(aarav))).body.data, 1);
  assert.equal((await api().get('/api/notifications/unread-count').set(auth(diya))).body.data, 2);
  const list = (await api().get('/api/notifications').set(auth(diya))).body.data;
  await api().post(`/api/notifications/${list[0].id}/read`).set(auth(diya));
  assert.equal((await api().get('/api/notifications/unread-count').set(auth(diya))).body.data, 1);
  assert.equal((await api().get('/api/notifications/unread-count').set(auth(aarav))).body.data, 1); // unaffected
  const only = list.find((n) => n.title === 'Only Diya');
  assert.equal((await api().post(`/api/notifications/${only.id}/read`).set(auth(aarav))).status, 404);
  await api().post('/api/notifications/read-all').set(auth(diya));
  assert.equal((await api().get('/api/notifications/unread-count').set(auth(diya))).body.data, 0);
});

test('placements: interest toggles per student; admin CRUD', async () => {
  const p = await api().post('/api/admin/placements').set(auth(admin)).send({ company: 'Acme', role: 'Dev', location: 'Surat', deadline: '2027-01-01' });
  assert.equal(p.status, 201);
  const t1 = await api().post(`/api/placements/${p.body.data.id}/interest`).set(auth(aarav));
  assert.equal(t1.body.data.interested, true);
  assert.equal((await api().get('/api/placements').set(auth(aarav))).body.data[0].interested, true);
  assert.equal((await api().get('/api/placements').set(auth(diya))).body.data[0].interested, false);
  assert.equal((await api().post(`/api/placements/${p.body.data.id}/interest`).set(auth(aarav))).body.data.interested, false);
});

test('password change/reset revoke old tokens; deactivated users are locked out', async () => {
  const me = await api().post('/api/auth/register').send({ name: 'Temp User', email: 'temp@t.io', phone: '9333333333', password: 'Passw0rd!x' });
  const old = me.body.data.token;
  assert.equal((await api().post('/api/auth/change-password').set(auth(old)).send({ currentPassword: 'bad', newPassword: 'NewPassw0rd!' })).status, 400);
  const ch = await api().post('/api/auth/change-password').set(auth(old)).send({ currentPassword: 'Passw0rd!x', newPassword: 'NewPassw0rd!' });
  assert.equal(ch.status, 200);
  assert.equal((await api().get('/api/auth/me').set(auth(old))).status, 401); // old token revoked
  assert.equal((await api().get('/api/auth/me').set(auth(ch.body.data.token))).status, 200);

  const f = await api().post('/api/auth/forgot-password').send({ email: 'temp@t.io' });
  const unknown = await api().post('/api/auth/forgot-password').send({ email: 'ghost@t.io' });
  assert.equal(f.status, 200); assert.equal(f.body.message, unknown.body.message);
  assert.equal((await api().post('/api/auth/reset-password').send({ token: 'x'.repeat(64), password: 'Another1pass' })).status, 400);
  const rs = await api().post('/api/auth/reset-password').send({ token: f.body.data.devToken, password: 'Another1pass' });
  assert.equal(rs.status, 200);
  assert.equal((await api().post('/api/auth/reset-password').send({ token: f.body.data.devToken, password: 'Another1pass2' })).status, 400); // single use
  assert.ok((await login('temp@t.io', 'Another1pass')).token);

  const sid = (await M.User.findOne({ email: 'temp@t.io' })).id;
  const tmp = await api().post(`/api/admin/students/${sid}/reset-password`).set(auth(admin));
  assert.ok(tmp.body.data.temporaryPassword);
  assert.ok((await login('temp@t.io', tmp.body.data.temporaryPassword)).token);
  const tok = (await login('temp@t.io', tmp.body.data.temporaryPassword)).token;
  await api().patch(`/api/admin/students/${sid}`).set(auth(admin)).send({ isActive: false });
  assert.equal((await api().get('/api/auth/me').set(auth(tok))).status, 401);
  assert.equal((await api().post('/api/auth/login').send({ email: 'temp@t.io', password: tmp.body.data.temporaryPassword })).status, 401);
});

test('dashboard stats and body-size / malformed JSON handling', async () => {
  const s = (await api().get('/api/admin/stats').set(auth(admin))).body.data;
  assert.ok(s.students >= 3 && s.totalCollected === 1000);
  assert.equal((await api().post('/api/auth/login').set('Content-Type', 'application/json').send('{bad')).status, 400);
  assert.equal((await api().post('/api/auth/login').send({ email: 'a@b.co', password: 'x'.repeat(200000) })).status, 413);
});
