# Performance notes

What the code already does
* gzip compression on every API response.
* Auth: the signed-in user is cached in memory for 15 s and cleared the moment that user is saved, so deactivation, password change and "sign out everywhere" still apply on the next request.
* Playback: the lesson and the student's progress load together, then the course and enrollment checks load together (2 database round trips instead of 5). The Drive access token is cached, so no Google call is made per play.
* Drive thumbnails are cached in memory (6 h) and in the app (24 h).
* MongoDB connection pool kept warm (min 2 / max 20) with wire compression.
* App: catalogue reads (courses, categories, banners, reviews, placements) are shown from memory instantly and refreshed in the background; identical requests in flight are shared; any write or sign-out clears the cache. Access checks (`/enrolled`) are never cached.

What matters most and lives outside the code
1. **Put the database and the server in the same region as your students.** For India: Atlas cluster in **Mumbai (ap-south-1)** and Cloud Run in **asia-south1**. Every request makes several database round trips, so a US cluster adds roughly 200 ms to each one. Check the region in Atlas -> Cluster. A free M0 cluster cannot change region; create a new one in Mumbai and copy the data across if needed.
2. **Cloud Run cold starts:** with scale-to-zero the first request after idle takes several seconds. `--min-instances=1` removes this but is not free; decide based on your budget.
3. **Video speed is Google Drive's.** Drive is not a video CDN: first-byte time and throughput vary and are not guaranteed. mp4 files with the "fast start" layout (re-export with `ffmpeg -movflags +faststart`) and 720p/H.264 start much faster than large 1080p files. If lectures still buffer, move to Cloudflare Stream or Mux through the provider interface (see VIDEO_PROVIDERS.md).
