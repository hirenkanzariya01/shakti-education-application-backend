const { ZodError } = require('zod');
const { badRequest, isId } = require('../utils/http');

// validate(schema) parses req.body with zod; unknown fields are rejected by `.strict()` schemas.
const validate = (schema) => (req, _res, next) => {
  req.body = schema.parse(req.body === undefined ? {} : req.body);
  next();
};

// Ensures :id style params are valid ObjectIds before they reach the database.
const idParams = (...names) => (req, _res, next) => {
  for (const name of names) {
    if (!isId(req.params[name])) throw badRequest(`Invalid ${name}`);
  }
  next();
};

const formatZod = (err) => {
  const fields = {};
  err.issues.forEach((i) => {
    const key = i.path.join('.') || 'body';
    if (!fields[key]) fields[key] = i.message;
  });
  const first = err.issues[0];
  const where = first.path.length ? `${first.path.join('.')}: ` : '';
  return { message: `${where}${first.message}`, fields };
};

module.exports = { validate, idParams, formatZod, ZodError };
