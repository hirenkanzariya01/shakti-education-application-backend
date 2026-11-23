process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/shakti_test';
process.env.RATE_LIMIT = 'off';
process.env.BCRYPT_ROUNDS = '4';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const config = require('../src/config');
const drive = require('../src/services/googleDrive.service');
const { connect, disconnect } = require('../src/db');
const { createApp } = require('../src/app');
const M = require('../src/models');

const app = createApp();
const api = () => request(app);
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const F1 = 'driveFile000000001', F2 = 'driveFile000000002', FDOC = 'driveFile0000000DOC', FMKV = 'driveFile0000000MKV';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
let admin, ann, bob, c1, c2, cat, driveCalls;

before(async () => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  config.google.serviceAccountEmail = 'sa@x.iam.gserviceaccount.com'; config.google.privateKey = privateKey; config.google.rootFolderId = '';
  const files = {
    [F1]: { id: F1, name: 'Lecture 1.mp4', mimeType: 'video/mp4', size: '5000', thumbnailLink: 'https://lh3.example/t=s220', videoMediaMetadata: { durationMillis: '100000' } },
    [F2]: { id: F2, name: 'Lecture 2.mp4', mimeType: 'video/mp4', size: '5000', videoMediaMetadata: { durationMillis: '60000' } },
    [FDOC]: { id: FDOC, name: 'notes.pdf', mimeType: 'application/pdf' },
    [FMKV]: { id: FMKV, name: 'x.mkv', mimeType: 'video/x-matroska', videoMediaMetadata: { durationMillis: '9000' } },
  };
  driveCalls = [];
  drive._reset();
  drive._setFetch(async (url) => {
    const u = String(url); driveCalls.push(u);
    const r = (s, b) => ({ ok: s < 400, status: s, json: async () => b, headers: new Map([['content-type', 'image/jpeg']]), arrayBuffer: async () => Buffer.from('thumb') });
    if (u.includes('oauth2')) return r(200, { access_token: 'ACCESS-TOKEN-1', expires_in: 3599 });
    if (u.startsWith('https://lh3.example')) return r(200, {});
    const m = u.match(/\/files\/([^?]+)\?(.*)/);
    return m && files[m[1]] ? r(200, files[m[1]]) : r(404, {});
  });

  await connect(process.env.MONGODB_URI);
  await Promise.all(Object.values(M).map((m) => m.deleteMany({})));
  const h = await bcrypt.hash('Passw0rd!x', 4);
  await M.User.create({ name: 'Admin', email: 'admin@t.io', phone: '9000000000', role: 'admin', passwordHash: h });
  const A = await M.User.create({ name: 'Ann Enrolled', email: 'ann@t.io', phone: '9111111111', passwordHash: h, avatarUrl: 'https://img.example/ann.jpg' });
  const B = await M.User.create({ name: 'Bob Outsider', email: 'bob@t.io', phone: '9222222222', passwordHash: h });
  cat = await M.Category.create({ name: 'Cat', icon: 'x' });
  const mk = (title) => M.Course.create({ title, category: cat, shortDescription: 's', description: 'd', duration: '1m', fee: 1, instructor: 'i' });
  c1 = await mk('Course One'); c2 = await mk('Course Two');
  await M.Enrollment.create({ student: A._id, course: c1._id, enrolledBy: 'admin' });
  const login = async (email) => (await api().post('/api/auth/login').send({ email, password: 'Passw0rd!x' })).body.data.token;
  admin = await login('admin@t.io'); ann = await login('ann@t.io'); bob = await login('bob@t.io');
});
after(async () => { await disconnect(); });

let v1, v2, mod1;

test('admin adds Drive videos from a link or id; metadata comes from Google', async () => {
  mod1 = (await api().post('/api/admin/modules').set(auth(admin)).send({ course: c1.id, title: 'Module 1: Basics', order: 1 })).body.data;
  assert.equal(mod1.title, 'Module 1: Basics');
  const r = await api().post('/api/videos').set(auth(admin)).send({ courseId: c1.id, moduleId: mod1.id, source: `https://drive.google.com/file/d/${F1}/view?usp=sharing`, description: 'Intro' });
  assert.equal(r.status, 201);
  v1 = r.body.data;
  assert.deepEqual([v1.title, v1.durationSeconds, v1.duration, v1.provider, v1.order, v1.moduleId], ['Lecture 1', 100, '1:40', 'google-drive', 1, mod1.id]);
  assert.equal(v1.thumbnailUrl, `/api/videos/${v1.id}/thumbnail`);
  assert.equal(v1.source.ref, F1); // admins see the reference
  v2 = (await api().post('/api/videos').set(auth(admin)).send({ courseId: c1.id, source: F2, title: 'Custom title', isPublished: false })).body.data;
  assert.equal(v2.order, 2); assert.equal(v2.title, 'Custom title');
});

