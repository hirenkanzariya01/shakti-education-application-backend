process.env.NODE_ENV = 'test';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../src/config');
const drive = require('../src/services/googleDrive.service');
const video = require('../src/services/video.service');

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const FILE = 'abcDEF1234567890_-xyz';
let calls;

// A tiny fake of Google's token + Drive endpoints.
function fakeGoogle({ files = {}, tokenStatus = 200, expiresIn = 3599, driveStatus = null } = {}) {
  calls = [];
  drive._setFetch(async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    const u = String(url);
    const json = (status, body) => ({ ok: status < 400, status, json: async () => body, headers: new Map([['content-type', 'image/jpeg']]), arrayBuffer: async () => Buffer.from('img') });
    if (u.startsWith('https://oauth2.googleapis.com/token')) {
      return tokenStatus === 200 ? json(200, { access_token: `tok-${calls.length}`, expires_in: expiresIn }) : json(tokenStatus, { error: 'invalid_grant', secret: 'LEAK' });
    }
    if (driveStatus) return json(driveStatus, {});
    if (u.startsWith('https://lh3.example/thumb')) return json(200, {});
    const m = u.match(/\/drive\/v3\/files\/([^?]+)\?(.*)/);
    if (m) { const f = files[m[1]]; return f ? json(200, f) : json(404, {}); }
    return json(500, {});
  });
}

beforeEach(() => {
  drive._reset();
  config.google.serviceAccountEmail = 'sa@proj.iam.gserviceaccount.com';
  config.google.privateKey = privateKey;
  config.google.rootFolderId = '';
  config.google.minTokenTtlSeconds = 600;
});

