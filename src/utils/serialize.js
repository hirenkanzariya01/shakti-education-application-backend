// Converts database documents to the JSON shapes the mobile app already uses.
const idOf = (v) => (v && v._id ? String(v._id) : v ? String(v) : null);

const user = (u) => ({
  id: String(u._id),
  name: u.name,
  email: u.email,
  phone: u.phone || '',
  city: u.city || '',
  dob: u.dob || '',
  avatar: u.avatarUrl || null,
  role: u.role,
  isActive: u.isActive,
  joinedOn: u.createdAt ? new Date(u.createdAt).toISOString().slice(0, 10) : '',
});

// `course.category` must be populated with { name }.
const course = (c) => ({
  id: String(c._id),
  title: c.title,
  categoryId: idOf(c.category),
  category: c.category && c.category.name ? c.category.name : '',
  icon: c.icon,
  imageKey: c.imageKey || '',
  imageUrl: c.imageUrl || '',
  shortDescription: c.shortDescription,
  description: c.description,
  duration: c.duration,
  level: c.level,
  fee: c.fee,
  instructor: c.instructor,
  rating: c.rating,
  studentsEnrolled: c.studentsEnrolled,
  syllabus: c.syllabus || [],
  published: c.published,
});

const category = (c, courseCount) => ({
  id: String(c._id),
  name: c.name,
  icon: c.icon,
  order: c.order,
  ...(courseCount !== undefined ? { courseCount } : {}),
});

// videoUrl is only revealed to enrolled students (or admins).
const lesson = (l, { completed = false, completedAt = null, showVideo = false } = {}) => ({
  id: String(l._id),
  courseId: idOf(l.course),
  order: l.order,
  title: l.title,
  duration: l.duration,
  description: l.description,
  videoUrl: showVideo ? l.videoUrl : '',
  // Newer fields (the app plays video through /api/videos/:id/playback, which checks enrollment).
  hasVideo: Boolean(videoOf(l)),
  moduleId: l.module ? idOf(l.module) : null,
  durationSeconds: (videoOf(l) && videoOf(l).durationSeconds) || 0,
  thumbnailUrl: videoOf(l) ? videoOf(l).thumbnailUrl || (videoOf(l).hasThumbnail ? `/api/videos/${l._id}/thumbnail` : '') : '',
  published: l.published,
  completed,
  completedAt,
});

const liveStatus = (startsAt, durationMinutes, now = Date.now()) => {
  const start = new Date(startsAt).getTime();
  const end = start + durationMinutes * 60000;
  if (now >= end) return 'completed';
  if (now >= start) return 'live';
  return 'upcoming';
};

// meetingUrl is deliberately NOT included; students get it from the /join endpoint.
const liveClass = (l, { includeUrl = false } = {}) => ({
  id: String(l._id),
  courseId: idOf(l.course),
  courseTitle: l.course && l.course.title ? l.course.title : '',
  title: l.title,
  instructor: l.instructor,
  startsAt: new Date(l.startsAt).toISOString(),
  durationMinutes: l.durationMinutes,
  description: l.description,
  status: liveStatus(l.startsAt, l.durationMinutes),
  ...(includeUrl ? { meetingUrl: l.meetingUrl } : {}),
});

const payment = (p) => ({
  id: String(p._id),
  studentId: idOf(p.student),
  studentName: p.student && p.student.name ? p.student.name : undefined,
  courseId: idOf(p.course),
  courseTitle: p.course && p.course.title ? p.course.title : '',
  title: p.title,
  amount: p.amount,
  // The app shows one date: when it was paid, or the due date while pending.
  date: new Date(p.paidAt || p.dueDate).toISOString(),
  dueDate: new Date(p.dueDate).toISOString(),
  paidAt: p.paidAt ? new Date(p.paidAt).toISOString() : null,
  method: p.method,
  status: p.status,
  receiptNo: p.receiptNo,
  simulated: false,
});

const certificate = (c) => ({
  id: String(c._id),
  studentId: idOf(c.student),
  studentName: c.student && c.student.name ? c.student.name : '',
  courseId: idOf(c.course),
  courseTitle: c.course && c.course.title ? c.course.title : '',
  duration: c.course && c.course.duration ? c.course.duration : '',
  title: c.title,
  certificateNo: c.certificateNo,
  grade: c.grade,
  issuedOn: new Date(c.issuedOn).toISOString().slice(0, 10),
  isSample: c.isSample,
  disclaimer: c.isSample ? 'Sample certificate for demonstration only. Not an official document.' : '',
});