test('admin video validation and permissions', async () => {
  const post = (body, tok = admin) => api().post('/api/videos').set(auth(tok)).send({ courseId: c1.id, ...body });
  assert.equal((await post({ source: FDOC })).status, 400);           // not a video
  assert.equal((await post({ source: 'driveFile00000NOTFND' })).status, 404); // not shared / missing
  assert.equal((await post({ source: 'not a link' })).status, 400);
  assert.equal((await post({ source: F1, provider: 'vimeo' })).status, 400);
  assert.equal((await post({ source: F1, moduleId: '64b7f0f0f0f0f0f0f0f0f0f0' })).status, 400);
  assert.equal((await post({ source: F1, thumbnailUrl: 'javascript:alert(1)' })).status, 400);
  assert.equal((await post({ source: F1, extra: 1 })).status, 400);   // strict
  const mkv = await post({ source: FMKV, isPublished: false });
  assert.equal(mkv.body.data.warnings.length, 1);
  assert.equal((await post({ source: F1 }, ann)).status, 403);
  assert.equal((await api().post('/api/videos').send({})).status, 401);
  await api().delete(`/api/videos/${mkv.body.data.id}`).set(auth(admin));
});

test('listing: locked for non-enrolled, never leaks provider refs/tokens, hides unpublished, paginates', async () => {
  const forBob = (await api().get(`/api/videos/course/${c1.id}`).set(auth(bob))).body.data;
  assert.equal(forBob.enrolled, false);
  assert.equal(forBob.items.length, 1); // v2 is unpublished
  assert.equal(forBob.items[0].locked, true);
  assert.equal(forBob.modules.length, 1);
  const raw = JSON.stringify(forBob);
  assert.ok(!raw.includes(F1) && !raw.includes('ACCESS-TOKEN') && !raw.includes('source'));
  const forAnn = (await api().get(`/api/videos/course/${c1.id}`).set(auth(ann))).body.data;
  assert.equal(forAnn.items[0].locked, false);
  const forAdmin = (await api().get(`/api/videos/course/${c1.id}`).set(auth(admin))).body.data;
  assert.equal(forAdmin.total, 2);
  const p1 = (await api().get(`/api/videos/course/${c1.id}?limit=1&page=1`).set(auth(admin))).body.data;
  assert.deepEqual([p1.items.length, p1.hasMore], [1, true]);
  assert.equal((await api().get(`/api/videos/course/${c1.id}?limit=1000`).set(auth(ann))).status, 400);
  assert.equal((await api().get(`/api/videos/course/${c1.id}`)).status, 401);
  assert.equal((await api().get('/api/videos/course/bad').set(auth(ann))).status, 400);
});

test('playback: enrollment enforced, unpublished hidden, token only via playback endpoint', async () => {
  assert.equal((await api().get(`/api/videos/${v1.id}/playback`).set(auth(bob))).status, 403);
  assert.equal((await api().get(`/api/videos/${v2.id}/playback`).set(auth(ann))).status, 404); // unpublished
  const r = await api().get(`/api/videos/${v1.id}/playback`).set(auth(ann));
  assert.equal(r.status, 200);
  assert.equal(r.headers['cache-control'], 'no-store');
  const d = r.body.data;
  assert.equal(d.type, 'progressive');
  assert.match(d.url, new RegExp(`/files/${F1}\\?alt=media`));
  assert.equal(d.headers.Authorization, 'Bearer ACCESS-TOKEN-1');
  assert.equal(d.resumeAtSeconds, 0);
  assert.equal((await api().get(`/api/videos/${v2.id}/playback`).set(auth(admin))).status, 200); // admins can preview
  assert.ok(!JSON.stringify((await api().get(`/api/videos/${v1.id}`).set(auth(ann))).body).includes('ACCESS-TOKEN'));
});

