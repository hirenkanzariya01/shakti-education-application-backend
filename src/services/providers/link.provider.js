const { HttpError } = require('../../utils/http');

// A plain https link to a video file or an HLS (.m3u8) playlist, e.g. from a CDN or a future streaming service
// that returns public URLs. Also keeps older lessons (that only had a videoUrl) working unchanged.
module.exports = {
  name: 'link',
  isConfigured: () => true,
  parseRef(input) {
    const url = String(input || '').trim();
    if (!/^https:\/\/[^\s]+$/i.test(url) || url.length > 500) throw new HttpError(400, 'Enter a valid https:// video link');
    return url;
  },
  async describe(ref) { return { ref, title: '', mimeType: '', durationSeconds: null, sizeBytes: null, hasThumbnail: false, warnings: [] }; },
  async getPlayback(ref) {
    return { type: /\.m3u8(\?|$)/i.test(ref) ? 'hls' : 'progressive', url: ref, headers: {}, expiresAt: null };
  },
  async getThumbnail() { throw new HttpError(404, 'No thumbnail available'); },
};
