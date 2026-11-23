const express = require('express');
const { z } = require('zod');
const { Quiz, QuizAttempt, Course, User, Notification } = require('../models');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { validate, idParams } = require('../middleware/validate');
const { ok, notFound, forbidden, badRequest, HttpError } = require('../utils/http');
const { pageQuery, pageResult } = require('../utils/paginate');
const P = require('../utils/progress');

const created = (res, data, message) => ok(res, data, message, 201);
const router = express.Router();
router.use(requireAuth);

const oid = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id');
const isAdmin = (req) => req.user.role === 'admin';

// ---------- validation ----------
const questionSchema = z.object({
  text: z.string().trim().min(1).max(500),
  options: z.array(z.string().trim().min(1).max(200)).min(2).max(6),
  correctIndex: z.number().int().min(0).max(5),
  marks: z.number().int().min(1).max(100).default(1),
}).strict().superRefine((q, ctx) => {
  if (q.correctIndex >= q.options.length) ctx.addIssue({ code: 'custom', message: 'The correct answer must be one of the options', path: ['correctIndex'] });
  if (new Set(q.options.map((o) => o.toLowerCase())).size !== q.options.length) ctx.addIssue({ code: 'custom', message: 'Options must be different from each other', path: ['options'] });
});
const questions = z.array(questionSchema).max(100);
const createSchema = z.object({ courseId: oid, title: z.string().trim().min(1).max(120), description: z.string().trim().max(600).default(''), questions: questions.default([]) }).strict();
const updateSchema = z.object({ title: z.string().trim().min(1).max(120), description: z.string().trim().max(600), questions }).partial().strict();
const statusSchema = z.object({ status: z.enum(['draft', 'published', 'closed']) }).strict();
const declareSchema = z.object({ revealAnswers: z.boolean().default(false) }).strict();
const submitSchema = z.object({ answers: z.array(z.object({ questionId: oid, selected: z.number().int().min(0).max(5) }).strict()).max(100) }).strict();

// ---------- helpers ----------
const totalMarks = (quiz) => quiz.questions.reduce((n, q) => n + q.marks, 0);
function grade(quiz, attempt) {
  const chosen = new Map(attempt.answers.map((a) => [String(a.question), a.selected]));
  let score = 0; let correct = 0;
  for (const q of quiz.questions) if (chosen.get(String(q._id)) === q.correctIndex) { score += q.marks; correct += 1; }
  return { score, correctCount: correct, totalMarks: totalMarks(quiz) };
}
const summary = (quiz, extra = {}) => ({
  id: quiz.id, courseId: String(quiz.course), title: quiz.title, description: quiz.description, status: quiz.status,
  resultDeclared: quiz.resultDeclared, resultDeclaredAt: quiz.resultDeclaredAt, questionCount: quiz.questions.length, totalMarks: totalMarks(quiz),
  createdAt: quiz.createdAt, ...extra,
});
// Students NEVER get correctIndex here.
const studentQuestions = (quiz) => quiz.questions.map((q) => ({ id: String(q._id), text: q.text, options: q.options, marks: q.marks }));
const adminQuestions = (quiz) => quiz.questions.map((q) => ({ id: String(q._id), text: q.text, options: q.options, correctIndex: q.correctIndex, marks: q.marks }));

async function loadQuiz(id) {
  const quiz = await Quiz.findById(id);
  if (!quiz) throw notFound('Quiz not found');
  return quiz;
}
async function loadForStudent(req) {
  const quiz = await loadQuiz(req.params.id);
  if (quiz.status === 'draft') throw notFound('Quiz not found');
  if (!(await P.isEnrolled(req.user._id, quiz.course))) throw forbidden('Enroll in this course to take its quizzes');
  return quiz;
}

// ---------- student + admin: list a course's quizzes ----------
router.get('/course/:courseId', idParams('courseId'), async (req, res) => {
  const admin = isAdmin(req);
  if (!admin) {
    const course = await Course.findOne({ _id: req.params.courseId, published: true }).select('_id');
    if (!course) throw notFound('Course not found');
    if (!(await P.isEnrolled(req.user._id, req.params.courseId))) throw forbidden('Enroll in this course to see its quizzes');
  }
  const quizzes = await Quiz.find({ course: req.params.courseId, ...(admin ? {} : { status: { $ne: 'draft' } }) }).sort({ createdAt: -1 });
  const ids = quizzes.map((q) => q._id);
  if (admin) {
    const counts = await Promise.all(quizzes.map((q) => QuizAttempt.countDocuments({ quiz: q._id })));
    return ok(res, quizzes.map((q, i) => summary(q, { attemptCount: counts[i] })));
  }
  const mine = await QuizAttempt.find({ quiz: { $in: ids }, student: req.user._id }).select('quiz');
  const done = new Set(mine.map((a) => String(a.quiz)));
  ok(res, quizzes.map((q) => {
    const attempted = done.has(q.id);
    const myStatus = !attempted ? (q.status === 'closed' ? 'missed' : 'not_attempted') : q.resultDeclared ? 'result_ready' : 'submitted';
    return summary(q, { myStatus });
  }));
});