test('progress: saves position, resumes, clamps, auto-completes at 95% and feeds course progress', async () => {
  const save = (tok, body) => api().post('/api/video-progress').set(auth(tok)).send(body);
  assert.equal((await save(bob, { videoId: v1.id, positionSeconds: 10 })).status, 403);
  assert.equal((await save(ann, { videoId: v1.id, positionSeconds: -1 })).status, 400);
  assert.equal((await save(ann, { videoId: v1.id, positionSeconds: 99999999 })).status, 400);
  assert.equal((await save(ann, { videoId: v1.id, positionSeconds: 10, role: 'x' })).status, 400);
  assert.equal((await save(ann, { videoId: v2.id, positionSeconds: 10 })).status, 404); // unpublished

  let r = await save(ann, { videoId: v1.id, positionSeconds: 42.5 });
  assert.deepEqual([r.body.data.positionSeconds, r.body.data.completed, r.body.data.courseProgress.percent], [42.5, false, 0]);
  assert.equal((await api().get(`/api/video-progress/${v1.id}`).set(auth(ann))).body.data.positionSeconds, 42.5);
  assert.equal((await api().get(`/api/video-progress/${v1.id}`).set(auth(bob))).status, 403); // not enrolled: locked
  assert.equal((await api().get(`/api/videos/${v1.id}/playback`).set(auth(ann))).body.data.resumeAtSeconds, 42);
  assert.equal((await api().get(`/api/videos/course/${c1.id}`).set(auth(ann))).body.data.items[0].progress.percent, 43);

  r = await save(ann, { videoId: v1.id, positionSeconds: 5000 }); // beyond end -> clamped to the known duration (100s)
  assert.equal(r.body.data.positionSeconds, 100);
  assert.equal(r.body.data.completed, true);
  assert.equal(r.body.data.courseProgress.completedLessons, 1);
  assert.equal(await M.LessonProgress.countDocuments({ lesson: v1.id }), 1);
  r = await save(ann, { videoId: v1.id, positionSeconds: 3 }); // rewatching never un-completes
  assert.equal(r.body.data.completed, true);
  assert.equal(await M.LessonProgress.countDocuments({ lesson: v1.id }), 1);
  assert.equal((await api().get(`/api/videos/${v1.id}/playback`).set(auth(ann))).body.data.resumeAtSeconds, 0); // finished -> start over
  assert.equal((await M.User.findOne({ email: 'ann@t.io' })).lastLesson.toString(), v1.id);
});

test('thumbnails: provider thumbnail is proxied; admin thumbnail redirects', async () => {
  const t = await api().get(`/api/videos/${v1.id}/thumbnail`).set(auth(ann));
  assert.equal(t.status, 200); assert.equal(t.headers['content-type'], 'image/jpeg');
  assert.equal(t.headers['cross-origin-resource-policy'], 'cross-origin');
  assert.equal((await api().get(`/api/videos/${v2.id}/thumbnail`).set(auth(ann))).status, 404); // unpublished
  await api().put(`/api/videos/${v1.id}`).set(auth(admin)).send({ thumbnailUrl: 'https://img.example/t.png' });
  const redirect = await api().get(`/api/videos/${v1.id}/thumbnail`).set(auth(ann)).redirects(0);
  assert.equal(redirect.status, 302);
});

test('update / delete: re-validates sources, keeps Drive untouched, removes progress', async () => {
  const bad = await api().put(`/api/videos/${v2.id}`).set(auth(admin)).send({ source: FDOC });
  assert.equal(bad.status, 400);
  const up = await api().put(`/api/videos/${v2.id}`).set(auth(admin)).send({ title: 'Renamed', isPublished: true, moduleId: mod1.id });
  assert.equal(up.body.data.title, 'Renamed'); assert.equal(up.body.data.isPublished, true); assert.equal(up.body.data.durationSeconds, 60);
  assert.equal((await api().put(`/api/videos/${v2.id}`).set(auth(ann)).send({ title: 'x' })).status, 403);
  // module delete ungroups, does not delete lectures
  await api().delete(`/api/admin/modules/${mod1.id}`).set(auth(admin));
  assert.equal((await M.Lesson.findById(v2.id)).module, null);
  await api().post('/api/video-progress').set(auth(ann)).send({ videoId: v2.id, positionSeconds: 5 });
  assert.equal((await api().delete(`/api/videos/${v2.id}`).set(auth(ann))).status, 403);
  assert.equal((await api().delete(`/api/videos/${v2.id}`).set(auth(admin))).status, 200);
  assert.equal(await M.VideoProgress.countDocuments({ lesson: v2.id }), 0);
  assert.ok(!driveCalls.some((u) => /method=DELETE/.test(u)));
});

