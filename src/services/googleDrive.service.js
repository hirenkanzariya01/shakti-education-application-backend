// Google Drive access using a SERVICE ACCOUNT (no user login, no refresh tokens to leak).
//
// How it works: we sign a short JWT with the service account's private key and exchange it at Google for an
// access token that lasts about an hour. The private key never leaves this server. The mobile app only ever
// receives the resulting access token, scoped read-only, and only after we verified the student's enrollment.
//
// Containment: a service account can only see files/folders that were explicitly shared with its e-mail address,
// so share ONLY your video folder with it. That limits what a leaked one-hour token can read.
const jwt = require('jsonwebtoken');
const config = require('../config');
const { HttpError } = require('../utils/http');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const FILE_ID = /^[A-Za-z0-9_-]{10,100}$/;
const TIMEOUT_MS = 10000;

let fetchImpl = (...args) => fetch(...args);
let cache = { token: null, expiresAt: 0, inflight: null };
const parentCache = new Map(); // fileId -> parents[]; folder structure rarely changes, short TTL below

// Test hooks.
const _setFetch = (fn) => { fetchImpl = fn; };
const _reset = () => { cache = { token: null, expiresAt: 0, inflight: null }; parentCache.clear(); };

const isConfigured = () => Boolean(config.google.serviceAccountEmail && config.google.privateKey);

function assertConfigured() {
  if (!isConfigured()) {
    throw new HttpError(503, 'Google Drive is not configured on the server. Set the GOOGLE_* environment variables.');
  }
}

function assertFileId(fileId) {
  if (typeof fileId !== 'string' || !FILE_ID.test(fileId)) throw new HttpError(400, 'Invalid Google Drive file ID');
  return fileId;
}

async function googleFetch(url, options = {}) {
  try {
    return await fetchImpl(url, { ...options, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    throw new HttpError(502, 'Could not reach Google Drive. Please try again.');
  }
}

function assertUsableKey() {
  try {
    const k = require('crypto').createPrivateKey(config.google.privateKey);
    if (k.asymmetricKeyType !== 'rsa') throw new Error('not rsa');
  } catch (e) {
    throw new HttpError(503, 'The Google private key in the server settings is not valid. Paste the "private_key" value from the service-account JSON file exactly (it starts with -----BEGIN PRIVATE KEY-----), or use GOOGLE_SERVICE_ACCOUNT_JSON.');
  }
}

async function requestToken() {
  assertUsableKey();
  const now = Math.floor(Date.now() / 1000);
  const assertion = jwt.sign(
    { iss: config.google.serviceAccountEmail, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3300 },
    config.google.privateKey,
    { algorithm: 'RS256' }
  );
  const res = await googleFetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
  });
  if (!res.ok) {
    // Never include the response body or key material in the message.
    throw new HttpError(502, 'Google rejected the service account credentials. Check the GOOGLE_* settings.');
  }
  const body = await res.json();
  cache.token = body.access_token;
  cache.expiresAt = Date.now() + (Number(body.expires_in) || 3600) * 1000;
}

// Returns { accessToken, expiresAt(ms) } with at least `minTtlSeconds` of life left.
async function getAccessToken(minTtlSeconds = 60) {
  assertConfigured();
  const fresh = () => cache.token && cache.expiresAt - Date.now() > minTtlSeconds * 1000;
  if (!fresh()) {
    if (!cache.inflight) cache.inflight = requestToken().finally(() => { cache.inflight = null; });
    await cache.inflight;
  }
  return { accessToken: cache.token, expiresAt: cache.expiresAt };
}

async function driveGet(path, params) {
  const { accessToken } = await getAccessToken();
  const url = `${DRIVE}${path}?${new URLSearchParams({ supportsAllDrives: 'true', ...params })}`;
  const res = await googleFetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (res.status === 404) {
    throw new HttpError(404, 'File not found, or it is not shared with the service account. Share the file or its folder with the service account e-mail.');
  }
  if (res.status === 401) { cache.token = null; throw new HttpError(502, 'Google Drive authorization failed. Please try again.'); }
  if (res.status === 403 || res.status === 429) {
    throw new HttpError(503, 'Google Drive is limiting requests right now (quota or permissions). Please try again later.');
  }
  if (!res.ok) throw new HttpError(502, 'Google Drive returned an unexpected error.');
  return res;
}

// Normalised file facts used to decide whether a file can be a lecture.
async function getFileMetadata(fileId) {
  assertFileId(fileId);
  const fields = 'id,name,mimeType,size,trashed,parents,thumbnailLink,videoMediaMetadata(durationMillis,width,height)';
  const f = await (await driveGet(`/files/${fileId}`, { fields })).json();
  const ms = f.videoMediaMetadata && Number(f.videoMediaMetadata.durationMillis);
  return {
    fileId: f.id,
    name: f.name,
    mimeType: f.mimeType,
    sizeBytes: f.size ? Number(f.size) : null,
    trashed: Boolean(f.trashed),
    parents: f.parents || [],
    hasThumbnail: Boolean(f.thumbnailLink),
    durationSeconds: ms ? Math.round(ms / 1000) : null,
    width: (f.videoMediaMetadata && f.videoMediaMetadata.width) || null,
    height: (f.videoMediaMetadata && f.videoMediaMetadata.height) || null,
  };
}

