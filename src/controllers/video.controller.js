const { z } = require('zod');
const { Lesson, Module, Course, Enrollment, VideoProgress, LessonProgress, User } = require('../models');
const { ok, notFound, forbidden, badRequest } = require('../utils/http');
const { pageQuery, pageResult } = require('../utils/paginate');
const serialize = require('../utils/serialize');
const videoService = require('../services/video.service');
const P = require('../utils/progress');
const config = require('../config');
const { providerNames } = require('../services/providers');

const oid = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id');
const str = (max, min = 1) => z.string().trim().min(min).max(max);
const imageRef = z.union([z.literal(''), z.string().regex(serialize.MEDIA_OR_HTTPS, 'Use an https:// link or an uploaded image')]);

// Drive thumbnails take two Google calls each; keep recent ones in memory (max ~60 x <=1MB, 6 hours).
const thumbs = (() => {
  const m = new Map();
  return { async get(key, load) {
    const h = m.get(key);
    if (h && h.expires > Date.now()) return h.value;
    const value = await load();
    if (m.size >= 60) m.delete(m.keys().next().value);
    m.set(key, { value, expires: Date.now() + 6 * 3600 * 1000 });
    return value;
  } };
})();
const isAdmin = (req) => req.user.role === 'admin';
const hasVideoFilter = { $or: [{ 'video.ref': { $ne: '' } }, { videoUrl: { $ne: '' } }] };

// ---- shared loaders / guards ----
async function loadLesson(req) {
  const lesson = await Lesson.findById(req.params.videoId);
  if (!lesson || (!lesson.published && !isAdmin(req))) throw notFound('Video not found');
  return lesson;
}
async function assertCanWatch(req, courseId) {
  if (isAdmin(req)) return;
  const [course, enrolled] = await Promise.all([
    Course.exists({ _id: courseId, published: true }),
    P.isEnrolled(req.user._id, courseId),
  ]);
  if (!course) throw notFound('Video not found');
  if (!enrolled) throw forbidden('Enroll in this course to watch its videos');
}

// ---- schemas ----
const createSchema = z.object({
  courseId: oid, moduleId: oid.nullable().optional(), title: str(140).optional(), description: z.string().trim().max(2000).default(''),
  provider: z.string().trim().max(40).optional(), source: str(500), order: z.number().int().min(1).max(9999).optional(),
  thumbnailUrl: imageRef.optional(), isPublished: z.boolean().default(true),
}).strict();
const updateSchema = z.object({
  moduleId: oid.nullable().optional(), title: str(140).optional(), description: z.string().trim().max(2000).optional(),
  provider: z.string().trim().max(40).optional(), source: str(500).optional(), order: z.number().int().min(1).max(9999).optional(),
  thumbnailUrl: imageRef.optional(), isPublished: z.boolean().optional(),
}).strict();
const progressSchema = z.object({
  videoId: oid, positionSeconds: z.number().min(0).max(86400), durationSeconds: z.number().min(0).max(86400).optional(), completed: z.boolean().optional(),
}).strict();

async function assertModuleInCourse(moduleId, courseId) {
  if (moduleId && !(await Module.exists({ _id: moduleId, course: courseId }))) throw badRequest('That module does not belong to this course');
}

// ---- handlers ----
async function listByCourse(req, res) {
  const q = pageQuery(30, 100).parse(req.query);
  const course = await Course.findOne({ _id: req.params.courseId, ...(isAdmin(req) ? {} : { published: true }) }).select('_id');
  if (!course) throw notFound('Course not found');
  const admin = isAdmin(req);
  const enrolled = admin || (await P.isEnrolled(req.user._id, course._id));
  const filter = { course: course._id, ...hasVideoFilter, ...(admin ? {} : { published: true }) };

  const [total, lessons, modules] = await Promise.all([
    Lesson.countDocuments(filter),
    Lesson.find(filter).sort({ order: 1 }).skip((q.page - 1) * q.limit).limit(q.limit),
    Module.find({ course: course._id, ...(admin ? {} : { published: true }) }).sort({ order: 1 }),
  ]);
  const prog = await VideoProgress.find({ student: req.user._id, lesson: { $in: lessons.map((l) => l._id) } });
  const byLesson = new Map(prog.map((p) => [String(p.lesson), p]));
  const items = lessons.map((l) => serialize.video(l, { progress: byLesson.get(String(l._id)), locked: !enrolled, admin }));
  ok(res, {
    ...pageResult(items, total, q),
    modules: modules.map((m) => ({ id: String(m._id), title: m.title, description: m.description, order: m.order, published: m.published })),
    enrolled,
  });
}

