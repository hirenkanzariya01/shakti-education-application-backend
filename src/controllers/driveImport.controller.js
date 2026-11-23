const { z } = require('zod');
const importer = require('../services/driveImport.service');
const { Course } = require('../models');
const { ok } = require('../utils/http');

const oid = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id');
const driveId = z.string().trim().regex(/^[A-Za-z0-9_-]{10,100}$/, 'Invalid Google Drive folder id');

const importSchema = z.object({ courseId: oid, folderId: driveId, publish: z.boolean().default(true) }).strict();

async function folders(req, res) {
  const parent = req.query.parent ? driveId.parse(String(req.query.parent)) : undefined;
  const out = await importer.listFolders(parent);
  // When asked for a course, also say which Drive folder it was imported from last time.
  if (req.query.courseId) {
    const course = await Course.findById(oid.parse(String(req.query.courseId))).select('driveFolderId');
    out.savedFolderId = course ? course.driveFolderId || '' : '';
  }
  ok(res, out);
}
async function preview(req, res) {
  const courseId = oid.parse(String(req.query.courseId || ''));
  const folderId = driveId.parse(String(req.query.folderId || ''));
  ok(res, await importer.preview(courseId, folderId));
}
async function doImport(req, res) {
  const r = await importer.importFolder(req.body.courseId, req.body.folderId, { publish: req.body.publish });
  ok(res, r, `Imported ${r.lecturesCreated} lecture${r.lecturesCreated === 1 ? '' : 's'} in ${r.modulesCreated} new module${r.modulesCreated === 1 ? '' : 's'}`);
}
module.exports = { importSchema, folders, preview, doImport };