// True when the file sits inside GOOGLE_DRIVE_ROOT_FOLDER_ID (walks up to 8 folder levels). Always true if no root is set.
async function isInsideRootFolder(meta) {
  const root = config.google.rootFolderId;
  if (!root) return true;
  let level = meta.parents;
  for (let depth = 0; depth < 8 && level.length; depth += 1) {
    if (level.includes(root)) return true;
    const next = [];
    for (const id of level) {
      let parents = parentCache.get(id);
      if (!parents || parents.at < Date.now() - 5 * 60 * 1000) {
        // A parent the service account cannot see (404) is by definition outside the shared video folder.
        let folder = { parents: [] };
        try { folder = await (await driveGet(`/files/${id}`, { fields: 'parents' })).json(); } catch (e) { if (!(e instanceof HttpError) || e.status !== 404) throw e; }
        parents = { list: folder.parents || [], at: Date.now() };
        parentCache.set(id, parents);
      }
      next.push(...parents.list);
    }
    level = next;
  }
  return false;
}

// The Drive thumbnail is a small image (a few KB). Fetched server-side because Drive thumbnail links need auth.
async function getThumbnail(fileId) {
  assertFileId(fileId);
  const info = await (await driveGet(`/files/${fileId}`, { fields: 'thumbnailLink' })).json();
  if (!info.thumbnailLink) throw new HttpError(404, 'No thumbnail available');
  const res = await googleFetch(info.thumbnailLink.replace(/=s\d+$/, '=s480'));
  if (!res.ok) throw new HttpError(404, 'No thumbnail available');
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > 1024 * 1024) throw new HttpError(502, 'Thumbnail too large');
  return { buffer, contentType: res.headers.get('content-type') || 'image/jpeg' };
}

// Direct-from-Google playback: the app calls this URL itself with the bearer token, so video bytes never touch our server.
async function getPlaybackAccess(fileId) {
  assertFileId(fileId);
  const { accessToken, expiresAt } = await getAccessToken(config.google.minTokenTtlSeconds);
  return {
    url: `${DRIVE}/files/${fileId}?alt=media&supportsAllDrives=true`,
    headers: { Authorization: `Bearer ${accessToken}` },
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

// Accepts a bare ID or any common Drive link and returns the file ID (or null).
function parseFileId(input) {
  const s = String(input || '').trim();
  if (FILE_ID.test(s)) return s;
  const m = s.match(/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?(?:[^#]*&)?id=)([A-Za-z0-9_-]{10,100})/);
  return m ? m[1] : null;
}

const FOLDER_MIME = 'application/vnd.google-apps.folder';

// A folder's name and parents, checked to be a real, untrashed folder inside the configured root folder.
async function getFolder(folderId) {
  assertConfigured();
  assertFileId(folderId);
  const f = await (await driveGet(`/files/${folderId}`, { fields: 'id,name,mimeType,trashed,parents' })).json();
  if (f.mimeType !== FOLDER_MIME) throw new HttpError(400, 'That is a file, not a folder.');
  if (f.trashed) throw new HttpError(400, 'That folder is in the Drive trash.');
  const root = config.google.rootFolderId;
  if (root && f.id !== root && !(await isInsideRootFolder({ parents: f.parents || [] }))) {
    throw new HttpError(400, 'That folder is outside the configured video folder (GOOGLE_DRIVE_ROOT_FOLDER_ID).');
  }
  return { id: f.id, name: f.name };
}

// Everything directly inside a folder (not trashed): [{ id, name, mimeType, isFolder, sizeBytes, durationSeconds, hasThumbnail }].
// The caller must have verified the folder with getFolder() first.
async function listChildren(folderId) {
  assertFileId(folderId);
  const out = [];
  let pageToken;
  for (let page = 0; page < 20; page += 1) {
    const params = {
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken,files(id,name,mimeType,size,thumbnailLink,videoMediaMetadata(durationMillis))',
      pageSize: '1000', includeItemsFromAllDrives: 'true', orderBy: 'name_natural',
    };
    if (pageToken) params.pageToken = pageToken;
    const body = await (await driveGet('/files', params)).json();
    for (const f of body.files || []) {
      const ms = f.videoMediaMetadata && Number(f.videoMediaMetadata.durationMillis);
      out.push({ id: f.id, name: f.name, mimeType: f.mimeType, isFolder: f.mimeType === FOLDER_MIME, sizeBytes: f.size ? Number(f.size) : 0, hasThumbnail: Boolean(f.thumbnailLink), durationSeconds: ms ? Math.round(ms / 1000) : 0 });
    }
    pageToken = body.nextPageToken;
    if (!pageToken) break;
  }
  return out;
}

module.exports = { getFolder, listChildren, FOLDER_MIME, isConfigured, getAccessToken, getFileMetadata, isInsideRootFolder, getThumbnail, getPlaybackAccess, parseFileId, assertFileId, _setFetch, _reset };