// Admin: every lecture that has a video, optionally for one course (?course=<id>), paginated.
async function listAll(req, res) {
  const q = pageQuery(30, 100).parse({ page: req.query.page, limit: req.query.limit });
  const filter = { ...hasVideoFilter };
  if (req.query.course) {
    if (!/^[a-f\d]{24}$/i.test(String(req.query.course))) throw badRequest('Invalid course');
    filter.course = req.query.course;
  }
  const [total, lessons] = await Promise.all([
    Lesson.countDocuments(filter),
    Lesson.find(filter).sort({ course: 1, order: 1 }).skip((q.page - 1) * q.limit).limit(q.limit),
  ]);
  ok(res, pageResult(lessons.map((l) => serialize.video(l, { admin: true })), total, q));
}

async function getOne(req, res) {
  const lesson = await loadLesson(req);
  const enrolled = isAdmin(req) || (await P.isEnrolled(req.user._id, lesson.course));
  const progress = await VideoProgress.findOne({ student: req.user._id, lesson: lesson._id });
  ok(res, serialize.video(lesson, { progress, locked: !enrolled, admin: isAdmin(req) }));
}

// Enrollment is verified here, then the provider hands back how to play it (the app streams directly from the provider).
async function playback(req, res) {
  // Independent lookups run together: lesson + this student's progress, then course + enrollment check.
  const [lesson, progress] = await Promise.all([
    loadLesson(req),
    VideoProgress.findOne({ student: req.user._id, lesson: req.params.videoId }).lean(),
  ]);
  await assertCanWatch(req, lesson.course);
  const v = serialize.videoOf(lesson);
  const access = await videoService.getPlayback(v); // access token is cached in memory, no network call normally
  res.set('Cache-Control', 'no-store');
  ok(res, {
    videoId: String(lesson._id), title: lesson.title, ...access,
    durationSeconds: (v && v.durationSeconds) || 0,
    resumeAtSeconds: progress && !progress.completed ? Math.floor(progress.positionSeconds) : 0,
  });
}

async function thumbnail(req, res) {
  const lesson = await loadLesson(req);
  const v = serialize.videoOf(lesson);
  if (v && v.thumbnailUrl) return res.redirect(302, v.thumbnailUrl);
  const { buffer, contentType } = await thumbs.get(v.ref, () => videoService.getThumbnail(v));
  res.set({ 'Content-Type': contentType, 'Cache-Control': 'private, max-age=86400', 'Cross-Origin-Resource-Policy': 'cross-origin' });
  res.send(buffer);
}

async function create(req, res) {
  const b = req.body;
  const course = await Course.exists({ _id: b.courseId });
  if (!course) throw badRequest('Course does not exist');
  await assertModuleInCourse(b.moduleId, b.courseId);
  const { video, suggestedTitle, warnings } = await videoService.buildVideoRef({ provider: b.provider, source: b.source });
  if (b.thumbnailUrl !== undefined) video.thumbnailUrl = b.thumbnailUrl;
  let order = b.order;
  if (!order) {
    const last = await Lesson.findOne({ course: b.courseId }).sort({ order: -1 }).select('order');
    order = last ? last.order + 1 : 1;
  }
  const title = b.title || String(suggestedTitle || 'Untitled lecture').replace(/\.[a-z0-9]{2,4}$/i, '').slice(0, 140);
  const lesson = await Lesson.create({
    course: b.courseId, module: b.moduleId || null, order, title, description: b.description,
    duration: video.durationSeconds ? serialize.video({ _id: 'x', course: 'x', video, title, published: true }).duration : '',
    video, published: b.isPublished,
  });
  ok(res, { ...serialize.video(lesson, { admin: true }), warnings }, 'Video added', 201);
}

