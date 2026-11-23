process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/shakti_test';
process.env.RATE_LIMIT = 'off';
process.env.BCRYPT_ROUNDS = '4';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const config = require('../src/config');
const drive = require('../src/services/googleDrive.service');
const { connect, disconnect } = require('../src/db');
const { createApp } = require('../src/app');
const M = require('../src/models');

const api = () => request(createApp());
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const FOLDER = 'application/vnd.google-apps.folder';
const ROOT = 'ROOTFOLDER000000001', AIML = 'AIMLFOLDER000000001', PY = 'PYTHONFOLDER00000001', NP = 'NUMPYFOLDER00000001', PD = 'PANDASFOLDER0000001', GD = 'GRAPHICFOLDER0000001', CD = 'CORELFOLDER00000001', OUTSIDE = 'OUTSIDEFOLDER0000001', ELSEWHERE = 'ELSEWHEREFOLDER00001';
// A fake Google Drive: id -> { name, mime, parents, size, ms }
const D = {};
const put = (id, name, mime, parents, extra = {}) => { D[id] = { id, name, mimeType: mime, parents, trashed: false, ...extra }; };
const vid = (id, name, parent, ms = 60000, mime = 'video/mp4') => put(id, name, mime, [parent], { size: '1000', thumbnailLink: 'x', videoMediaMetadata: { durationMillis: String(ms) } });
let admin, ann, bob, course, gdCourse, calls;

before(async () => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  config.google.serviceAccountEmail = 'sa@x.iam.gserviceaccount.com'; config.google.privateKey = privateKey; config.google.rootFolderId = ROOT;
  put(ROOT, 'application video', FOLDER, ['top']);
  put(AIML, 'aiml', FOLDER, [ROOT]); put(GD, 'graphic design', FOLDER, [ROOT]); put(OUTSIDE, 'private stuff', FOLDER, ['top']); put(ELSEWHERE, 'x', 'application/pdf', [ROOT]);
  put(PY, 'python', FOLDER, [AIML]); put(NP, 'numpy', FOLDER, [AIML]); put(PD, 'pandas', FOLDER, [AIML]); put(CD, 'coral drow', FOLDER, [GD]);
  vid('VIDEOPY0000000002', 'function in python.mp4', PY, 125000); vid('VIDEOPY0000000001', 'introduction to python.mp4', PY, 3725000);
  vid('VIDEONP0000000001', 'introduction to numpy.mp4', NP); vid('VIDEOPD0000000001', 'data cleaning.mp4', PD);
  vid('VIDEOAIML00000001', 'welcome to aiml.mp4', AIML); put('NOTESPDF000000001', 'notes.pdf', 'application/pdf', [AIML]);
  vid('VIDEOGD0000000001', 'intro to coraldrow.mp4', CD);
  calls = [];
  drive._reset();
  drive._setFetch(async (url) => {
    const u = String(url); calls.push(u);
    const r = (s, b) => ({ ok: s < 400, status: s, json: async () => b, headers: new Map() });
    if (u.includes('oauth2')) return r(200, { access_token: 'TOKEN', expires_in: 3599 });
    const parsed = new URL(u);
    if (parsed.pathname.endsWith('/files')) {
      const parent = /'([^']+)' in parents/.exec(parsed.searchParams.get('q'))[1];
      return r(200, { files: Object.values(D).filter((f) => f.parents.includes(parent) && !f.trashed) });
    }
    const id = parsed.pathname.split('/').pop();
    return D[id] ? r(200, D[id]) : r(404, {});
  });
  await connect(process.env.MONGODB_URI);
  await Promise.all(Object.values(M).map((m) => m.deleteMany({})));
  const h = await bcrypt.hash('Passw0rd!x', 4);
  await M.User.create({ name: 'Admin', email: 'admin@t.io', phone: '9000000000', role: 'admin', passwordHash: h });
  await M.User.create({ name: 'Ann', email: 'ann@t.io', phone: '9111111111', passwordHash: h });
  await M.User.create({ name: 'Bob', email: 'bob@t.io', phone: '9222222222', passwordHash: h });
  const cat = await M.Category.create({ name: 'Cat', icon: 'x' });
  const mk = (t) => M.Course.create({ title: t, category: cat, shortDescription: 's', description: 'd', duration: '1m', fee: 1, instructor: 'i' });
  course = await mk('AI & ML'); gdCourse = await mk('Graphic Design');
  const login = async (email) => (await api().post('/api/auth/login').send({ email, password: 'Passw0rd!x' })).body.data.token;
  admin = await login('admin@t.io'); ann = await login('ann@t.io'); bob = await login('bob@t.io');
});
after(async () => { await disconnect(); });

test('SELF_ENROLLMENT=False (any capitalisation) really turns self-enrollment off', () => {
  const run = (v) => execFileSync(process.execPath, ['-e', 'console.log(require("./src/config").selfEnrollment)'], { env: { ...process.env, SELF_ENROLLMENT: v, NODE_ENV: 'development' }, cwd: __dirname + '/..' }).toString().trim();
  assert.equal(run('False'), 'false'); assert.equal(run('FALSE'), 'false'); assert.equal(run('false'), 'false'); assert.equal(run('0'), 'false');
  assert.equal(run('true'), 'true'); assert.equal(run('True'), 'true');
});

