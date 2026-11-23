# Shakti Education Institute – Backend API

Node.js + Express + MongoDB (Mongoose). Serves the student mobile app and the admin panel.

* **Auth**: email + password, bcrypt-hashed, JWT (HS256) bearer tokens, revocable (`tokenVersion`), roles `student` / `admin`.
* **Validation**: every body is checked with strict zod schemas (unknown fields are rejected, so nobody can send `role: "admin"`).
* **Hardening**: helmet, CORS allowlist, rate limits on auth routes, 100 kb body limit, ObjectId checks, escaped search regex, generic login errors, no password hashes in any response.
* **Response shape** (same as the app's services): `{ success, data, message, error }`.

## Quick start

```bash
cd shakti-backend
npm install
cp .env.example .env          # then edit it (see below)
# MongoDB must be running (local install or MongoDB Atlas URI in MONGODB_URI)
npm run seed                  # creates the admin + demo data (npm run seed:reset wipes the DB first, dev only)
npm run dev                   # http://localhost:4000/api/health
npm test                      # 74 tests: API, Google Drive service, videos/reviews/placements, quizzes, security (needs MongoDB; uses `shakti_test`)
```

The development seed prints the admin login (`admin@shakti.local` / `Admin@12345`) **only when you did not set `ADMIN_PASSWORD`**.
Demo students: `aarav@example.com`, `diya@example.com`, `kabir@example.com` – password `Demo@1234`.

### Environment (`.env`)

| Variable                                                                                                                                                             | Notes                                                                                                                                                                               |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MONGODB_URI`                                                                                                                                                        | e.g. `mongodb://127.0.0.1:27017/shakti` or an Atlas `mongodb+srv://…` URI                                                                                                           |
| `JWT_SECRET`                                                                                                                                                         | **Required in production**, 32+ random chars (`openssl rand -hex 32`). The server refuses to start without it.                                                                      |
| `CORS_ORIGINS`                                                                                                                                                       | Comma-separated browser origins allowed (your admin panel URL). The mobile app needs no entry.                                                                                      |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD`                                                                                                                                     | First admin created by `npm run seed`. In production a password of 12+ characters is required.                                                                                      |
| `SEED_DEMO`                                                                                                                                                          | Demo students/courses are added in development only. In production they are skipped unless you set `SEED_DEMO=true`.                                                                |
| `VIDEO_PROVIDER`, `GOOGLE_SERVICE_ACCOUNT_JSON` (or `GOOGLE_SERVICE_ACCOUNT_EMAIL` + `GOOGLE_PRIVATE_KEY`), `GOOGLE_DRIVE_ROOT_FOLDER_ID`, `GOOGLE_PLAYBACK_MIN_TTL` | Video streaming; see [docs/VIDEO_PROVIDERS.md](docs/VIDEO_PROVIDERS.md). Backend only; never put these in the app.                                                                  |
| `LOG_LEVEL`                                                                                                                                                          | `debug` / `info` / `warn` / `error`. Logs are JSON lines; tokens and bodies are never logged.                                                                                       |
| `SELF_ENROLLMENT`                                                                                                                                                    | `false` = only admins can enroll students, so a student sees videos and quizzes of **only the courses the institute gave them**. Default: on in development, **off in production**. |
| `MEDIA_MAX_TOTAL_MB`                                                                                                                                                 | Cap on uploaded images stored in MongoDB (default 100) so a free 512 MB Atlas cluster cannot fill up.                                                                               |

## API overview (all under `/api`)

**Public**: `GET /health`, `GET /courses?search=&category=`, `GET /courses/:id`, `GET /categories`, `GET /banners`, `POST /auth/register`, `POST /auth/login`, `POST /auth/forgot-password`, `POST /auth/reset-password`.

**Signed-in student**: `GET|PATCH /auth/me`, `POST /auth/change-password`, `POST /auth/logout-all`; `GET /me/enrollments`, `POST /courses/:id/enroll`, `GET /courses/:id/lessons` (video link only if enrolled), `PUT /lessons/:id/completion`, `GET /courses/:id/progress`, `GET /me/learning`, `GET /me/continue`; `GET /live-classes`, `GET /live-classes/:id/join` (enrolled only); `GET /me/payments`, `GET /me/payments/summary`; `GET /me/certificates`, `GET /certificates/:id`; `GET /placements`, `POST /placements/:id/interest`; `GET /notifications`, `GET /notifications/unread-count`, `POST /notifications/:id/read`, `POST /notifications/read-all`.

**Videos** (login required; `/api/videos`): `GET /course/:courseId` (modules + lectures, paginated, `locked` unless enrolled), `GET /:id`, `GET /:id/playback` (**enrollment checked**, returns a short-lived stream URL), `GET /:id/thumbnail`; admin: `GET /` (all, `?course=`), `POST /`, `PUT /:id`, `DELETE /:id`, `GET /options`. **Progress**: `POST /video-progress`, `GET /video-progress/:videoId`.

**Reviews** (`/api/reviews`): public `GET /` (approved only, paginated, with average); signed-in `GET /mine`, `POST /` (enrolled students; starts *pending*), `PUT|DELETE /:id` (own); admin `PATCH /:id/approve` (`approved` / `rejected` / `pending`), and `?status=` filter. **Placed students** (`/api/placed-students`): public `GET /` (verified **and** published only), admin `POST`, `PUT /:id`, `DELETE /:id`, `GET ?all=1`. **Images**: admin `POST /api/admin/media` (JPEG/PNG/WebP ≤ 300 KB), public `GET /api/media/:id`. Health: `GET /health`, `GET /health/ready`.

**Quizzes** (`/api/quizzes`, login required, enrolled students only): `GET /course/:courseId` (students see published quizzes with their own status), `GET /:id` (questions **without** the right answers), `POST /:id/submit` (one submission each), `GET /:id/result` (only after the teacher declares it; correct answers only if the teacher chose to reveal them). Admin: `POST /`, `PUT /:id` (questions lock once students have answered), `PATCH /:id/status` (`draft` / `published` / `closed`), `POST /:id/declare-result` (grades everyone, closes the quiz, notifies students), `GET /:id/attempts`, `DELETE /:id`.

**Admin only** (`/api/admin/…`): `stats`; CRUD for `categories`, `courses`, `lessons`, `live-classes`, `placements`, `banners`, `notifications`; `students` (list, create, view, edit, deactivate, delete, `reset-password`, `enroll`, `DELETE enrollments/:courseId`); `payments` (add, edit, `mark-paid`, delete); `certificates` (issue, revoke).

## Important design decisions and limits

* **No online payments.** Students cannot pay inside the app. Staff record money received at the institute (`mark-paid`), which creates a receipt number. Adding Razorpay/Stripe later means a hosted checkout + a verified webhook; never trust the client.
* **No email/SMS service is connected.** "Forgot password" is therefore staff-assisted: an admin sets a temporary password in the admin panel (`Students → Reset password`). `POST /auth/forgot-password` generates a time-limited token (stored hashed); outside production it is printed in the server log. Wire your mail provider in `routes/auth.js` to send it.
* **Videos are references, not files.** A lecture stores a provider + reference (e.g. a Google Drive file ID). The backend never stores or proxies video bytes; enrolled students get a short-lived stream URL straight from the provider. See [docs/VIDEO_PROVIDERS.md](docs/VIDEO_PROVIDERS.md) for Drive limits and how to add Cloudflare Stream / Mux. Not DRM-protected.
* **No fake social proof.** Nothing is seeded for reviews or placed students. Reviews start pending and are public only after admin approval; placed students are public only when verified **and** published.
* **Certificates** are records the admin issues (PDF generation is not included). Tick "sample" to mark practice ones; the app watermarks those.
* **Deactivating a student** signs them out immediately.

## Deploying

See **[docs/DEPLOY_CLOUD_RUN.md](docs/DEPLOY_CLOUD_RUN.md)** (Google Cloud Run in asia-south1, MongoDB Atlas, secrets, cost estimate and caveats). A `Dockerfile` is included.

## About the test database

The automated tests in this project were run against **FerretDB** (a MongoDB-compatible server on SQLite) because MongoDB itself was not installable in the build environment. The code uses standard MongoDB features only, but please run `npm test` once against a real MongoDB before going live.

## Your workflow in one place

1. **Videos:** keep Drive as `application video / <course> / <subject> / <video>`, share `application video` with the service account (Viewer) and put its ID in `GOOGLE_DRIVE_ROOT_FOLDER_ID`. Admin panel → *Videos* → choose the course → **Import from Drive** → pick the course folder → Preview → Import. Each subject folder becomes a module and each video a lecture (API: `GET /api/videos/drive/folders|preview`, `POST /api/videos/drive/import`; admin only). Re-run later to add only new videos. Single links can still be pasted by hand. Only the link is stored in MongoDB.
2. **Per-course access:** with `SELF_ENROLLMENT=false`, students can only open courses you enroll them in: tick courses in *Students → Add student*, or later *Students → open a student → Manage course access* (API: `POST /api/admin/students` with `courses: [ids]`, `PUT /api/admin/students/:id/courses`). Videos, quizzes and live-class links all follow the same rule.
3. **Quizzes:** admin panel → *Quizzes* → choose the course → *New quiz* → *Publish*. Students answer once in the app (no right answers shown). Later: *Submissions* to see scores, then *Declare result*.


> `MONGODB_URI` must include the database name, e.g. `mongodb+srv://USER:PASS@cluster.mongodb.net/shakti?retryWrites=true&w=majority`; without it data lands in the default `test` database. Never commit `.env`; rotate any secret that has been pasted into chat or email.
* Speed tuning and the region advice: [docs/PERFORMANCE.md](docs/PERFORMANCE.md).
