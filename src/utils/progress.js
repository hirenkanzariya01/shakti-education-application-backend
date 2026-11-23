const { Lesson, LessonProgress, Enrollment, Course } = require('../models');

// Published lessons grouped by course id, in lesson order.
async function lessonsByCourse(courseIds) {
  const lessons = await Lesson.find({ course: { $in: courseIds }, published: true }).sort({ order: 1 });
  const map = new Map(courseIds.map((id) => [String(id), []]));
  lessons.forEach((l) => map.get(String(l.course)).push(l));
  return map;
}

async function completedMap(studentId, courseIds) {
  const rows = await LessonProgress.find({ student: studentId, course: { $in: courseIds } });
  return new Map(rows.map((r) => [String(r.lesson), r.completedAt]));
}

function computeProgress(courseId, lessons, completed) {
  const total = lessons.length;
  const done = lessons.filter((l) => completed.has(String(l._id))).length;
  return {
    courseId: String(courseId),
    totalLessons: total,
    completedLessons: done,
    percent: total === 0 ? 0 : Math.round((done / total) * 100),
  };
}

async function courseProgress(studentId, courseId) {
  const lessons = (await lessonsByCourse([courseId])).get(String(courseId));
  const completed = await completedMap(studentId, [courseId]);
  return computeProgress(courseId, lessons, completed);
}

async function enrolledCourseIds(studentId) {
  const rows = await Enrollment.find({ student: studentId }).sort({ createdAt: 1 });
  return rows.map((r) => String(r.course));
}

async function isEnrolled(studentId, courseId) {
  return Boolean(await Enrollment.exists({ student: studentId, course: courseId }));
}

module.exports = { lessonsByCourse, completedMap, computeProgress, courseProgress, enrolledCourseIds, isEnrolled, Course };