const placement = (p, interested = false) => ({
  id: String(p._id),
  company: p.company,
  role: p.role,
  location: p.location,
  type: p.type,
  salaryRange: p.salaryRange,
  openings: p.openings,
  deadline: new Date(p.deadline).toISOString().slice(0, 10),
  relatedCourseId: idOf(p.relatedCourse),
  description: p.description,
  requirements: p.requirements || [],
  isSample: p.isSample,
  interested,
});

const notification = (n, read = false) => ({
  id: String(n._id),
  title: n.title,
  message: n.message,
  type: n.type,
  studentId: idOf(n.student),
  createdAt: new Date(n.createdAt).toISOString(),
  read,
});

const banner = (b) => ({
  id: String(b._id),
  title: b.title,
  subtitle: b.subtitle,
  cta: b.cta,
  target: b.target,
  icon: b.icon,
  imageKey: b.imageKey || '',
  imageUrl: b.imageUrl || '',
  order: b.order,
  active: b.active,
});

// ---- video / review / placed-student serializers ----
const MEDIA_OR_HTTPS = /^(https:\/\/\S+|\/api\/media\/[a-f\d]{24})$/i;

// Lessons created before the video feature only have `videoUrl`; treat that as a 'link' video.
const videoOf = (l) => {
  const v = (l.video && l.video.ref && l.video.provider && l.video) || null;
  if (v) return v;
  if (l.videoUrl) return { provider: 'link', ref: l.videoUrl, mimeType: '', durationSeconds: 0, hasThumbnail: false, thumbnailUrl: '' };
  return null;
};

const clock = (sec) => {
  const s = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const mm = String(m).padStart(h ? 2 : 1, '0');
  return `${h ? `${h}:` : ''}${mm}:${String(r).padStart(2, '0')}`;
};

// Never includes the provider reference (Drive file ID) unless `admin` is set.
const video = (l, { progress = null, locked = false, admin = false } = {}) => {
  const v = videoOf(l);
  const id = String(l._id);
  const duration = v ? v.durationSeconds || 0 : 0;
  return {
    id,
    courseId: idOf(l.course),
    moduleId: l.module ? idOf(l.module) : null,
    order: l.order,
    title: l.title,
    description: l.description,
    hasVideo: Boolean(v),
    provider: v ? v.provider : '',
    durationSeconds: duration,
    duration: duration ? clock(duration) : l.duration || '',
    thumbnailUrl: v ? v.thumbnailUrl || (v.hasThumbnail ? `/api/videos/${id}/thumbnail` : '') : '',
    isPublished: l.published,
    locked,
    progress: {
      positionSeconds: progress ? progress.positionSeconds : 0,
      completed: progress ? progress.completed : false,
      percent: progress && duration ? Math.min(100, Math.round((progress.positionSeconds / duration) * 100)) : progress && progress.completed ? 100 : 0,
    },
    ...(admin && v ? { source: { provider: v.provider, ref: v.ref, mimeType: v.mimeType, sizeBytes: v.sizeBytes || 0 } } : {}),
  };
};

const review = (r, { includeStatus = false } = {}) => {
  const s = r.student && r.student.name ? r.student : null;
  const c = r.course && r.course.title ? r.course : null;
  const p = r.placementInfo || {};
  return {
    id: String(r._id),
    studentName: s ? s.name : 'Student',
    profileImage: s ? s.avatarUrl || '' : '',
    courseId: idOf(r.course),
    courseName: c ? c.title : '',
    rating: r.rating,
    review: r.review,
    placementInfo: p.company || p.role ? { company: p.company, role: p.role } : null,
    createdAt: r.createdAt,
    ...(includeStatus ? { approvalStatus: r.approvalStatus, studentId: idOf(r.student) } : {}),
  };
};

const placedStudent = (p, { admin = false } = {}) => ({
  id: String(p._id),
  studentName: p.studentName,
  profileImage: p.profileImage,
  companyName: p.companyName,
  companyLogo: p.companyLogo,
  designation: p.designation,
  courseName: p.courseName,
  placementYear: p.placementYear,
  ...(admin ? { verificationStatus: p.verificationStatus, isPublished: p.isPublished, studentId: p.student ? idOf(p.student) : null } : {}),
});

module.exports = { MEDIA_OR_HTTPS, videoOf, video, review, placedStudent, user, course, category, lesson, liveClass, liveStatus, payment, certificate, placement, notification, banner };
