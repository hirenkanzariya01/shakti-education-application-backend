process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/shakti_test';
process.env.RATE_LIMIT = 'off';
process.env.BCRYPT_ROUNDS = '4';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
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
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
let admin, ann, bob, annUser, course, lessonId, placedId, reviewId, secretKey;

before(async () => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  secretKey = privateKey;
  config.google.serviceAccountEmail = 'sa@x.iam.gserviceaccount.com'; config.google.privateKey = privateKey; config.google.rootFolderId = '';
  drive._reset();
  drive._setFetch(async (url) => {
    const u = String(url);
    const r = (s, b) => ({ ok: s < 400, status: s, json: async () => b, headers: new Map(), arrayBuffer: async () => Buffer.from('x') });
    if (u.includes('oauth2')) return r(200, { access_token: 'ACCESS-TOKEN-SEC', expires_in: 3599 });
    return r(200, { id: 'driveFile000000009', name: 'L.mp4', mimeType: 'video/mp4', videoMediaMetadata: { durationMillis: '60000' } });
  });
  await connect(process.env.MONGODB_URI);
  await Promise.all(Object.values(M).map((m) => m.deleteMany({})));
  const h = await bcrypt.hash('Passw0rd!x', 4);
  await M.User.create({ name: 'Admin', email: 'admin@t.io', phone: '9000000000', role: 'admin', passwordHash: h });
  annUser = await M.User.create({ name: 'Ann', email: 'ann@t.io', phone: '9111111111', passwordHash: h });
  await M.User.create({ name: 'Bob', email: 'bob@t.io', phone: '9222222222', passwordHash: h });
  const cat = await M.Category.create({ name: 'Cat', icon: 'x' });
  course = await M.Course.create({ title: 'C', category: cat, shortDescription: 's', description: 'd', duration: '1m', fee: 1, instructor: 'i' });
  await M.Enrollment.create({ student: annUser._id, course: course._id, enrolledBy: 'admin' });
  const login = async (email) => (await api().post('/api/auth/login').send({ email, password: 'Passw0rd!x' })).body.data.token;
  admin = await login('admin@t.io'); ann = await login('ann@t.io'); bob = await login('bob@t.io');
  lessonId = (await api().post('/api/videos').set(auth(admin)).send({ courseId: course.id, source: 'driveFile000000009' })).body.data.id;
  placedId = (await api().post('/api/placed-students').set(auth(admin)).send({ studentName: 'P', companyName: 'Co', designation: 'D', courseName: 'C', placementYear: 2025 })).body.data.id;
  reviewId = (await api().post('/api/reviews').set(auth(ann)).send({ courseId: course.id, rating: 5, review: 'Pending review text here.' })).body.data.id;
});
after(async () => { await disconnect(); });

test('every protected endpoint refuses anonymous callers (401)', async () => {
  const calls = [
    ['get', `/api/videos/course/${course.id}`], ['get', `/api/videos/${lessonId}`], ['get', `/api/videos/${lessonId}/playback`], ['get', `/api/videos/${lessonId}/thumbnail`],
    ['post', '/api/videos'], ['put', `/api/videos/${lessonId}`], ['delete', `/api/videos/${lessonId}`], ['get', '/api/videos'],
    ['post', '/api/video-progress'], ['get', `/api/video-progress/${lessonId}`],
    ['post', '/api/reviews'], ['get', '/api/reviews/mine'], ['put', `/api/reviews/${reviewId}`], ['delete', `/api/reviews/${reviewId}`], ['patch', `/api/reviews/${reviewId}/approve`],
    ['post', '/api/placed-students'], ['put', `/api/placed-students/${placedId}`], ['delete', `/api/placed-students/${placedId}`],
    ['post', '/api/admin/media'], ['get', '/api/admin/students'],
  ];
  for (const [m, p] of calls) assert.equal((await api()[m](p).send({})).status, 401, `${m} ${p}`);
});