// ---------- admin: create / edit / status / declare / attempts / delete ----------
router.post('/', requireAdmin, validate(createSchema), async (req, res) => {
  const course = await Course.findById(req.body.courseId).select('_id');
  if (!course) throw badRequest('Course not found');
  const { courseId, ...rest } = req.body;
  const quiz = await Quiz.create({ ...rest, course: courseId, createdBy: req.user._id });
  created(res, { ...summary(quiz), questions: adminQuestions(quiz) }, 'Quiz created (as a draft)');
});

router.put('/:id', requireAdmin, idParams('id'), validate(updateSchema), async (req, res) => {
  const quiz = await loadQuiz(req.params.id);
  if (req.body.questions) {
    if (quiz.resultDeclared) throw new HttpError(409, 'The result is already declared, so the questions can no longer change');
    if (await QuizAttempt.exists({ quiz: quiz._id })) throw new HttpError(409, 'Students have already answered this quiz, so its questions can no longer change');
  }
  Object.assign(quiz, req.body);
  await quiz.save();
  ok(res, { ...summary(quiz), questions: adminQuestions(quiz) }, 'Saved');
});

router.patch('/:id/status', requireAdmin, idParams('id'), validate(statusSchema), async (req, res) => {
  const quiz = await loadQuiz(req.params.id);
  const to = req.body.status;
  if (quiz.resultDeclared && to !== 'closed') throw new HttpError(409, 'The result is already declared; this quiz stays closed');
  if (to === 'published' && quiz.questions.length === 0) throw badRequest('Add at least one question before publishing');
  if (to === 'draft' && (await QuizAttempt.exists({ quiz: quiz._id }))) throw new HttpError(409, 'Students have already answered this quiz, so it cannot go back to draft. Close it instead.');
  quiz.status = to;
  await quiz.save();
  ok(res, summary(quiz), to === 'published' ? 'Published: enrolled students can answer now' : to === 'closed' ? 'Closed: no more answers' : 'Moved back to draft');
});

// Grades every submission, closes the quiz and tells the students who took it.
router.post('/:id/declare-result', requireAdmin, idParams('id'), validate(declareSchema), async (req, res) => {
  const quiz = await loadQuiz(req.params.id);
  if (quiz.resultDeclared) throw new HttpError(409, 'The result is already declared');
  if (quiz.status === 'draft') throw badRequest('Publish the quiz and let students answer before declaring the result');
  const attempts = await QuizAttempt.find({ quiz: quiz._id });
  for (const a of attempts) {
    Object.assign(a, grade(quiz, a));
    await a.save();
  }
  quiz.status = 'closed'; quiz.resultDeclared = true; quiz.resultDeclaredAt = new Date(); quiz.revealAnswers = req.body.revealAnswers;
  await quiz.save();
  if (attempts.length) {
    await Notification.insertMany(attempts.map((a) => ({
      title: 'Quiz result declared', message: `Your result for "${quiz.title}" is ready. Open the course quizzes to see it.`, type: 'course', student: a.student, createdBy: req.user._id,
    })));
  }
  ok(res, { ...summary(quiz), attemptCount: attempts.length }, `Result declared for ${attempts.length} student${attempts.length === 1 ? '' : 's'}`);
});

router.get('/:id/attempts', requireAdmin, idParams('id'), async (req, res) => {
  const quiz = await loadQuiz(req.params.id);
  const q = pageQuery(50, 100).parse({ page: req.query.page, limit: req.query.limit });
  const [total, rows] = await Promise.all([
    QuizAttempt.countDocuments({ quiz: quiz._id }),
    QuizAttempt.find({ quiz: quiz._id }).sort({ submittedAt: 1 }).skip((q.page - 1) * q.limit).limit(q.limit),
  ]);
  const users = await User.find({ _id: { $in: rows.map((r) => r.student) } }).select('name email');
  const byId = new Map(users.map((u) => [u.id, u]));
  const items = rows.map((a) => {
    const g = grade(quiz, a); // the teacher can always see the live score
    const u = byId.get(String(a.student));
    return { id: a.id, studentId: String(a.student), studentName: u ? u.name : 'Deleted student', studentEmail: u ? u.email : '', submittedAt: a.submittedAt,
      answered: a.answers.length, questionCount: quiz.questions.length, ...g, percentage: g.totalMarks ? Math.round((g.score / g.totalMarks) * 100) : 0 };
  });
  ok(res, { ...pageResult(items, total, q), quiz: summary(quiz) });
});