test('admin lists the course folders inside the root video folder; others cannot', async () => {
  const r = await api().get('/api/videos/drive/folders').set(auth(admin));
  assert.equal(r.status, 200); assert.deepEqual(r.body.data.folders.map((f) => f.name), ['aiml', 'graphic design']); // files and outside folders never appear
  assert.equal((await api().get('/api/videos/drive/folders').set(auth(ann))).status, 403);
  assert.equal((await api().get('/api/videos/drive/folders')).status, 401);
});

test('folders outside the root, files and bad ids are refused', async () => {
  const pre = (folderId) => api().get('/api/videos/drive/preview').query({ courseId: course.id, folderId }).set(auth(admin));
  assert.equal((await pre(OUTSIDE)).status, 400);
  assert.equal((await pre(ELSEWHERE)).status, 400);
  assert.equal((await pre('short')).status, 400);
  assert.equal((await pre('DOESNOTEXIST0000001')).status, 404);
});

test('preview shows subjects as modules and videos as lectures, without saving anything', async () => {
  const r = await api().get('/api/videos/drive/preview').query({ courseId: course.id, folderId: AIML }).set(auth(admin));
  assert.equal(r.status, 200);
  const g = r.body.data.groups;
  assert.deepEqual(g.map((x) => x.title), ['(no subject folder)', 'numpy', 'pandas', 'python']);
  assert.deepEqual(g.find((x) => x.title === 'python').videos.map((v) => v.title), ['function in python', 'introduction to python']);
  assert.deepEqual(r.body.data.totals, { videos: 5, newVideos: 5, alreadyImported: 0, subjects: 3 });
  assert.deepEqual(r.body.data.skipped.map((s) => s.name), ['notes.pdf']);
  assert.equal(await M.Lesson.countDocuments({ course: course._id }), 0);
});

test('import creates modules + lectures in order; running it again only adds what is new', async () => {
  const imp = (c, f, extra = {}) => api().post('/api/videos/drive/import').set(auth(admin)).send({ courseId: c.id, folderId: f, ...extra });
  const r = await imp(course, AIML);
  assert.equal(r.status, 200); assert.deepEqual([r.body.data.modulesCreated, r.body.data.lecturesCreated, r.body.data.alreadyImported], [3, 5, 0]);
  const mods = await M.Module.find({ course: course._id }).sort({ order: 1 });
  assert.deepEqual(mods.map((m) => [m.title, m.order]), [['numpy', 1], ['pandas', 2], ['python', 3]]);
  const lessons = await M.Lesson.find({ course: course._id }).sort({ order: 1 });
  assert.deepEqual(lessons.map((l) => l.title), ['welcome to aiml', 'introduction to numpy', 'data cleaning', 'function in python', 'introduction to python']);
  assert.deepEqual(lessons.map((l) => l.order), [1, 2, 3, 4, 5]);
  assert.equal(lessons[0].module, null);
  const py = mods.find((m) => m.title === 'python');
  assert.ok(lessons.slice(3).every((l) => String(l.module) === String(py._id)));
  assert.equal(lessons[4].duration, '1:02:05'); assert.equal(lessons[3].duration, '2:05');
  assert.deepEqual([lessons[0].video.provider, lessons[0].video.ref], ['google-drive', 'VIDEOAIML00000001']);
  assert.equal((await M.Course.findById(course._id)).driveFolderId, AIML);

  // same folder again: nothing duplicated
  const again = await imp(course, AIML);
  assert.deepEqual([again.body.data.modulesCreated, again.body.data.lecturesCreated, again.body.data.alreadyImported], [0, 0, 5]);
  // a new video appears in Drive: sync adds only that one, into the existing module
  vid('VIDEOPY0000000003', 'loops in python.mp4', PY);
  const sync = await imp(course, AIML);
  assert.deepEqual([sync.body.data.modulesCreated, sync.body.data.lecturesCreated, sync.body.data.alreadyImported], [0, 1, 5]);
  assert.equal(await M.Module.countDocuments({ course: course._id }), 3);
  // a second course from its own folder
  const gd = await imp(gdCourse, GD); assert.deepEqual([gd.body.data.modulesCreated, gd.body.data.lecturesCreated], [1, 1]); // the video sits in the sub-folder "coral drow", which becomes a module
});

test('nested subject folders keep their names; hidden/unpublished import option works', async () => {
  const mods = await M.Module.find({ course: gdCourse._id });
  assert.deepEqual(mods.map((m) => m.title), ['coral drow']);
  const l = await M.Lesson.findOne({ course: gdCourse._id });
  assert.equal(l.title, 'intro to coraldrow'); assert.equal(String(l.module), String(mods[0]._id));
  const hidden = await M.Course.create({ title: 'Hidden', category: course.category, shortDescription: 's', description: 'd', duration: '1m', fee: 1, instructor: 'i' });
  const r = await api().post('/api/videos/drive/import').set(auth(admin)).send({ courseId: hidden.id, folderId: PY, publish: false });
  assert.equal(r.status, 200);
  assert.ok((await M.Lesson.find({ course: hidden._id })).every((x) => x.published === false));
});

