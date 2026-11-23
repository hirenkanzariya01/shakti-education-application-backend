const express = require('express');
const { Media } = require('../models');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { idParams } = require('../middleware/validate');
const { ok, notFound, badRequest, HttpError } = require('../utils/http');

const MAX_BYTES = 300 * 1024;
const TYPES = ['image/jpeg', 'image/png', 'image/webp'];

// Checks the file's real signature, not just the header the client claimed.
function sniff(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length > 12 && buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
}

const admin = express.Router();
admin.post('/', requireAuth, requireAdmin, express.raw({ type: TYPES, limit: MAX_BYTES }), async (req, res) => {
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw badRequest('Send a JPEG, PNG or WebP image (max 300 KB)');
  const type = sniff(req.body);
  if (!type) throw badRequest('That file is not a valid JPEG, PNG or WebP image');
  // Keep images from filling a small (e.g. free 512 MB Atlas) database: refuse uploads past the total cap.
  const capBytes = (Number(process.env.MEDIA_MAX_TOTAL_MB) || 100) * 1024 * 1024;
  const used = (await Media.find({}).select('size').lean()).reduce((n, d) => n + (d.size || 0), 0);
  if (used + req.body.length > capBytes) throw new HttpError(413, 'Image storage is full. Delete unused images or paste an https:// image link instead.');
  const m = await Media.create({ data: req.body, contentType: type, size: req.body.length, uploadedBy: req.user._id });
  ok(res, { id: String(m._id), url: `/api/media/${m._id}` }, 'Image uploaded', 201);
});

// Public on purpose: these are profile photos / logos shown in the app. IDs are random and unguessable.
const pub = express.Router();
pub.get('/:id', idParams('id'), async (req, res) => {
  const m = await Media.findById(req.params.id);
  if (!m) throw notFound('Image not found');
  res.set({ 'Content-Type': m.contentType, 'Cache-Control': 'public, max-age=31536000, immutable', 'Cross-Origin-Resource-Policy': 'cross-origin', 'Content-Security-Policy': "default-src 'none'" });
  res.send(m.data);
});

module.exports = { admin, pub };
