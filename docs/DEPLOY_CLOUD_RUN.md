# Deploying the API to Google Cloud Run (asia-south1 / Mumbai)

> **Hosting is not guaranteed to be free.** Cloud Run and MongoDB Atlas both have free allowances, but they are limits, not promises. Prices and allowances change; the figures below were read from Google's and MongoDB's pages in November 2026. Check them again before you commit, and set a **billing budget alert** in Google Cloud.

## What you need

* A Google Cloud project with billing enabled (Cloud Run needs a billing account even when usage stays inside the free allowance).
* A MongoDB Atlas cluster (see cost notes).
* `gcloud` installed and logged in. The Dockerfile is in `shakti-backend/`.

## 1. One-time set-up

```bash
gcloud config set project YOUR_PROJECT_ID
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com

# Secrets (never put these in the image, the repo or the mobile app)
openssl rand -hex 32 | tr -d '\n' | gcloud secrets create jwt-secret --data-file=-
printf '%s' 'mongodb+srv://USER:PASSWORD@CLUSTER.mongodb.net/shakti?retryWrites=true&w=majority' | gcloud secrets create mongodb-uri --data-file=-
gcloud secrets create drive-service-account --data-file=/path/to/service-account-key.json   # see docs/VIDEO_PROVIDERS.md

# Let the Cloud Run runtime service account read them
PROJECT_NUMBER=$(gcloud projects describe YOUR_PROJECT_ID --format='value(projectNumber)')
for s in jwt-secret mongodb-uri drive-service-account; do
  gcloud secrets add-iam-policy-binding $s --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" --role=roles/secretmanager.secretAccessor
done
```

## 2. Deploy

```bash
cd shakti-backend
gcloud run deploy shakti-api \
  --source . \
  --region asia-south1 \
  --min-instances 0 --max-instances 3 \
  --cpu 1 --memory 512Mi --concurrency 40 --timeout 60 \
  --allow-unauthenticated \
  --set-env-vars NODE_ENV=production,SELF_ENROLLMENT=false,CORS_ORIGINS=https://YOUR-ADMIN-PANEL-URL,GOOGLE_DRIVE_ROOT_FOLDER_ID=YOUR_FOLDER_ID,VIDEO_PROVIDER=google-drive \
  --set-secrets JWT_SECRET=jwt-secret:latest,MONGODB_URI=mongodb-uri:latest,GOOGLE_SERVICE_ACCOUNT_JSON=drive-service-account:latest
```

* `--min-instances 0` means the service scales to zero when idle (no idle cost). The price is a **cold start** of a couple of seconds for the first request after a quiet period.
* `--allow-unauthenticated` is required because the mobile app and admin panel call it directly; the API protects itself with JWT logins and roles.
* `--max-instances` caps cost and protects MongoDB from a traffic spike.
* The app reads `PORT` (Cloud Run sets 8080), logs JSON to stdout (visible in Cloud Logging), exits cleanly on `SIGTERM` within 8 s, and exposes `/api/health` (liveness) and `/api/health/ready` (checks MongoDB). Point an optional startup/liveness probe at those paths.

## 3. Create the first admin (no demo data in production)

Run once from your computer, pointing at Atlas:

```bash
cd shakti-backend
NODE_ENV=production MONGODB_URI='…' JWT_SECRET='any-32+char-value' ADMIN_EMAIL=you@yourdomain.com ADMIN_PASSWORD='a-long-password-12+' SEED_DEMO=false npm run seed
```

In production the seed adds **only** the admin (it refuses to wipe a database and skips demo data unless you set `SEED_DEMO=true`).

## 4. MongoDB Atlas

* **Network access:** Cloud Run has no fixed outbound IP. The simple route is allowing `0.0.0.0/0` in Atlas Network Access and relying on a long random database password plus TLS; the stricter route is a Serverless VPC connector + Cloud NAT with a static IP (extra monthly cost) and allow-listing only that IP.
* Create a database user with access to the `shakti` database only.
* **Free 512 MB is enough for text and links** (courses, Drive links, quizzes, reviews, progress). Profile photos and logos uploaded in the admin panel are stored in MongoDB too (≤ 300 KB each); the server stops accepting uploads after `MEDIA_MAX_TOTAL_MB` (default 100 MB). Pasting an `https://` image link instead uses no database space.
* Turn on backups appropriate to your tier (the free tier has no continuous backup).

## 5. Point the apps at it

* Mobile app: build with `EXPO_PUBLIC_DATA_MODE=api` and `EXPO_PUBLIC_API_URL=https://YOUR-SERVICE-xxxx.asia-south1.run.app/api`.
* Admin panel: build with `VITE_API_URL=https://YOUR-SERVICE-xxxx.asia-south1.run.app/api` and host the `dist/` folder on any static host (its URL goes in `CORS_ORIGINS`).

## Cost estimate (target ≈ ₹500/month) — with the caveats

| Item | Free allowance / price (as read in Nov 2026) | Likely for a small institute |
| --- | --- | --- |
| Cloud Run requests | 2 million requests/month free, then US$0.40 per million | A few hundred students stay far below this |
| Cloud Run CPU / memory | 180,000 vCPU-seconds and 360,000 GiB-seconds free per month; then US$0.000024 per vCPU-s and US$0.0000025 per GiB-s (active) | A light API with `--min-instances 0` normally fits inside the free allowance; a busy one will not |
| Idle instances | Only if you set `--min-instances` > 0 (vCPU idle US$0.0000025/s). With 0, nothing is billed while idle | ₹0 at 0 |
| Region | asia-south1 (Mumbai) is a **Tier 1** region | — |
| MongoDB Atlas **M0 (Free)** | No cost, but small (512 MB), shared, with usage limits; not meant for guaranteed production performance | Fits ₹500 only with this |
| MongoDB Atlas **Flex** | US$8–30 / month (base US$8 includes 5 GB and 100 ops/s; capped at US$30) | Roughly ₹700–₹2,700 depending on the exchange rate, i.e. **above ₹500** |
| MongoDB Atlas **M10 dedicated** | from about US$60 / month | Much higher; for larger production loads |
| Secret Manager, Artifact Registry, Cloud Build, Logging | Small free allowances | Usually pennies if you stay inside them; check the console |
| Video | Served by Google Drive, **not** by Cloud Run, so it adds no Cloud Run bandwidth | Drive quota rules apply (see VIDEO_PROVIDERS.md) |

**Honest summary:** with Atlas M0 and low traffic the monthly bill can be close to ₹0–₹500, but that is not guaranteed: it depends on traffic, the M0 limits, and current prices. With the Atlas Flex tier the database alone is likely to exceed ₹500. Outbound data transfer beyond Google's small free allowance is billed; since videos do not pass through Cloud Run it should stay small. Use the Cloud Billing **budgets & alerts** to be told before a surprise.

## Security checklist before going live

* `NODE_ENV=production`, a 32+ character `JWT_SECRET` from Secret Manager (the server refuses to start otherwise).
* Service-account key only in Secret Manager; Drive folder shared **only** with that account; `GOOGLE_DRIVE_ROOT_FOLDER_ID` set.
* `CORS_ORIGINS` lists only your admin panel's `https://` URL.
* Strong admin password; no demo accounts (`SEED_DEMO=false`).
* HTTPS only (Cloud Run provides it). Rate limiting is in-memory **per instance**, so the effective limit grows with the number of instances; `--max-instances` bounds this.
* Billing budget alert created; Atlas backups configured; `npm test` run against a real MongoDB.
