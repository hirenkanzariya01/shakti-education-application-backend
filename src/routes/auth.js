const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const config = require('../config');
const { User } = require('../models');
const { signToken, requireAuth } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { ok, conflict, unauthorized, badRequest } = require('../utils/http');
const serialize = require('../utils/serialize');

const router = express.Router();

const email = z.string().trim().toLowerCase().email('Enter a valid email address').max(120);
const password = z.string().min(8, 'Password must be at least 8 characters').max(72, 'Password is too long');
const phone = z.string().trim().regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit mobile number');
const dob = z
  .string()
  .trim()
  .regex(/^(\d{4}-\d{2}-\d{2})?$/, 'Use the format YYYY-MM-DD')
  .refine((v) => !v || (!isNaN(Date.parse(v)) && new Date(v) <= new Date()), 'Enter a valid date of birth');

// A throwaway hash so a login for an unknown email takes as long as a real one (no account enumeration by timing).
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', config.bcryptRounds);

const registerSchema = z
  .object({ name: z.string().trim().min(2, 'Name must be at least 2 characters').max(80), email, phone, password })
  .strict();
const loginSchema = z.object({ email, password: z.string().min(1, 'Password is required').max(72) }).strict();
const profileSchema = z
  .object({
    name: z.string().trim().min(2).max(80).optional(),
    phone: phone.optional(),
    city: z.string().trim().max(80).optional(),
    dob: dob.optional(),
  })
  .strict();
const changePasswordSchema = z.object({ currentPassword: z.string().min(1).max(72), newPassword: password }).strict();
const forgotSchema = z.object({ email }).strict();
const resetSchema = z.object({ token: z.string().min(20).max(200), password }).strict();

const session = (user) => ({ token: signToken(user), user: serialize.user(user) });

// Students only. The role can never be chosen by the caller.
router.post('/register', validate(registerSchema), async (req, res) => {
  const { name, email: mail, phone: ph, password: pw } = req.body;
  if (await User.exists({ email: mail })) throw conflict('An account with this email already exists');
  const user = await User.create({
    name,
    email: mail,
    phone: ph,
    passwordHash: await bcrypt.hash(pw, config.bcryptRounds),
    role: 'student',
  });
  ok(res, session(user), 'Account created', 201);
});

router.post('/login', validate(loginSchema), async (req, res) => {
  const user = await User.findOne({ email: req.body.email });
  const valid = await bcrypt.compare(req.body.password, user ? user.passwordHash : DUMMY_HASH);
  if (!user || !valid) throw unauthorized('Incorrect email or password');
  if (!user.isActive) throw unauthorized('This account has been deactivated. Please contact the institute.');
  ok(res, session(user), 'Signed in');
});

router.get('/me', requireAuth, (req, res) => ok(res, serialize.user(req.user)));

router.patch('/me', requireAuth, validate(profileSchema), async (req, res) => {
  Object.assign(req.user, req.body);
  await req.user.save();
  ok(res, serialize.user(req.user), 'Profile updated');
});

router.post('/change-password', requireAuth, validate(changePasswordSchema), async (req, res) => {
  const valid = await bcrypt.compare(req.body.currentPassword, req.user.passwordHash);
  if (!valid) throw badRequest('Current password is incorrect');
  req.user.passwordHash = await bcrypt.hash(req.body.newPassword, config.bcryptRounds);
  req.user.tokenVersion += 1; // signs out every other device
  await req.user.save();
  ok(res, session(req.user), 'Password changed');
});

router.post('/logout-all', requireAuth, async (req, res) => {
  req.user.tokenVersion += 1;
  await req.user.save();
  ok(res, null, 'Signed out everywhere');
});

// Password reset. No email service is configured, so the reset token is only logged on the server
// outside production, and an admin can set a temporary password from the admin panel instead.
// The response is identical whether or not the account exists.
router.post('/forgot-password', validate(forgotSchema), async (req, res) => {
  const user = await User.findOne({ email: req.body.email });
  let devToken;
  if (user && user.isActive) {
    const token = crypto.randomBytes(32).toString('hex');
    user.resetTokenHash = crypto.createHash('sha256').update(token).digest('hex');
    user.resetTokenExpires = new Date(Date.now() + 30 * 60 * 1000);
    await user.save();
    if (!config.isProduction) console.log(`[password-reset] token for ${user.email}: ${token}`);
    if (config.env === 'test') devToken = token;
  }
  ok(
    res,
    devToken ? { devToken } : null,
    'If an account exists for that email, reset instructions will be provided by the institute.'
  );
});

router.post('/reset-password', validate(resetSchema), async (req, res) => {
  const hash = crypto.createHash('sha256').update(req.body.token).digest('hex');
  const user = await User.findOne({ resetTokenHash: hash, resetTokenExpires: { $gt: new Date() } });
  if (!user) throw badRequest('This reset link is invalid or has expired');
  user.passwordHash = await bcrypt.hash(req.body.password, config.bcryptRounds);
  user.resetTokenHash = null;
  user.resetTokenExpires = null;
  user.tokenVersion += 1;
  await user.save();
  ok(res, null, 'Password updated. You can sign in now.');
});

module.exports = router;
