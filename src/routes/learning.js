const express = require('express');
const { z } = require('zod');
const config = require('../config');
const { Course, Lesson, Enrollment, LessonProgress, User } = require('../models');
const { requireAuth } = require('../middleware/auth');
const { validate, idParams } = require('../middleware/validate');
const { ok, notFound, forbidden } = require('../utils/http');
const serialize = require('../utils/serialize');
const P = require('../utils/progress');

const router = express.Router();

const publishedCourse = async (id) => {
  const course = await Course.findOne({ _id: id, published: true }).populate('category', 'name');
  if (!course) throw notFound('Course not found');
  return course;
};

router.get('/me/enrollments', requireAuth, async (req, res) => ok(res, await P.enrolledCourseIds(req.user._id)));

router.get('/courses/:id/enrolled', requireAuth, idParams('id'), async (req, res) =>
  ok(res, await P.isEnrolled(req.user._id, req.params.id))
);

router.post('/courses/:id/enroll', requireAuth, idParams('id'), async (req, res) => {
  if (!config.selfEnrollment && req.user.role !== 'admin') {
    throw forbidden('Enrollment is handled by the institute. Please contact the office.');
  }
  const course = await publishedCourse(req.params.id);
  const existing = await Enrollment.findOne({ student: req.user._id, course: course._id });
  if (existing) {
    return ok(res, { course: serialize.course(course), alreadyEnrolled: true }, 'You are already enrolled in this course');
  }
  await Enrollment.create({ student: req.user._id, course: course._id, enrolledBy: 'self' });
  await Course.updateOne({ _id: course._id }, { $inc: { studentsEnrolled: 1 } });
  ok(res, { course: serialize.course(course), alreadyEnrolled: false }, 'Enrolled successfully', 201);
});

router.get('/courses/:id/lessons', requireAuth, idParams('id'), async (req, res) => {
  const course = await publishedCourse(req.params.id);
  const [lessons, completed, enrolled] = await Promise.all([
    Lesson.find({ course: course._id, published: true }).sort({ order: 1 }),
    P.completedMap(req.user._id, [course._id]),
    P.isEnrolled(req.user._id, course._id),
  ]);
  ok(
    res,
    lessons.map((l) =>
      serialize.lesson(l, {
        completed: completed.has(String(l._id)),
        completedAt: completed.get(String(l._id)) || null,
        showVideo: enrolled,
      })
    )
  );
});

router.get('/lessons/:id', requireAuth, idParams('id'), async (req, res) => {
  const lesson = await Lesson.findOne({ _id: req.params.id, published: true });
  if (!lesson) throw notFound('Lesson not found');
  const [completed, enrolled] = await Promise.all([
    LessonProgress.exists({ student: req.user._id, lesson: lesson._id }),
    P.isEnrolled(req.user._id, lesson.course),
  ]);
  ok(res, serialize.lesson(lesson, { completed: Boolean(completed), showVideo: enrolled }));
});

const completionSchema = z.object({ completed: z.boolean() }).strict();

router.put('/lessons/:id/completion', requireAuth, idParams('id'), validate(completionSchema), async (req, res) => {
  const lesson = await Lesson.findOne({ _id: req.params.id, published: true });
  if (!lesson) throw notFound('Lesson not found');
  if (!(await P.isEnrolled(req.user._id, lesson.course))) throw forbidden('Enroll in this course to track your progress');

  if (req.body.completed) {
    await LessonProgress.updateOne(
      { student: req.user._id, lesson: lesson._id },
      { $setOnInsert: { student: req.user._id, lesson: lesson._id, course: lesson.course, completedAt: new Date() } },
      { upsert: true }
    );
  } else {
    await LessonProgress.deleteOne({ student: req.user._id, lesson: lesson._id });
  }
  await User.updateOne({ _id: req.user._id }, { lastLesson: lesson._id });

  ok(
    res,
    {
      lessonId: String(lesson._id),
      completed: req.body.completed,
      progress: await P.courseProgress(req.user._id, lesson.course),
    },
    req.body.completed ? 'Lesson marked as completed' : 'Lesson marked as not completed'
  );
});

router.get('/courses/:id/progress', requireAuth, idParams('id'), async (req, res) =>
  ok(res, await P.courseProgress(req.user._id, req.params.id))
);

router.get('/me/learning', requireAuth, async (req, res) => {
  const ids = await P.enrolledCourseIds(req.user._id);
  const courses = await Course.find({ _id: { $in: ids }, published: true }).populate('category', 'name');
  const order = new Map(ids.map((id, i) => [id, i]));
  courses.sort((a, b) => order.get(String(a._id)) - order.get(String(b._id)));

  const courseIds = courses.map((c) => c._id);
  const [lessons, completed] = await Promise.all([P.lessonsByCourse(courseIds), P.completedMap(req.user._id, courseIds)]);
  const items = courses.map((c) => ({
    course: serialize.course(c),
    progress: P.computeProgress(c._id, lessons.get(String(c._id)), completed),
  }));
  ok(res, {
    items,
    inProgress: items.filter((i) => i.progress.percent < 100),
    completed: items.filter((i) => i.progress.percent === 100),
  });
});

// The next lesson to study: the course of the last lesson touched first, otherwise any enrolled course with work left.
router.get('/me/continue', requireAuth, async (req, res) => {
  const ids = await P.enrolledCourseIds(req.user._id);
  if (ids.length === 0) return ok(res, null);

  const candidates = [];
  if (req.user.lastLesson) {
    const last = await Lesson.findById(req.user.lastLesson);
    if (last && ids.includes(String(last.course))) candidates.push(String(last.course));
  }
  ids.forEach((id) => !candidates.includes(id) && candidates.push(id));

  const [lessons, completed] = await Promise.all([P.lessonsByCourse(candidates), P.completedMap(req.user._id, candidates)]);
  for (const courseId of candidates) {
    const list = lessons.get(courseId);
    const next = list.find((l) => !completed.has(String(l._id)));
    if (next) {
      const course = await Course.findOne({ _id: courseId, published: true }).populate('category', 'name');
      if (!course) continue;
      return ok(res, {
        course: serialize.course(course),
        lesson: serialize.lesson(next, { showVideo: true }),
        progress: P.computeProgress(courseId, list, completed),
      });
    }
  }
  ok(res, null, 'All enrolled lessons are completed');
});

module.exports = router;