async function update(req, res) {
  const lesson = await Lesson.findById(req.params.videoId);
  if (!lesson) throw notFound('Video not found');
  const b = req.body;
  if (b.moduleId !== undefined) await assertModuleInCourse(b.moduleId, lesson.course);
  let warnings = [];
  if (b.source !== undefined) {
    const built = await videoService.buildVideoRef({ provider: b.provider || (lesson.video && lesson.video.provider) || undefined, source: b.source });
    const keepThumb = lesson.video && lesson.video.thumbnailUrl;
    lesson.video = { ...built.video, thumbnailUrl: keepThumb || '' };
    lesson.videoUrl = '';
    warnings = built.warnings;
    if (built.video.durationSeconds) lesson.duration = serialize.video({ _id: 'x', course: 'x', video: built.video, title: 'x', published: true }).duration;
  }
  if (b.moduleId !== undefined) lesson.module = b.moduleId;
  ['title', 'description', 'order'].forEach((k) => b[k] !== undefined && (lesson[k] = b[k]));
  if (b.isPublished !== undefined) lesson.published = b.isPublished;
  if (b.thumbnailUrl !== undefined) lesson.set('video.thumbnailUrl', b.thumbnailUrl);
  await lesson.save();
  ok(res, { ...serialize.video(lesson, { admin: true }), warnings }, 'Video updated');
}

// Removes the lecture and everyone's watch progress for it. The file in Google Drive is NOT touched.
async function remove(req, res) {
  const lesson = await Lesson.findByIdAndDelete(req.params.videoId);
  if (!lesson) throw notFound('Video not found');
  await Promise.all([VideoProgress.deleteMany({ lesson: lesson._id }), LessonProgress.deleteMany({ lesson: lesson._id })]);
  ok(res, null, 'Video removed');
}

// ---- progress ----
async function saveProgress(req, res) {
  const b = req.body;
  const lesson = await Lesson.findOne({ _id: b.videoId, published: true });
  if (!lesson) throw notFound('Video not found');
  if (!(await P.isEnrolled(req.user._id, lesson.course))) throw forbidden('Enroll in this course to track your progress');

  const existing = await VideoProgress.findOne({ student: req.user._id, lesson: lesson._id });
  const v = serialize.videoOf(lesson);
  const duration = (v && v.durationSeconds) || b.durationSeconds || (existing && existing.durationSeconds) || 0;
  const position = duration ? Math.min(b.positionSeconds, duration) : b.positionSeconds;
  const completed = Boolean((existing && existing.completed) || b.completed === true || (duration > 0 && position >= duration * 0.95));

  const doc = await VideoProgress.findOneAndUpdate(
    { student: req.user._id, lesson: lesson._id },
    { $set: { course: lesson.course, positionSeconds: position, durationSeconds: duration, completed } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  if (completed) {
    await LessonProgress.updateOne(
      { student: req.user._id, lesson: lesson._id },
      { $setOnInsert: { student: req.user._id, lesson: lesson._id, course: lesson.course, completedAt: new Date() } },
      { upsert: true }
    );
  }
  await User.updateOne({ _id: req.user._id }, { lastLesson: lesson._id });
  ok(res, {
    videoId: String(lesson._id), positionSeconds: doc.positionSeconds, durationSeconds: doc.durationSeconds, completed: doc.completed,
    courseProgress: await P.courseProgress(req.user._id, lesson.course),
  });
}

async function getProgress(req, res) {
  const lesson = await Lesson.findOne({ _id: req.params.videoId, published: true }).select('_id course');
  if (!lesson) throw notFound('Video not found');
  if (!(await P.isEnrolled(req.user._id, lesson.course))) throw forbidden('Enroll in this course to see your progress');
  const p = await VideoProgress.findOne({ student: req.user._id, lesson: lesson._id });
  ok(res, { videoId: String(lesson._id), positionSeconds: p ? p.positionSeconds : 0, durationSeconds: p ? p.durationSeconds : 0, completed: p ? p.completed : false });
}

// What the admin panel needs to build its form.
const options = (_req, res) => ok(res, { providers: providerNames(), defaultProvider: config.video.defaultProvider });

module.exports = { createSchema, updateSchema, progressSchema, listAll, listByCourse, getOne, playback, thumbnail, create, update, remove, saveProgress, getProgress, options };