test('older lessons that only have videoUrl still appear and play (link provider)', async () => {
  const l = await M.Lesson.create({ course: c1._id, order: 9, title: 'Legacy', videoUrl: 'https://cdn.example/legacy.mp4' });
  const list = (await api().get(`/api/videos/course/${c1.id}`).set(auth(ann))).body.data;
  assert.ok(list.items.some((i) => i.id === String(l._id) && i.provider === 'link'));
  const pb = (await api().get(`/api/videos/${l._id}/playback`).set(auth(ann))).body.data;
  assert.deepEqual([pb.type, pb.url, pb.headers], ['progressive', 'https://cdn.example/legacy.mp4', {}]);
  const none = await M.Lesson.create({ course: c1._id, order: 10, title: 'No video yet' });
  assert.equal((await api().get(`/api/videos/${none._id}/playback`).set(auth(ann))).status, 404);
});

test('Drive not configured -> admin gets a clear 503, students are unaffected for other content', async () => {
  const saved = config.google.privateKey; config.google.privateKey = ''; drive._reset();
  const r = await api().post('/api/videos').set(auth(admin)).send({ courseId: c1.id, source: F1 });
  assert.equal(r.status, 503); assert.match(r.body.error, /not configured/);
  config.google.privateKey = saved; drive._reset();
});

// ---------------- reviews ----------------
let rv;
test('reviews: only enrolled students; pending until approved; one per course; no self-claimed placement info', async () => {
  const post = (tok, body) => api().post('/api/reviews').set(auth(tok)).send(body);
  assert.equal((await post(bob, { courseId: c1.id, rating: 5, review: 'Great course, loved it.' })).status, 403);
  assert.equal((await post(ann, { courseId: c1.id, rating: 6, review: 'Great course, loved it.' })).status, 400);
  assert.equal((await post(ann, { courseId: c1.id, rating: 5, review: 'short' })).status, 400);
  assert.equal((await post(ann, { courseId: c1.id, rating: 5, review: 'Great course, loved it.', placementInfo: { company: 'Google' } })).status, 400);
  assert.equal((await post(ann, { courseId: c1.id, rating: 5, review: 'Great course, loved it.', approvalStatus: 'approved' })).status, 400);
  const r = await post(ann, { courseId: c1.id, rating: 5, review: 'Great course, loved it.' });
  assert.equal(r.status, 201); rv = r.body.data;
  assert.equal(rv.approvalStatus, 'pending');
  assert.equal((await post(ann, { courseId: c1.id, rating: 4, review: 'Second attempt here.' })).status, 409);
  assert.equal((await api().get('/api/reviews')).body.data.total, 0);                       // not public yet
  assert.equal((await api().get('/api/reviews?status=pending')).body.data.total, 0);        // anonymous cannot override
  assert.equal((await api().get('/api/reviews?status=pending').set(auth(ann))).body.data.total, 0);
  assert.equal((await api().get('/api/reviews/mine').set(auth(ann))).body.data[0].approvalStatus, 'pending');
  assert.equal((await api().get('/api/reviews?status=pending').set(auth(admin))).body.data.total, 1);
  assert.equal((await api().get('/api/reviews?status=bogus').set(auth(admin))).status, 400);
});