test('a student cannot use any admin endpoint (403)', async () => {
  const calls = [
    ['post', '/api/videos'], ['put', `/api/videos/${lessonId}`], ['delete', `/api/videos/${lessonId}`], ['get', '/api/videos'], ['get', '/api/videos/options'],
    ['patch', `/api/reviews/${reviewId}/approve`], ['post', '/api/placed-students'], ['put', `/api/placed-students/${placedId}`], ['delete', `/api/placed-students/${placedId}`],
    ['post', '/api/admin/media'], ['get', '/api/admin/students'], ['post', '/api/admin/modules'],
  ];
  for (const [m, p] of calls) assert.equal((await api()[m](p).set(auth(ann)).send({})).status, 403, `${m} ${p}`);
});

test('forged, expired, wrong-secret and alg=none tokens are rejected', async () => {
  const id = String(annUser._id);
  const bad = [
    jwt.sign({ sub: id }, 'a-different-secret-that-is-long-enough-123456'),
    jwt.sign({ sub: id }, config.jwtSecret, { expiresIn: -10 }),
    `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: id })).toString('base64url')}.`,
    'garbage', '',
  ];
  for (const t of bad) assert.equal((await api().get('/api/reviews/mine').set(auth(t))).status, 401);
});

test('NoSQL-injection style payloads cannot log in or alter queries', async () => {
  const r1 = await api().post('/api/auth/login').send({ email: { $ne: '' }, password: { $ne: '' } });
  assert.ok([400, 401].includes(r1.status)); assert.equal(r1.body.success, false);
  // Express's simple query parser keeps `course[$ne]` as a plain key, so no operator ever reaches Mongo; a crafted value is rejected.
  const r2 = await api().get('/api/reviews').query({ course: { $ne: null } });
  assert.ok(r2.status < 500); assert.equal(r2.body.data ? r2.body.data.items.length : 0, 0);
  assert.equal((await api().get('/api/reviews?course={"$ne":null}')).status, 400);
  const r3 = await api().get('/api/reviews').query({ status: 'all' }); // anonymous callers cannot widen the filter
  assert.ok(r3.body.data.items.every((r) => r.approvalStatus === undefined));
  assert.equal(r3.body.data.items.length, 0); // the only review is still pending
});

test('unpublished / unverified content never reaches the public', async () => {
  assert.equal((await api().get('/api/reviews')).body.data.total, 0);
  assert.equal((await api().get('/api/placed-students')).body.data.total, 0);
  assert.equal((await api().get('/api/placed-students').query({ all: '1' })).body.data.total, 0);
  assert.equal((await api().get('/api/placed-students').query({ all: '1' }).set(auth(ann))).body.data.total, 0);
  assert.equal((await api().get('/api/placed-students').query({ all: '1' }).set(auth(admin))).body.data.total, 1);
  assert.equal((await api().get('/api/reviews').query({ status: 'all' }).set(auth(ann))).body.data.total, 0);
  assert.equal((await api().get('/api/reviews').query({ status: 'all' }).set(auth(admin))).body.data.total, 1);
});

test('students cannot read or change another student’s review, or review without enrollment', async () => {
  assert.equal((await api().put(`/api/reviews/${reviewId}`).set(auth(bob)).send({ rating: 1 })).status, 404);
  assert.equal((await api().delete(`/api/reviews/${reviewId}`).set(auth(bob)).send()).status, 404);
  assert.equal((await api().post('/api/reviews').set(auth(bob)).send({ courseId: course.id, rating: 5, review: 'Never enrolled in this.' })).status, 403);
  // mass-assignment: a student cannot approve their own review or add placement claims
  assert.equal((await api().post('/api/reviews').set(auth(ann)).send({ courseId: course.id, rating: 5, review: 'x'.repeat(12), approvalStatus: 'approved' })).status, 400);
  assert.equal((await api().put(`/api/reviews/${reviewId}`).set(auth(ann)).send({ approvalStatus: 'approved' })).status, 400);
  assert.equal((await api().put(`/api/reviews/${reviewId}`).set(auth(ann)).send({ placementInfo: { company: 'Google', role: 'SWE' } })).status, 400);
});

