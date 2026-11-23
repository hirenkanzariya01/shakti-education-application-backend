# Video streaming: providers, Google Drive, and adding Cloudflare Stream / Mux

## How it works

* A lecture (a `Lesson`) stores only a **reference**: `{ provider, ref }`. For Google Drive the `ref` is the file ID. No video bytes ever pass through or are stored by this backend.
* `GET /api/videos/:id/playback` checks login + **enrollment** (admins always pass), asks the provider how to play the file, and returns
  `{ provider, type: 'progressive' | 'hls', url, headers, expiresAt, mimeType, resumeAtSeconds }` with `Cache-Control: no-store`.
* The app plays that URL directly from the provider with `expo-video`. Progress is saved to `/api/video-progress` and resumed next time.
* OAuth client secrets, refresh tokens and the service-account private key stay on the server. The app only ever receives a short-lived (about 1 hour) read-only access token.

## Google Drive set-up (about 10 minutes)

1. Google Cloud Console → create/select a project → **APIs & Services → Enable APIs → Google Drive API**.
2. **IAM & Admin → Service Accounts → Create** (no roles needed). Open it → **Keys → Add key → JSON**. Keep the file private.
3. In Drive, put every lecture in **one dedicated folder** (nothing else in it). Share that folder with the service account's e-mail (`…@…iam.gserviceaccount.com`) as **Viewer**.
4. Set on the server (Secret Manager on Cloud Run): `GOOGLE_SERVICE_ACCOUNT_JSON` (the whole key file) and `GOOGLE_DRIVE_ROOT_FOLDER_ID` (the folder's ID from its URL).
5. Admin panel → **Videos** → pick the course → **Add video** → paste the Drive share link or file ID. Title and duration are read from Drive automatically.

### Permissions and the one real security trade-off

The token handed to an enrolled student has the `drive.readonly` scope for the **service account**, so for about an hour it could read *any* file that service account can see. That is why the service account must only have the one video folder shared with it, and why `GOOGLE_DRIVE_ROOT_FOLDER_ID` blocks registering videos from anywhere else. The token cannot write, delete, or see your personal Drive. A student who is enrolled in *one* course could, with technical effort, read videos of *other* courses in that folder during that hour. If that matters, use a provider that issues per-video signed URLs (below).

### Compatibility (what plays)

* **Best:** MP4 (H.264 video + AAC audio) and MOV/M4V. These play with the native players on iOS and Android and support seeking (HTTP Range).
* The admin form warns when a file is another container (e.g. MKV/AVI/WebM) or when Drive has not finished processing the video yet. Convert to H.264/AAC MP4 before uploading.
* Drive offers no adaptive bitrate (no HLS/DASH): students on slow networks get the one file you uploaded. Keep lecture files reasonably small (e.g. 720p).
* Drive may also show a virus-scan interstitial for very large files; the API path used here (`alt=media` with a bearer token) avoids the browser page but this should be confirmed with your real files.

### Quotas and limits (read before relying on it for 500 GB of video)

* Google documents a per-project **daily egress limit** and Drive API **per-minute request quotas** ([Drive usage limits](https://developers.google.com/workspace/drive/api/guides/limits)); `files.get` with `alt=media` counts as a download method costing 200 quota units per call. Google publishes **no guaranteed bandwidth or concurrent-viewer figure** for streaming from Drive.
* Community reports show Drive returning `403 downloadQuotaExceeded` / rate-limit errors when many people fetch the same file in a short time. The app shows a friendly "couldn't play" screen with **Try again**, and the backend returns `503` when Google reports quota exhaustion, but this cannot be fixed in code.
* Therefore **load-test with a realistic number of simultaneous students before launch**, and treat Drive as an inexpensive starting point rather than a guaranteed streaming service.
* No fee is charged by this backend for video; Drive storage is subject to your Google account's storage plan.

## Adding another provider (Cloudflare Stream, Mux, Vimeo…)

A provider is one file in `src/services/providers/` exporting:

```js
module.exports = {
  name: 'cloudflare-stream',
  isConfigured: () => Boolean(process.env.CF_STREAM_KEY),     // false => admin form returns a clear 503
  parseRef: (input) => '<video uid>',                          // validate/normalise what the admin pasted
  describe: async (ref) => ({ title, mimeType, durationSeconds, sizeBytes, hasThumbnail, warnings: [] }),  // checked when saving
  getPlayback: async (ref, { video }) => ({                   // called per student play request
    type: 'hls',                                               // the app plays 'hls' or 'progressive'
    url: 'https://…/manifest/video.m3u8?token=<short-lived signed token>',
    headers: {},                                               // or { Authorization: … } if the provider needs it
    expiresAt: '<ISO time>',
  }),
  getThumbnail: async (ref) => ({ buffer, contentType }),     // optional
};
```

Register it in `src/services/providers/index.js` (add it to the `providers` map) and set `VIDEO_PROVIDER=cloudflare-stream` to make it the default for new videos. Existing Drive videos keep working because each lecture remembers its own provider. **No app change is needed**: the player already handles `hls` and `progressive`. With signed, per-video, short-lived URLs the "student can read other videos" trade-off above disappears.