test('reviews: admin approval publishes; public shape hides private fields; edits re-queue', async () => {
  assert.equal((await api().patch(`/api/reviews/${rv.id}/approve`).set(auth(ann)).send({ approvalStatus: 'approved' })).status, 403);
  assert.equal((await api().patch(`/api/reviews/${rv.id}/approve`).set(auth(admin)).send({ approvalStatus: 'maybe' })).status, 400);
  assert.equal((await api().patch(`/api/reviews/${rv.id}/approve`).set(auth(admin)).send({ approvalStatus: 'approved' })).status, 200);
  const pub = (await api().get('/api/reviews')).body.data;
  assert.equal(pub.total, 1);
  const item = pub.items[0];
  assert.deepEqual([item.studentName, item.courseName, item.rating, item.profileImage], ['Ann Enrolled', 'Course One', 5, 'https://img.example/ann.jpg']);
  assert.ok(!('approvalStatus' in item) && !('studentId' in item) && !JSON.stringify(item).includes('ann@t.io'));
  assert.deepEqual(pub.summary, { count: 1, average: 5 });
  assert.equal((await api().get(`/api/reviews?course=${c2.id}`)).body.data.total, 0);

  assert.equal((await api().put(`/api/reviews/${rv.id}`).set(auth(bob)).send({ rating: 1 })).status, 404); // someone else's
  assert.equal((await api().delete(`/api/reviews/${rv.id}`).set(auth(bob))).status, 404);
  const edited = await api().put(`/api/reviews/${rv.id}`).set(auth(ann)).send({ rating: 4, review: 'Updated: still very good.' });
  assert.equal(edited.body.data.approvalStatus, 'pending');
  assert.equal((await api().get('/api/reviews')).body.data.total, 0); // pulled from public until re-approved
  assert.equal((await api().put(`/api/reviews/${rv.id}`).set(auth(ann)).send({ approvalStatus: 'approved' })).status, 400);
});

test('reviews: admin can add for a real enrolled student with placement info; delete works', async () => {
  const annId = (await M.User.findOne({ email: 'ann@t.io' })).id, bobId = (await M.User.findOne({ email: 'bob@t.io' })).id;
  assert.equal((await api().post('/api/reviews').set(auth(admin)).send({ studentId: bobId, courseId: c1.id, rating: 5, review: 'Admin typed this one.' })).status, 403); // bob is not enrolled
  assert.equal((await api().post('/api/reviews').set(auth(admin)).send({ studentId: annId, courseId: c1.id, rating: 5, review: 'Admin typed this one.' })).status, 409); // already reviewed
  await M.Enrollment.create({ student: annId, course: c2._id, enrolledBy: 'admin' });
  const r = await api().post('/api/reviews').set(auth(admin)).send({ studentId: annId, courseId: c2.id, rating: 5, review: 'Got placed after this course!', placementInfo: { company: 'Acme', role: 'Developer' } });
  assert.equal(r.status, 201);
  const pub = (await api().get(`/api/reviews?course=${c2.id}`)).body.data.items[0];
  assert.deepEqual(pub.placementInfo, { company: 'Acme', role: 'Developer' });
  assert.equal((await api().delete(`/api/reviews/${r.body.data.id}`).set(auth(admin))).status, 200);
  assert.equal((await api().delete(`/api/reviews/${rv.id}`).set(auth(ann))).status, 200);
});

