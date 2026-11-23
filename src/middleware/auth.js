const jwt = require('jsonwebtoken');
const config = require('../config');
const { User } = require('../models');
const { unauthorized, forbidden } = require('../utils/http');

const signToken = (user) =>
  jwt.sign({ sub: String(user._id), role: user.role, v: user.tokenVersion }, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn,
    algorithm: 'HS256',
  });

const userCache = require('../utils/userCache');
async function cachedUser(id) {
  const hit = userCache.get(id);
  if (hit) return User.hydrate(hit);
  const raw = await User.findById(String(id)).lean();
  if (!raw) { userCache.drop(id); return null; }
  userCache.set(id, raw);
  return User.hydrate(raw);
}

async function requireAuth(req, _res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) throw unauthorized();

  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
  } catch (e) {
    throw unauthorized('Your session has expired. Please sign in again.');
  }

  // The user is re-checked on every request (deactivated accounts and revoked tokens must stop working), but from a
  // 15-second in-process cache so a busy app does not pay a database round trip per call. Saving or deleting a user
  // clears their entry at once (see models/User.js); the ceiling is only for changes made by another server instance.
  const user = await cachedUser(payload.sub);
  if (!user || !user.isActive || user.tokenVersion !== payload.v) {
    throw unauthorized('Your session is no longer valid. Please sign in again.');
  }
  req.user = user;
  next();
}

// For public endpoints that show more to signed-in admins. A bad or missing token simply means "anonymous".
async function optionalAuth(req, res, next) {
  if (!req.headers.authorization) return next();
  try {
    await requireAuth(req, res, () => {});
  } catch (e) {
    req.user = undefined;
  }
  next();
}

const requireRole = (role) => (req, _res, next) => {
  if (!req.user || req.user.role !== role) throw forbidden();
  next();
};

module.exports = { signToken, requireAuth, optionalAuth, requireAdmin: requireRole('admin') };