test('token exchange signs a valid RS256 JWT for the read-only scope and caches the token', async () => {
  fakeGoogle();
  const a = await drive.getAccessToken();
  const b = await drive.getAccessToken();
  assert.equal(a.accessToken, b.accessToken);
  assert.equal(calls.filter((c) => c.url.includes('oauth2')).length, 1); // cached
  const body = new URLSearchParams(calls[0].opts.body);
  assert.equal(body.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  const claims = jwt.verify(body.get('assertion'), publicKey, { algorithms: ['RS256'] });
  assert.equal(claims.iss, 'sa@proj.iam.gserviceaccount.com');
  assert.equal(claims.scope, 'https://www.googleapis.com/auth/drive.readonly');
  assert.equal(claims.aud, 'https://oauth2.googleapis.com/token');
});

test('concurrent requests share one token exchange; near-expiry tokens are refreshed', async () => {
  fakeGoogle({ expiresIn: 3599 });
  await Promise.all([drive.getAccessToken(), drive.getAccessToken(), drive.getAccessToken()]);
  assert.equal(calls.filter((c) => c.url.includes('oauth2')).length, 1);
  drive._reset(); fakeGoogle({ expiresIn: 300 }); // only 5 minutes left < 10 minute minimum for students
  await drive.getPlaybackAccess(FILE);
  await drive.getPlaybackAccess(FILE);
  assert.equal(calls.filter((c) => c.url.includes('oauth2')).length, 2);
});

test('credential failures never leak Google response bodies or the key', async () => {
  fakeGoogle({ tokenStatus: 400 });
  await assert.rejects(drive.getAccessToken(), (e) => e.status === 502 && !/LEAK|PRIVATE KEY/.test(e.message));
});

test('not configured -> clear 503; bad file ids rejected before any network call', async () => {
  config.google.privateKey = '';
  fakeGoogle();
  await assert.rejects(drive.getAccessToken(), (e) => e.status === 503);
  for (const bad of ['', 'short', '../../etc/passwd', 'a'.repeat(20) + '?x=1', 'abc def ghi jkl']) {
    await assert.rejects(drive.getFileMetadata(bad), (e) => e.status === 400, bad);
  }
  assert.equal(calls.length, 0);
});

test('parseFileId accepts ids and common Drive links only', () => {
  assert.equal(drive.parseFileId(FILE), FILE);
  assert.equal(drive.parseFileId(`https://drive.google.com/file/d/${FILE}/view?usp=sharing`), FILE);
  assert.equal(drive.parseFileId(`https://drive.google.com/open?id=${FILE}`), FILE);
  assert.equal(drive.parseFileId('https://evil.example/file/d/' + FILE), null);
  assert.equal(drive.parseFileId('<script>'), null);
});

test('metadata is normalised; 404/403/429 map to clear errors', async () => {
  fakeGoogle({ files: { [FILE]: { id: FILE, name: 'Lecture 1.mp4', mimeType: 'video/mp4', size: '1048576', parents: ['P1'], thumbnailLink: 'https://lh3.example/thumb=s220', videoMediaMetadata: { durationMillis: '754000', width: 1920, height: 1080 } } } });
  const m = await drive.getFileMetadata(FILE);
  assert.deepEqual([m.name, m.durationSeconds, m.sizeBytes, m.height], ['Lecture 1.mp4', 754, 1048576, 1080]);
  await assert.rejects(drive.getFileMetadata('zzzzzzzzzzzzzzzzzzzz'), (e) => e.status === 404 && /shared with the service account/.test(e.message));
  drive._reset(); fakeGoogle({ driveStatus: 403 });
  await assert.rejects(drive.getFileMetadata(FILE), (e) => e.status === 503);
  drive._reset(); fakeGoogle({ driveStatus: 429 });
  await assert.rejects(drive.getFileMetadata(FILE), (e) => e.status === 503);
});

test('network failure -> 502', async () => {
  drive._setFetch(async () => { throw new Error('ECONNRESET'); });
  await assert.rejects(drive.getAccessToken(), (e) => e.status === 502);
});

test('root folder restriction walks parents; outside files are rejected', async () => {
  config.google.rootFolderId = 'ROOTFOLDER123';
  fakeGoogle({ files: {
    [FILE]: { id: FILE, name: 'a.mp4', mimeType: 'video/mp4', parents: ['SUBFOLDER_AAA'], videoMediaMetadata: { durationMillis: '1000' } },
    SUBFOLDER_AAA: { parents: ['ROOTFOLDER123'] },
    OUTSIDE_FILE_1: { id: 'OUTSIDE_FILE_1', name: 'b.mp4', mimeType: 'video/mp4', parents: ['OTHER_FOLDER_1'], videoMediaMetadata: { durationMillis: '1000' } },
    OTHER_FOLDER_1: { parents: [] },
  } });
  const gd = require('../src/services/providers/googleDrive.provider');
  assert.equal((await gd.describe(FILE)).ref, FILE);
  await assert.rejects(gd.describe('OUTSIDE_FILE_1'), (e) => e.status === 400 && /outside/.test(e.message));
});

test('provider describe: rejects non-video/trashed, warns on odd formats and unprocessed videos', async () => {
  const gd = require('../src/services/providers/googleDrive.provider');
  fakeGoogle({ files: {
    DOCUMENT_FILE_01: { id: 'DOCUMENT_FILE_01', name: 'x.pdf', mimeType: 'application/pdf' },
    TRASHED_FILE_001: { id: 'TRASHED_FILE_001', name: 'x.mp4', mimeType: 'video/mp4', trashed: true },
    MKV_FILE_0000001: { id: 'MKV_FILE_0000001', name: 'x.mkv', mimeType: 'video/x-matroska', videoMediaMetadata: { durationMillis: '5000' } },
    PROCESSING_FILE1: { id: 'PROCESSING_FILE1', name: 'x.mp4', mimeType: 'video/mp4' },
  } });
  await assert.rejects(gd.describe('DOCUMENT_FILE_01'), (e) => /not a video/.test(e.message));
  await assert.rejects(gd.describe('TRASHED_FILE_001'), (e) => /trash/.test(e.message));
  assert.match((await gd.describe('MKV_FILE_0000001')).warnings[0], /may not play/);
  assert.match((await gd.describe('PROCESSING_FILE1')).warnings[0], /processing/);
});

test('video.service: builds refs, returns playback with a bearer header, hides nothing it should not', async () => {
  fakeGoogle({ files: { [FILE]: { id: FILE, name: 'L1.mp4', mimeType: 'video/mp4', size: '99', videoMediaMetadata: { durationMillis: '60000' } } } });
  const { video: v, warnings } = await video.buildVideoRef({ provider: 'google-drive', source: `https://drive.google.com/file/d/${FILE}/view` });
  assert.deepEqual([v.provider, v.ref, v.durationSeconds, warnings.length], ['google-drive', FILE, 60, 0]);
  const pb = await video.getPlayback(v);
  assert.equal(pb.type, 'progressive');
  assert.match(pb.url, new RegExp(`/files/${FILE}\\?alt=media`));
  assert.match(pb.headers.Authorization, /^Bearer tok-/);
  assert.ok(new Date(pb.expiresAt) > new Date(Date.now() + 600 * 1000));
  assert.ok(!JSON.stringify(pb).includes('PRIVATE'));
  await assert.rejects(video.getPlayback(null), (e) => e.status === 404);
  await assert.rejects(video.buildVideoRef({ provider: 'nope', source: 'x' }), (e) => e.status === 400);
});

test('link provider (future/other providers plug in the same way)', async () => {
  const hls = await video.getPlayback({ provider: 'link', ref: 'https://cdn.example/v/master.m3u8' });
  assert.equal(hls.type, 'hls');
  assert.equal((await video.getPlayback({ provider: 'link', ref: 'https://cdn.example/v.mp4' })).type, 'progressive');
  await assert.rejects(video.buildVideoRef({ provider: 'link', source: 'http://insecure.example/v.mp4' }), (e) => e.status === 400);
  await assert.rejects(video.buildVideoRef({ provider: 'link', source: 'javascript:alert(1)' }), (e) => e.status === 400);
});

test('thumbnail proxy returns a small image buffer', async () => {
  fakeGoogle({ files: { [FILE]: { thumbnailLink: 'https://lh3.example/thumb=s220' } } });
  const t = await drive.getThumbnail(FILE);
  assert.equal(t.contentType, 'image/jpeg');
  assert.ok(calls.some((c) => c.url.endsWith('=s480')));
});