test('only the admin can import; students cannot even preview', async () => {
  assert.equal((await api().post('/api/videos/drive/import').set(auth(ann)).send({ courseId: course.id, folderId: AIML })).status, 403);
  assert.equal((await api().get('/api/videos/drive/preview').query({ courseId: course.id, folderId: AIML }).set(auth(ann))).status, 403);
  assert.equal((await api().post('/api/videos/drive/import').set(auth(admin)).send({ courseId: course.id, folderId: OUTSIDE })).status, 400);
  assert.equal((await api().post('/api/videos/drive/import').set(auth(admin)).send({ courseId: course.id, folderId: AIML, extra: 1 })).status, 400);
});

test('admin adds a student WITH courses; only those courses open for that student', async () => {
  const add = await api().post('/api/admin/students').set(auth(admin)).send({ name: 'Cara', email: 'cara@t.io', phone: '9333333333', password: 'Passw0rd!x', courses: [course.id] });
  assert.equal(add.status, 201); assert.match(add.body.message, /enrolled in 1 course/); assert.equal(add.body.data.enrolledCount, 1);
  assert.equal((await api().post('/api/admin/students').set(auth(admin)).send({ name: 'Dan', email: 'dan@t.io', phone: '9444444444', password: 'Passw0rd!x', courses: ['64b7f0f0f0f0f0f0f0f0f0f0'] })).status, 400);
  assert.equal(await M.User.countDocuments({ email: 'dan@t.io' }), 0); // nothing half-created
  const cara = (await api().post('/api/auth/login').send({ email: 'cara@t.io', password: 'Passw0rd!x' })).body.data.token;
  const lessons = (await api().get(`/api/videos/course/${course.id}`).set(auth(cara)));
  assert.equal(lessons.status, 200); assert.equal(lessons.body.data.items.length, 6);
  assert.equal((await api().get(`/api/videos/course/${gdCourse.id}`).set(auth(cara))).body.data.items.every((v) => v.locked), true);
  assert.equal(JSON.stringify(lessons.body).includes(AIML), false); // the Drive folder id is never sent to students
  assert.equal(await M.Course.findById(course._id).then((c) => c.studentsEnrolled), 1);

  // change access: swap to the other course
  const id = (await M.User.findOne({ email: 'cara@t.io' })).id;
  const put2 = await api().put(`/api/admin/students/${id}/courses`).set(auth(admin)).send({ courses: [gdCourse.id] });
  assert.equal(put2.status, 200); assert.deepEqual([put2.body.data.added, put2.body.data.removed], [1, 1]);
  assert.equal((await api().get(`/api/quizzes/course/${course.id}`).set(auth(cara))).status, 403);
  assert.equal((await api().get(`/api/quizzes/course/${gdCourse.id}`).set(auth(cara))).status, 200);
  assert.equal((await M.Course.findById(course._id)).studentsEnrolled, 0);
});

test('AUDIT: a student with no enrollment is locked out of every part of a course', async () => {
  const lessonId = String((await M.Lesson.findOne({ course: course._id }))._id);
  const prev = config.selfEnrollment; config.selfEnrollment = false;
  try {
    const bobGet = (p) => api().get(p).set(auth(bob));
    assert.equal((await api().post(`/api/courses/${course.id}/enroll`).set(auth(bob))).status, 403);
    for (const p of [`/api/videos/${lessonId}/playback`, `/api/video-progress/${lessonId}`]) assert.equal((await bobGet(p)).status, 403, p);
    const one = await bobGet(`/api/videos/${lessonId}`); // lecture card is visible but locked, with no playable data
    assert.ok(one.status === 403 || (one.body.data.locked === true && !JSON.stringify(one.body).includes('VIDEO')));
    assert.equal((await api().post('/api/video-progress').set(auth(bob)).send({ videoId: lessonId, positionSeconds: 5 })).status, 403);
    assert.equal((await api().put(`/api/lessons/${lessonId}/completion`).set(auth(bob)).send({ completed: true })).status, 403);
    assert.equal((await bobGet(`/api/quizzes/course/${course.id}`)).status, 403);
    const list = (await bobGet(`/api/videos/course/${course.id}`)).body.data.items;
    assert.ok(list.length > 0 && list.every((v) => v.locked === true));
    assert.ok(!JSON.stringify(list).includes('VIDEO')); // no Drive file ids
    const lessons = (await bobGet(`/api/courses/${course.id}/lessons`)).body;
    assert.ok(!JSON.stringify(lessons).includes('VIDEOPY') && !/videoUrl":"https/.test(JSON.stringify(lessons)));
    assert.equal((await bobGet('/api/me/enrollments')).body.data.length, 0);
    assert.equal((await bobGet('/api/me/learning')).body.data.items.length, 0);
  } finally { config.selfEnrollment = prev; }
});
