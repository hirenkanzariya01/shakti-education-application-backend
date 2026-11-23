const { HttpError } = require('../utils/http');
const { ZodError, formatZod } = require('./validate');
const config = require('../config');

const notFoundHandler = (req, res) => {
  res.status(404).json({ success: false, data: null, message: '', error: `Route not found: ${req.method} ${req.path}` });
};

// eslint-disable-next-line no-unused-vars
const errorHandler = (err, req, res, _next) => {
  let status = 500;
  let message = 'Something went wrong';
  let details;

  if (err instanceof HttpError) {
    status = err.status;
    message = err.message;
    details = err.details;
  } else if (err instanceof ZodError) {
    status = 400;
    const f = formatZod(err);
    message = f.message;
    details = f.fields;
  } else if (err && err.code === 11000) {
    status = 409;
    message = 'That value already exists';
  } else if (err && (err.name === 'CastError' || err.name === 'ValidationError')) {
    status = 400;
    message = 'Invalid data';
  } else if (err && err.type === 'entity.parse.failed') {
    status = 400;
    message = 'Request body is not valid JSON';
  } else if (err && err.type === 'entity.too.large') {
    status = 413;
    message = 'Request body is too large';
  }

  if (status === 500) {
    console.error('[error]', req.method, req.originalUrl, err);
    if (config.isProduction) message = 'Something went wrong';
    else message = err && err.message ? err.message : message;
  }

  res.status(status).json({ success: false, data: null, message: '', error: message, ...(details ? { details } : {}) });
};

module.exports = { notFoundHandler, errorHandler };
