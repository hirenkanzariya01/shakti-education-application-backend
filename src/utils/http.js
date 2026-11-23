const mongoose = require('mongoose');

// Every response uses the same envelope the mobile app already expects:
//   { success, data, message, error }
class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const ok = (res, data = null, message = '', status = 200) =>
  res.status(status).json({ success: true, data, message, error: null });

const badRequest = (msg, details) => new HttpError(400, msg, details);
const unauthorized = (msg = 'Please sign in to continue') => new HttpError(401, msg);
const forbidden = (msg = 'You do not have permission to do this') => new HttpError(403, msg);
const notFound = (msg = 'Not found') => new HttpError(404, msg);
const conflict = (msg) => new HttpError(409, msg);

const isId = (v) => mongoose.isValidObjectId(v) && String(v).length === 24;

// Escapes user text before it is used inside a RegExp (prevents regex injection / ReDoS patterns).
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

module.exports = { HttpError, ok, badRequest, unauthorized, forbidden, notFound, conflict, isId, escapeRegex };
