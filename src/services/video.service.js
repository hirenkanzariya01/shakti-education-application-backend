// Provider-agnostic video logic used by the controller. Knows nothing about Google specifically.
const config = require('../config');
const { getProvider, providerNames } = require('./providers');
const { HttpError } = require('../utils/http');

// Admin input -> the `video` sub-document stored on a Lesson.
async function buildVideoRef({ provider = config.video.defaultProvider, source }) {
  const p = getProvider(provider);
  if (!p.isConfigured()) throw new HttpError(503, `The "${provider}" video provider is not configured on the server.`);
  const ref = p.parseRef(source);
  const facts = await p.describe(ref);
  return {
    video: {
      provider: p.name, ref, mimeType: facts.mimeType || '', durationSeconds: facts.durationSeconds || 0,
      sizeBytes: facts.sizeBytes || 0, hasThumbnail: Boolean(facts.hasThumbnail),
    },
    suggestedTitle: facts.title,
    warnings: facts.warnings,
  };
}

// Access details the app needs to start playing. The caller must already have checked enrollment/publication.
async function getPlayback(video) {
  if (!video || !video.provider || !video.ref) throw new HttpError(404, 'This lecture has no video yet');
  const p = getProvider(video.provider);
  const playback = await p.getPlayback(video.ref, video);
  return { provider: p.name, ...playback };
}

async function getThumbnail(video) {
  if (!video || !video.provider || !video.ref) throw new HttpError(404, 'No thumbnail available');
  return getProvider(video.provider).getThumbnail(video.ref);
}

module.exports = { buildVideoRef, getPlayback, getThumbnail, providerNames };
