process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/shakti_test';
process.env.RATE_LIMIT = 'off';
process.env.BCRYPT_ROUNDS = '4';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const { connect, disconnect } = require('../src/db');
const { createApp } = require('../src/app');
const M = require('../src/models');

const api = () => request(createApp());
const auth = (t) => ({ Authorization: `Bearer ${t}` });
let admin, ann, ben, bob, c1, c2, quiz, qs;

before(async () => {
  await connect(process.env.MONGODB_URI);
  await Promise.all(Object.values(M).map((m) => m.deleteMany({})));
  const h = await bcrypt.hash('Passw0rd!x', 4);
  await M.User.create({ name: 'Admin', email: 'admin@t.io', phone: '9000000000', role: 'admin', passwordHash: h });
  const A = await M.User.create({ name: 'Ann', email: 'ann@t.io', phone: '9111111111', passwordHash: h });
  const B = await M.User.create({ name: 'Ben', email: 'ben@t.io', phone: '9222222222', passwordHash: h });
  await M.User.create({ name: 'Bob', email: 'bob@t.io', phone: '9333333333', passwordHash: h });
  const cat = await M.Category.create({ name: 'Cat', icon: 'x' });
  const mk = (t) => M.Course.create({ title: t, category: cat, shortDescription: 's', description: 'd', duration: '1m', fee: 1, instructor: 'i' });
  c1 = await mk('Course One'); c2 = await mk('Course Two');
  await M.Enrollment.create({ student: A._id, course: c1._id, enrolledBy: 'admin' });
  await M.Enrollment.create({ student: B._id, course: c1._id, enrolledBy: 'admin' });
  await M.Enrollment.create({ student: B._id, course: c2._id, enrolledBy: 'admin' });
  const login = async (email) => (await api().post('/api/auth/login').send({ email, password: 'Passw0rd!x' })).body.data.token;
  admin = await login('admin@t.io'); ann = await login('ann@t.io'); ben = await login('ben@t.io'); bob = await login('bob@t.io');
});
after(async () => { await disconnect(); });

const Q = [
  { text: '2 + 2 = ?', options: ['3', '4', '5'], correctIndex: 1, marks: 2 },
  { text: 'Capital of India?', options: ['Mumbai', 'Delhi'], correctIndex: 1 },
  { text: 'Sky colour?', options: ['Blue', 'Green', 'Red', 'Black'], correctIndex: 0 },
];

test('teacher creates a quiz as a draft; validation rejects bad questions', async () => {
  const post = (body) => api().post('/api/quizzes').set(auth(admin)).send({ courseId: c1.id, title: 'Unit 1', ...body });
  assert.equal((await post({ questions: [{ text: 'x', options: ['a'], correctIndex: 0 }] })).status, 400);               // one option
  assert.equal((await post({ questions: [{ text: 'x', options: ['a', 'b'], correctIndex: 2 }] })).status, 400);         // answer outside options
  assert.equal((await post({ questions: [{ text: 'x', options: ['a', 'A'], correctIndex: 0 }] })).status, 400);         // duplicate options
  assert.equal((await post({ questions: [{ text: 'x', options: ['a', 'b'], correctIndex: 0, extra: 1 }] })).status, 400);
  assert.equal((await api().post('/api/quizzes').set(auth(admin)).send({ courseId: '64b7f0f0f0f0f0f0f0f0f0f0', title: 't' })).status, 400);
  const r = await post({ description: 'Basics', questions: Q });
  assert.equal(r.status, 201); quiz = r.body.data;
  assert.equal(quiz.status, 'draft'); assert.equal(quiz.questionCount, 3); assert.equal(quiz.totalMarks, 4);
  qs = (await api().get(`/api/quizzes/${quiz.id}`).set(auth(admin))).body.data.questions;
  assert.equal(qs[0].correctIndex, 1); // the teacher sees the answers
});

test('drafts are invisible to students; publishing needs questions', async () => {
  assert.equal((await api().get(`/api/quizzes/course/${c1.id}`).set(auth(ann))).body.data.length, 0);
  assert.equal((await api().get(`/api/quizzes/${quiz.id}`).set(auth(ann))).status, 404);
  const empty = (await api().post('/api/quizzes').set(auth(admin)).send({ courseId: c1.id, title: 'Empty' })).body.data;
  assert.equal((await api().patch(`/api/quizzes/${empty.id}/status`).set(auth(admin)).send({ status: 'published' })).status, 400);
  await api().delete(`/api/quizzes/${empty.id}`).set(auth(admin));
  assert.equal((await api().patch(`/api/quizzes/${quiz.id}/status`).set(auth(admin)).send({ status: 'published' })).status, 200);
});