test('video access: non-enrolled students are refused and no secrets appear in student responses', async () => {
  assert.equal((await api().get(`/api/videos/${lessonId}/playback`).set(auth(bob))).status, 403);
  const ok = await api().get(`/api/videos/${lessonId}/playback`).set(auth(ann));
  assert.equal(ok.status, 200); assert.equal(ok.headers['cache-control'], 'no-store');
  const bodies = [ok.text, (await api().get(`/api/videos/course/${course.id}`).set(auth(ann))).text, (await api().get(`/api/videos/${lessonId}`).set(auth(ann))).text];
  for (const b of bodies) {
    assert.ok(!b.includes('driveFile000000009') || b === ok.text, 'Drive file id leaked outside the playback URL');
    assert.ok(!b.includes('PRIVATE KEY') && !b.includes('sa@x.iam') && !b.includes('refresh_token') && !b.includes('client_secret'));
  }
  // the playback URL points at Google, never at our own server (video bytes are not proxied)
  assert.match(ok.body.data.url, /^https:\/\/www\.googleapis\.com\/drive\/v3\/files\//);
});

test('uploads: only real small images, spoofed types and oversized bodies are refused', async () => {
  const up = (body, type) => api().post('/api/admin/media').set(auth(admin)).set('Content-Type', type).send(body);
  assert.equal((await up(PNG, 'image/png')).status, 201);
  assert.equal((await up(Buffer.from('<script>alert(1)</script>'), 'image/png')).status, 400); // claims PNG, is not
  assert.equal((await up(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml')).status, 400);
  assert.equal((await up(Buffer.concat([PNG, Buffer.alloc(400 * 1024)]), 'image/png')).status, 413);
  const stored = await api().post('/api/admin/media').set(auth(admin)).set('Content-Type', 'image/png').send(PNG);
  const got = await api().get(stored.body.data.url);
  assert.equal(got.headers['content-type'], 'image/png'); assert.match(got.headers['content-security-policy'], /default-src 'none'/);
  assert.equal(got.headers['x-content-type-options'], 'nosniff');
});

test('request size, bad ids and malformed JSON get clean errors (no stack traces)', async () => {
  const big = await api().post('/api/auth/login').send({ email: 'a@b.co', password: 'x'.repeat(200 * 1024) });
  assert.equal(big.status, 413);
  assert.equal((await api().get('/api/videos/not-an-id').set(auth(ann))).status, 400);
  const bad = await api().post('/api/auth/login').set('Content-Type', 'application/json').send('{"email":');
  assert.equal(bad.status, 400); assert.ok(!/at .*\(.*:\d+:\d+\)/.test(bad.text));
});

test('CORS: only allow-listed browser origins; security headers present', async () => {
  const evil = await api().get('/api/health').set('Origin', 'https://evil.example');
  assert.equal(evil.headers['access-control-allow-origin'], undefined);
  const good = await api().get('/api/health').set('Origin', config.corsOrigins[0]);
  assert.equal(good.headers['access-control-allow-origin'], config.corsOrigins[0]);
  assert.equal(good.headers['x-powered-by'], undefined);
  assert.equal(good.headers['x-content-type-options'], 'nosniff');
  assert.ok(good.headers['strict-transport-security']);
});

test('no response carries password hashes or the service-account key', async () => {
  const texts = [
    (await api().get('/api/me').set(auth(ann))).text,
    (await api().get('/api/admin/students').set(auth(admin))).text,
    (await api().get('/api/videos').set(auth(admin))).text,
  ];
  for (const t of texts) assert.ok(!/passwordHash|\$2[aby]\$|BEGIN PRIVATE KEY/.test(t) && !t.includes(secretKey.slice(40, 80)));
});

test('rate limiting engages (login brute force) when enabled', async () => {
  config.rateLimitEnabled = true;
  const limited = createApp();
  let last;
  for (let i = 0; i < 22; i++) last = await request(limited).post('/api/auth/login').send({ email: 'ann@t.io', password: 'wrong-password' });
  config.rateLimitEnabled = false;
  assert.equal(last.status, 429);
});

test('readiness reports the database state', async () => {
  const r = await api().get('/api/health/ready');
  assert.equal(r.status, 200); assert.equal(r.body.data.status, 'ready');
});