router.delete('/:id', requireAdmin, idParams('id'), async (req, res) => {
  const quiz = await loadQuiz(req.params.id);
  await QuizAttempt.deleteMany({ quiz: quiz._id });
  await quiz.deleteOne();
  ok(res, null, 'Quiz deleted');
});

// ---------- student (admins can preview) ----------
router.get('/:id', idParams('id'), async (req, res) => {
  if (isAdmin(req)) {
    const quiz = await loadQuiz(req.params.id);
    return ok(res, { ...summary(quiz, { attemptCount: await QuizAttempt.countDocuments({ quiz: quiz._id }) }), questions: adminQuestions(quiz) });
  }
  const quiz = await loadForStudent(req);
  const attempt = await QuizAttempt.findOne({ quiz: quiz._id, student: req.user._id });
  ok(res, {
    ...summary(quiz, { myStatus: !attempt ? (quiz.status === 'closed' ? 'missed' : 'not_attempted') : quiz.resultDeclared ? 'result_ready' : 'submitted' }),
    canSubmit: quiz.status === 'published' && !attempt,
    questions: studentQuestions(quiz),
    myAnswers: attempt ? attempt.answers.map((a) => ({ questionId: String(a.question), selected: a.selected })) : [],
    submittedAt: attempt ? attempt.submittedAt : null,
  });
});

// One submission per student. The response never says which answers were right.
router.post('/:id/submit', idParams('id'), validate(submitSchema), async (req, res) => {
  if (isAdmin(req)) throw forbidden('Only students can submit answers');
  const quiz = await loadForStudent(req);
  if (quiz.status !== 'published') throw new HttpError(409, 'This quiz is closed');
  const ids = new Set(quiz.questions.map((q) => String(q._id)));
  const seen = new Set();
  for (const a of req.body.answers) {
    const q = quiz.questions.id(a.questionId);
    if (!ids.has(a.questionId) || !q) throw badRequest('One of the answers is for a question that is not in this quiz');
    if (seen.has(a.questionId)) throw badRequest('Each question can be answered only once');
    if (a.selected >= q.options.length) throw badRequest('Choose one of the listed options');
    seen.add(a.questionId);
  }
  try {
    const attempt = await QuizAttempt.create({ quiz: quiz._id, course: quiz.course, student: req.user._id, answers: req.body.answers.map((a) => ({ question: a.questionId, selected: a.selected })) });
    created(res, { submittedAt: attempt.submittedAt, answered: attempt.answers.length, questionCount: quiz.questions.length }, 'Answers submitted. Your teacher will declare the result.');
  } catch (e) {
    if (e && e.code === 11000) throw new HttpError(409, 'You have already submitted this quiz');
    throw e;
  }
});

router.get('/:id/result', idParams('id'), async (req, res) => {
  if (isAdmin(req)) throw forbidden('Use the attempts list to see results');
  const quiz = await loadForStudent(req);
  const attempt = await QuizAttempt.findOne({ quiz: quiz._id, student: req.user._id });
  if (!attempt) throw notFound('You did not take this quiz');
  if (!quiz.resultDeclared) throw new HttpError(409, 'The result has not been declared yet');
  const g = { score: attempt.score, totalMarks: attempt.totalMarks, correctCount: attempt.correctCount };
  const mine = new Map(attempt.answers.map((a) => [String(a.question), a.selected]));
  ok(res, {
    quizId: quiz.id, title: quiz.title, ...g, percentage: g.totalMarks ? Math.round((g.score / g.totalMarks) * 100) : 0, questionCount: quiz.questions.length,
    answersRevealed: quiz.revealAnswers, declaredAt: quiz.resultDeclaredAt,
    review: quiz.questions.map((q) => {
      const selected = mine.has(String(q._id)) ? mine.get(String(q._id)) : null;
      return { questionId: String(q._id), text: q.text, options: q.options, yourAnswer: selected, isCorrect: selected === q.correctIndex, marks: q.marks,
        ...(quiz.revealAnswers ? { correctIndex: q.correctIndex } : {}) };
    }),
  });
});

module.exports = router;