test('course-wise access: only students enrolled in THAT course can see or take it', async () => {
  assert.equal((await api().get(`/api/quizzes/course/${c1.id}`).set(auth(bob))).status, 403);
  assert.equal((await api().get(`/api/quizzes/${quiz.id}`).set(auth(bob))).status, 403);
  assert.equal((await api().post(`/api/quizzes/${quiz.id}/submit`).set(auth(bob)).send({ answers: [] })).status, 403);
  // Ben is in both courses but Course Two has no quiz; Ann (Course One only) cannot see Course Two's
  assert.equal((await api().get(`/api/quizzes/course/${c2.id}`).set(auth(ann))).status, 403);
  assert.equal((await api().get(`/api/quizzes/course/${c1.id}`)).status, 401);
  const list = (await api().get(`/api/quizzes/course/${c1.id}`).set(auth(ann))).body.data;
  assert.equal(list.length, 1); assert.equal(list[0].myStatus, 'not_attempted');
});

test('students never receive the right answers, before or after submitting', async () => {
  const r = await api().get(`/api/quizzes/${quiz.id}`).set(auth(ann));
  assert.equal(r.status, 200); assert.equal(r.body.data.canSubmit, true);
  assert.ok(!r.text.includes('correctIndex'), 'correctIndex leaked');
  assert.equal(r.body.data.questions.length, 3);
});

test('submit: validated, one attempt only, response reveals nothing', async () => {
  const id = (i) => qs[i].id;
  const sub = (tok, answers) => api().post(`/api/quizzes/${quiz.id}/submit`).set(auth(tok)).send({ answers });
  assert.equal((await sub(ann, [{ questionId: '64b7f0f0f0f0f0f0f0f0f0f0', selected: 0 }])).status, 400);   // not in this quiz
  assert.equal((await sub(ann, [{ questionId: id(0), selected: 3 }])).status, 400);                       // outside the options
  assert.equal((await sub(ann, [{ questionId: id(0), selected: 1 }, { questionId: id(0), selected: 0 }])).status, 400); // duplicate
  const ok1 = await sub(ann, [{ questionId: id(0), selected: 1 }, { questionId: id(1), selected: 0 }]); // Ann: Q1 right, Q2 wrong, Q3 skipped
  assert.equal(ok1.status, 201); assert.ok(!/score|correct/i.test(JSON.stringify(ok1.body.data)));
  assert.equal((await sub(ann, [{ questionId: id(2), selected: 0 }])).status, 409);                        // second try refused
  assert.equal((await sub(ben, [{ questionId: id(0), selected: 1 }, { questionId: id(1), selected: 1 }, { questionId: id(2), selected: 0 }])).status, 201); // Ben: all right
  const view = (await api().get(`/api/quizzes/${quiz.id}`).set(auth(ann))).body.data;
  assert.equal(view.canSubmit, false); assert.equal(view.myStatus, 'submitted'); assert.equal(view.myAnswers.length, 2);
  assert.ok(!JSON.stringify(view).includes('correctIndex'));
});

test('no result before the teacher declares it', async () => {
  const r = await api().get(`/api/quizzes/${quiz.id}/result`).set(auth(ann));
  assert.equal(r.status, 409); assert.ok(!/score/.test(r.text.replace(/not been declared/, '')));
  assert.equal((await api().get(`/api/quizzes/${quiz.id}/result`).set(auth(bob))).status, 403);
});

test('teacher sees live scores; questions are locked once students have answered', async () => {
  const at = (await api().get(`/api/quizzes/${quiz.id}/attempts`).set(auth(admin))).body.data;
  assert.equal(at.total, 2);
  const ann_ = at.items.find((a) => a.studentName === 'Ann'); const ben_ = at.items.find((a) => a.studentName === 'Ben');
  assert.deepEqual([ann_.score, ann_.totalMarks, ann_.answered, ben_.score, ben_.percentage], [2, 4, 2, 4, 100]);
  assert.equal((await api().get(`/api/quizzes/${quiz.id}/attempts`).set(auth(ann))).status, 403);
  assert.equal((await api().put(`/api/quizzes/${quiz.id}`).set(auth(admin)).send({ questions: Q })).status, 409);
  assert.equal((await api().put(`/api/quizzes/${quiz.id}`).set(auth(admin)).send({ title: 'Unit 1 (renamed)' })).status, 200);
  assert.equal((await api().patch(`/api/quizzes/${quiz.id}/status`).set(auth(admin)).send({ status: 'draft' })).status, 409);
});