// ---------------- placed students ----------------
test('placed students: public only when verified AND published; rules enforced; admin only writes', async () => {
  const body = { studentName: 'Real Person', companyName: 'Acme Ltd', designation: 'Developer', courseName: 'Course One', placementYear: 2026 };
  assert.equal((await api().post('/api/placed-students').set(auth(ann)).send(body)).status, 403);
  assert.equal((await api().post('/api/placed-students').send(body)).status, 401);
  assert.equal((await api().post('/api/placed-students').set(auth(admin)).send({ ...body, profileImage: 'http://insecure.example/a.png' })).status, 400);
  assert.equal((await api().post('/api/placed-students').set(auth(admin)).send({ ...body, companyLogo: 'javascript:alert(1)' })).status, 400);
  assert.equal((await api().post('/api/placed-students').set(auth(admin)).send({ ...body, placementYear: 1999 })).status, 400);
  assert.equal((await api().post('/api/placed-students').set(auth(admin)).send({ ...body, isPublished: true })).status, 400); // unverified cannot be published
  const created = await api().post('/api/placed-students').set(auth(admin)).send({ ...body, companyLogo: 'https://img.example/logo.png' });
  assert.equal(created.status, 201);
  const id = created.body.data.id;
  assert.equal((await api().get('/api/placed-students')).body.data.total, 0);
  assert.equal((await api().put(`/api/placed-students/${id}`).set(auth(admin)).send({ isPublished: true })).status, 400);
  const ok2 = await api().put(`/api/placed-students/${id}`).set(auth(admin)).send({ verificationStatus: 'verified', isPublished: true });
  assert.equal(ok2.status, 200);
  const list = (await api().get('/api/placed-students')).body.data;
  assert.equal(list.total, 1);
  assert.ok(!('verificationStatus' in list.items[0]) && !('studentId' in list.items[0]));
  assert.equal((await api().get('/api/placed-students?all=1').set(auth(ann))).body.data.items[0].verificationStatus, undefined); // ?all is admin-only
  assert.equal((await api().get('/api/placed-students?all=1').set(auth(admin))).body.data.items[0].verificationStatus, 'verified');
  const un = await api().put(`/api/placed-students/${id}`).set(auth(admin)).send({ verificationStatus: 'rejected' });
  assert.equal(un.body.data.isPublished, false); // un-verifying hides it automatically
  assert.equal((await api().get('/api/placed-students')).body.data.total, 0);
  assert.equal((await api().put(`/api/placed-students/${id}`).set(auth(admin)).send({ studentId: '64b7f0f0f0f0f0f0f0f0f0f0' })).status, 400);
  assert.equal((await api().delete(`/api/placed-students/${id}`).set(auth(ann))).status, 403);
  assert.equal((await api().delete(`/api/placed-students/${id}`).set(auth(admin))).status, 200);
  assert.equal((await api().delete(`/api/placed-students/${id}`).set(auth(admin))).status, 404);
});

test('placed students: pagination', async () => {
  for (let i = 0; i < 3; i += 1) {
    await api().post('/api/placed-students').set(auth(admin)).send({ studentName: `P${i}`, companyName: 'C', designation: 'D', courseName: 'X', placementYear: 2020 + i, verificationStatus: 'verified', isPublished: true });
  }
  const p = (await api().get('/api/placed-students?limit=2&page=1')).body.data;
  assert.deepEqual([p.items.length, p.total, p.hasMore, p.items[0].placementYear], [2, 3, true, 2022]); // newest year first
  assert.equal((await api().get('/api/placed-students?limit=999')).status, 400);
});

// ---------------- media ----------------
test('media: admin uploads small real images; public GET is cacheable; fakes and oversize rejected', async () => {
  const up = await api().post('/api/admin/media').set(auth(admin)).set('Content-Type', 'image/png').send(PNG);
  assert.equal(up.status, 201);
  assert.match(up.body.data.url, /^\/api\/media\/[a-f\d]{24}$/);
  const got = await api().get(up.body.data.url);
  assert.equal(got.status, 200);
  assert.equal(got.headers['content-type'], 'image/png');
  assert.match(got.headers['cache-control'], /immutable/);
  assert.equal(got.headers['cross-origin-resource-policy'], 'cross-origin');
  assert.deepEqual(got.body, PNG);
  assert.equal((await api().post('/api/admin/media').set(auth(admin)).set('Content-Type', 'image/png').send(Buffer.from('<script>alert(1)</script>'))).status, 400); // wrong signature
  assert.equal((await api().post('/api/admin/media').set(auth(admin)).set('Content-Type', 'image/png').send(Buffer.concat([PNG, Buffer.alloc(400 * 1024)]))).status, 413);
  assert.equal((await api().post('/api/admin/media').set(auth(admin)).set('Content-Type', 'text/html').send('<b>')).status, 400);
  assert.equal((await api().post('/api/admin/media').set(auth(ann)).set('Content-Type', 'image/png').send(PNG)).status, 403);
  assert.equal((await api().post('/api/admin/media').set('Content-Type', 'image/png').send(PNG)).status, 401);
  assert.equal((await api().get('/api/media/not-an-id')).status, 400);
  assert.equal((await api().get('/api/media/64b7f0f0f0f0f0f0f0f0f0f0')).status, 404);
  // an uploaded image can be used on a record
  const pl = await api().post('/api/placed-students').set(auth(admin)).send({ studentName: 'With Photo', companyName: 'C', designation: 'D', courseName: 'X', placementYear: 2025, profileImage: up.body.data.url });
  assert.equal(pl.status, 201);
});
