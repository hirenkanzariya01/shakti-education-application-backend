// Turns a Google Drive folder tree into course modules and lectures:
//   <course folder> / <subject folder> / <video files>   ->   Module "<subject>" with one lecture per video
// Videos placed directly in the course folder become lectures without a module.
// Only references (Drive file IDs) are stored. Importing again only adds what is new (safe to run repeatedly).
const drive = require('./googleDrive.service');
const { Course, Module, Lesson } = require('../models');
const { HttpError } = require('../utils/http');

const MAX_DEPTH = 3; // subject folder, plus two levels of sub-folders (named "Subject / Sub")
const MAX_VIDEOS = 600; // safety limit for one import
const PLAYS_NATIVELY = /^video\/(mp4|quicktime|x-m4v)$/;

const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
const cleanTitle = (name) => String(name).replace(/\.[a-z0-9]{2,4}$/i, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140) || 'Untitled lecture';
const clock = (sec) => {
  const s = Math.round(sec || 0); if (!s) return '';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
};

// Reads the folder tree. Returns { folder, groups: [{ title, videos: [...] }], skipped: [{ name, reason }], totalVideos }.
async function scan(folderId) {
  const folder = await drive.getFolder(folderId);
  const groups = [];
  const skipped = [];
  let total = 0;

  const walk = async (id, titlePath, depth) => {
    const children = await drive.listChildren(id);
    const videos = [];
    for (const f of children.filter((c) => !c.isFolder).sort((a, b) => natural(a.name, b.name))) {
      if (!/^video\//.test(f.mimeType)) { skipped.push({ name: titlePath ? `${titlePath} / ${f.name}` : f.name, reason: 'Not a video file' }); continue; }
      total += 1;
      if (total > MAX_VIDEOS) throw new HttpError(400, `This folder has more than ${MAX_VIDEOS} videos. Import a smaller folder.`);
      videos.push({
        fileId: f.id, name: f.name, title: cleanTitle(f.name), mimeType: f.mimeType, sizeBytes: f.sizeBytes, durationSeconds: f.durationSeconds, hasThumbnail: f.hasThumbnail,
        warning: !PLAYS_NATIVELY.test(f.mimeType) ? 'This format may not play in the app. Convert it to MP4 (H.264/AAC).' : (!f.durationSeconds ? 'Google is still processing this video.' : ''),
      });
    }
    if (videos.length) groups.push({ title: titlePath, videos });
    const folders = children.filter((c) => c.isFolder).sort((a, b) => natural(a.name, b.name));
    for (const sub of folders) {
      if (depth >= MAX_DEPTH) { skipped.push({ name: `${titlePath ? `${titlePath} / ` : ''}${sub.name}`, reason: 'Folder is nested too deeply' }); continue; }
      await walk(sub.id, titlePath ? `${titlePath} / ${sub.name}` : sub.name, depth + 1);
    }
  };
  await walk(folder.id, '', 0);
  // Videos directly in the course folder (title '') come first, then subjects in name order (already sorted).
  groups.sort((a, b) => (a.title === '' ? -1 : b.title === '' ? 1 : 0));
  return { folder, groups, skipped, totalVideos: total };
}

async function existingRefs(courseId) {
  const lessons = await Lesson.find({ course: courseId, 'video.provider': 'google-drive' }).select('video.ref');
  return new Set(lessons.map((l) => l.video.ref));
}

// What an import would do, without changing anything.
async function preview(courseId, folderId) {
  const course = await Course.findById(courseId).select('title driveFolderId');
  if (!course) throw new HttpError(404, 'Course not found');
  const s = await scan(folderId);
  const have = await existingRefs(courseId);
  const groups = s.groups.map((g) => ({ title: g.title || '(no subject folder)', videos: g.videos.map((v) => ({ ...v, alreadyImported: have.has(v.fileId) })) }));
  const flat = groups.flatMap((g) => g.videos);
  return { course: { id: course.id, title: course.title, savedFolderId: course.driveFolderId || '' }, folder: s.folder, groups, skipped: s.skipped,
    totals: { videos: flat.length, newVideos: flat.filter((v) => !v.alreadyImported).length, alreadyImported: flat.filter((v) => v.alreadyImported).length, subjects: groups.filter((g) => g.title !== '(no subject folder)').length } };
}

// Creates the modules and lectures that do not exist yet, and remembers the folder for this course.
async function importFolder(courseId, folderId, { publish = true } = {}) {
  const course = await Course.findById(courseId);
  if (!course) throw new HttpError(404, 'Course not found');
  const s = await scan(folderId);
  const have = await existingRefs(courseId);
  const modules = await Module.find({ course: courseId }).sort({ order: 1 });
  const byTitle = new Map(modules.map((m) => [m.title.trim().toLowerCase(), m]));
  let nextModuleOrder = modules.reduce((n, m) => Math.max(n, m.order), 0) + 1;
  const last = await Lesson.findOne({ course: courseId }).sort({ order: -1 }).select('order');
  let nextOrder = last ? last.order + 1 : 1;
  const out = { modulesCreated: 0, lecturesCreated: 0, alreadyImported: 0, skipped: s.skipped, warnings: [] };

  for (const g of s.groups) {
    let mod = null;
    if (g.title) {
      mod = byTitle.get(g.title.trim().toLowerCase());
      if (!mod) {
        mod = await Module.create({ course: courseId, title: g.title.slice(0, 120), order: nextModuleOrder, published: publish });
        nextModuleOrder += 1; byTitle.set(g.title.trim().toLowerCase(), mod); out.modulesCreated += 1;
      }
    }
    for (const v of g.videos) {
      if (have.has(v.fileId)) { out.alreadyImported += 1; continue; }
      await Lesson.create({
        course: courseId, module: mod ? mod._id : null, order: nextOrder, title: v.title, description: '', duration: clock(v.durationSeconds),
        video: { provider: 'google-drive', ref: v.fileId, mimeType: v.mimeType, durationSeconds: v.durationSeconds, sizeBytes: v.sizeBytes, hasThumbnail: v.hasThumbnail },
        published: publish,
      });
      nextOrder += 1; have.add(v.fileId); out.lecturesCreated += 1;
      if (v.warning) out.warnings.push(`${v.title}: ${v.warning}`);
    }
  }
  course.driveFolderId = folderId;
  await course.save();
  return out;
}

// The sub-folders of the root video folder (or of any folder inside it): used to pick a course's folder.
async function listFolders(parentId) {
  const root = require('../config').google.rootFolderId;
  const parent = parentId || root;
  if (!parent) throw new HttpError(400, 'Set GOOGLE_DRIVE_ROOT_FOLDER_ID on the server first (the Drive folder that contains your course folders).');
  const folder = await drive.getFolder(parent);
  const items = (await drive.listChildren(folder.id)).filter((c) => c.isFolder).sort((a, b) => natural(a.name, b.name));
  return { folder, folders: items.map((f) => ({ id: f.id, name: f.name })) };
}

module.exports = { scan, preview, importFolder, listFolders };