test('closing stops answers; declaring the result grades, notifies, and unlocks results', async () => {
  const late = await M.User.findOne({ email: 'ann@t.io' });
  assert.ok(late);
  assert.equal((await api().post(`/api/quizzes/${quiz.id}/declare-result`).set(auth(ann)).send({})).status, 403);
  const d = await api().post(`/api/quizzes/${quiz.id}/declare-result`).set(auth(admin)).send({});
  assert.equal(d.status, 200); assert.equal(d.body.data.attemptCount, 2); assert.equal(d.body.data.status, 'closed');
  assert.equal((await api().post(`/api/quizzes/${quiz.id}/declare-result`).set(auth(admin)).send({})).status, 409);
  assert.equal(await M.Notification.countDocuments({ title: 'Quiz result declared' }), 2);
  const mine = (await api().get('/api/notifications').set(auth(ann))).body.data;
  assert.ok(JSON.stringify(mine).includes('Quiz result declared'));
  const r = (await api().get(`/api/quizzes/${quiz.id}/result`).set(auth(ann))).body.data;
  assert.deepEqual([r.score, r.totalMarks, r.correctCount, r.percentage, r.answersRevealed], [2, 4, 1, 50, false]);
  assert.deepEqual(r.review.map((x) => x.isCorrect), [true, false, false]);
  assert.equal(r.review[2].yourAnswer, null); // skipped
  assert.ok(!JSON.stringify(r).includes('correctIndex'), 'answers stay hidden unless the teacher chose to reveal them');
  assert.equal((await api().get(`/api/quizzes/${quiz.id}`).set(auth(ann))).body.data.myStatus, 'result_ready');
  assert.equal((await api().patch(`/api/quizzes/${quiz.id}/status`).set(auth(admin)).send({ status: 'published' })).status, 409);
});

test('a student who never answered cannot see a result; closed quizzes accept no answers; reveal option works', async () => {
  const q2 = (await api().post('/api/quizzes').set(auth(admin)).send({ courseId: c1.id, title: 'Unit 2', questions: [Q[0]] })).body.data;
  await api().patch(`/api/quizzes/${q2.id}/status`).set(auth(admin)).send({ status: 'published' });
  const ids = (await api().get(`/api/quizzes/${q2.id}`).set(auth(admin))).body.data.questions;
  await api().post(`/api/quizzes/${q2.id}/submit`).set(auth(ann)).send({ answers: [{ questionId: ids[0].id, selected: 2 }] });
  await api().patch(`/api/quizzes/${q2.id}/status`).set(auth(admin)).send({ status: 'closed' });
  assert.equal((await api().post(`/api/quizzes/${q2.id}/submit`).set(auth(ben)).send({ answers: [] })).status, 409);
  assert.equal((await api().get(`/api/quizzes/course/${c1.id}`).set(auth(ben))).body.data.find((x) => x.id === q2.id).myStatus, 'missed');
  await api().post(`/api/quizzes/${q2.id}/declare-result`).set(auth(admin)).send({ revealAnswers: true });
  assert.equal((await api().get(`/api/quizzes/${q2.id}/result`).set(auth(ben))).status, 404);
  const r = (await api().get(`/api/quizzes/${q2.id}/result`).set(auth(ann))).body.data;
  assert.equal(r.answersRevealed, true); assert.equal(r.review[0].correctIndex, 1); assert.equal(r.score, 0);
});

test('access is granted by the institute: with self-enrollment off, students cannot add courses; admin enroll unlocks videos + quizzes', async () => {
  const config = require('../src/config');
  const was = config.selfEnrollment; config.selfEnrollment = false;
  try {
    assert.equal((await api().post(`/api/courses/${c2.id}/enroll`).set(auth(ann))).status, 403);
    assert.equal((await api().get(`/api/quizzes/course/${c2.id}`).set(auth(ann))).status, 403);
    const annId = (await M.User.findOne({ email: 'ann@t.io' })).id;
    assert.equal((await api().post(`/api/admin/students/${annId}/enroll`).set(auth(admin)).send({ course: c2.id })).status, 201);
    assert.equal((await api().get(`/api/quizzes/course/${c2.id}`).set(auth(ann))).status, 200);
    await api().delete(`/api/admin/students/${annId}/enrollments/${c2.id}`).set(auth(admin));
    assert.equal((await api().get(`/api/quizzes/course/${c2.id}`).set(auth(ann))).status, 403); // access can be taken away again
  } finally { config.selfEnrollment = was; }
});

test('deleting a quiz removes its attempts', async () => {
  assert.equal((await api().delete(`/api/quizzes/${quiz.id}`).set(auth(ann))).status, 403);
  assert.equal((await api().delete(`/api/quizzes/${quiz.id}`).set(auth(admin))).status, 200);
  assert.equal(await M.QuizAttempt.countDocuments({ quiz: quiz.id }), 0);
});
