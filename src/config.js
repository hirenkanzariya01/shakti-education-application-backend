require('dotenv').config({ quiet: true }); // quiet: dotenv's banner must not pollute stdout

const env = process.env.NODE_ENV || 'development';
const isProduction = env === 'production';

// "false", "False", "FALSE", "0", "no", "off" all mean false; "true", "1", "yes", "on" mean true; empty/unknown = fallback.
function parseFlag(value, fallback) {
  const v = String(value == null ? '' : value).trim().toLowerCase();
  if (['false', '0', 'no', 'off'].includes(v)) return false;
  if (['true', '1', 'yes', 'on'].includes(v)) return true;
  return fallback;
}

const config = {
  env,
  isProduction,
  port: Number(process.env.PORT) || 4000,
  mongoUri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/shakti',
  jwtSecret: process.env.JWT_SECRET || '',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  // Comma separated list of allowed browser origins (the admin panel). Mobile apps do not send an Origin.
  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  // If false, only admins can enroll students (students see and open only the courses the institute gave them).
  // Default: ON in development (demo), OFF in production. Set SELF_ENROLLMENT=true/false to override.
  selfEnrollment: parseFlag(process.env.SELF_ENROLLMENT, process.env.NODE_ENV !== 'production'),
  rateLimitEnabled: process.env.RATE_LIMIT !== 'off',
  bcryptRounds: Number(process.env.BCRYPT_ROUNDS) || 10,
  video: { defaultProvider: process.env.VIDEO_PROVIDER || 'google-drive' },
  google: loadGoogle(),
};

// Google Drive access is backend-only. Either GOOGLE_SERVICE_ACCOUNT_JSON (whole key file, handy for Secret Manager)
// or the email + private key pair. Only a short-lived access token is ever sent to the mobile app.
// Accepts the key however it was pasted: with quotes, literal \n, real newlines, or all on one line with spaces.
// Returns a clean PEM, or the cleaned input unchanged when it does not look like a key (validated later with a clear error).
function normalizePrivateKey(raw) {
  let k = String(raw || '').trim().replace(/^['"]|['"]$/g, '').replace(/\\n/g, '\n').replace(/\r/g, '');
  const m = k.match(/-----BEGIN ([A-Z ]*PRIVATE KEY)-----([\s\S]*?)-----END \1-----/);
  if (!m) return k;
  const body = m[2].replace(/[^A-Za-z0-9+/=]/g, '');
  return `-----BEGIN ${m[1]}-----\n${body.match(/.{1,64}/g).join('\n')}\n-----END ${m[1]}-----\n`;
}

function loadGoogle() {
  let email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '';
  let privateKey = process.env.GOOGLE_PRIVATE_KEY || '';
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    try {
      const json = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
      email = json.client_email || email;
      privateKey = json.private_key || privateKey;
    } catch (e) {
      throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON.');
    }
  }
  return {
    serviceAccountEmail: email,
    privateKey: normalizePrivateKey(privateKey),
    // Recommended: only files inside this Drive folder may be registered as videos.
    rootFolderId: process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID || '',
    // Playback tokens handed to students always have at least this many seconds left.
    minTokenTtlSeconds: Number(process.env.GOOGLE_PLAYBACK_MIN_TTL) || 600,
  };
}


// Fail fast on an unsafe secret instead of silently running insecurely.
if (!config.jwtSecret || config.jwtSecret.length < 32) {
  if (isProduction) {
    throw new Error('JWT_SECRET must be set to a random string of at least 32 characters in production.');
  }
  // Development/test convenience only. Never used in production because of the check above.
  config.jwtSecret = 'dev-only-secret-change-me-dev-only-secret-change-me';
  if (env !== 'test') console.warn('[config] Using an insecure development JWT secret. Set JWT_SECRET in .env.');
}

module.exports = config;
