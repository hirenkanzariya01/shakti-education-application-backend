const drive = require('../googleDrive.service');
const { HttpError } = require('../../utils/http');

// Containers that Android's ExoPlayer and iOS AVPlayer can both play progressively over HTTP range requests.
const PLAYABLE = new Set(['video/mp4', 'video/quicktime', 'video/x-m4v']);

module.exports = {
  name: 'google-drive',
  isConfigured: drive.isConfigured,

  // Turns what an admin typed (a file ID or a Drive link) into the stored reference.
  parseRef(input) {
    const fileId = drive.parseFileId(input);
    if (!fileId) throw new HttpError(400, 'Enter a Google Drive file link or file ID');
    return fileId;
  },

  // Checks the file really exists, is reachable, is a video and is in the allowed folder. Returns facts to store.
  async describe(ref) {
    const meta = await drive.getFileMetadata(ref);
    if (meta.trashed) throw new HttpError(400, 'That file is in the Drive trash');
    if (!meta.mimeType.startsWith('video/')) throw new HttpError(400, `That file is not a video (${meta.mimeType})`);
    if (!(await drive.isInsideRootFolder(meta))) throw new HttpError(400, 'That file is outside the allowed video folder');
    const warnings = [];
    if (!PLAYABLE.has(meta.mimeType)) warnings.push(`Format ${meta.mimeType} may not play on all phones. MP4 (H.264/AAC) is recommended.`);
    if (!meta.durationSeconds) warnings.push('Google is still processing this video (duration unknown). Try again in a few minutes.');
    return {
      ref: meta.fileId, title: meta.name, mimeType: meta.mimeType, durationSeconds: meta.durationSeconds,
      sizeBytes: meta.sizeBytes, hasThumbnail: meta.hasThumbnail, warnings,
    };
  },

  async getPlayback(ref, video) {
    const access = await drive.getPlaybackAccess(ref);
    return { type: 'progressive', mimeType: video.mimeType || 'video/mp4', ...access };
  },

  async getThumbnail(ref) { return drive.getThumbnail(ref); },
};
