# Deploying RadioT

Everything runs on **Vercel**. No Docker, no VPS, no streaming server.

| Vercel project  | Root directory | What it is                                                              | Domain             |
| --------------- | -------------- | ----------------------------------------------------------------------- | ------------------ |
| `radiot-web`    | `apps/web`     | Next.js site                                                            | `radiot.app`       |
| `radiot-api`    | `apps/api`     | Fastify + Socket.IO (WebSocket transport) as one Fluid function         | `api.radiot.app`   |
| `radiot-worker` | `apps/worker`  | `POST /api/media`: ingest, transcode, loudness, cue points, Chromaprint | (no domain needed) |

Data: **Neon** Postgres and **Upstash** Redis from the Vercel Marketplace, **Vercel Blob** for uploads and
cooked media, **LiveKit Cloud** for the performer camera.

How audio works without a streaming server: Postgres holds the timeline (each round's `startedAt` +
airtime). Browsers download the on-air file from Blob's CDN, seek to the shared position, and crossfade
into the announced next track at its scheduled time. See docs/architecture.md.

## 1. Storage (once)

In the Vercel dashboard → Storage:

1. Create a **Neon** Postgres database and connect it to `radiot-api` and `radiot-worker`
   (`DATABASE_URL`, use the pooled connection string).
2. Create an **Upstash** Redis database and connect it to `radiot-api` (`REDIS_URL`, the `rediss://` TCP URL;
   ioredis needs TCP, not the REST URL).
3. Create a **Blob** store (public) and connect it to `radiot-api` and `radiot-worker`
   (`BLOB_READ_WRITE_TOKEN`).

Then, from your machine with `DATABASE_URL` pointing at Neon:

```bash
pnpm db:migrate && pnpm db:seed
pnpm fallback:import            # needs BLOB_READ_WRITE_TOKEN in apps/worker/.env and local ffmpeg/fpcalc
```

## 2. Projects

Create the three projects from the same Git repo with the root directories above. Each app's
`vercel.json` sets the build command (`turbo run build --filter=<app>...`, which builds `packages/shared`
and `packages/db` first). Leave the install command at the default (pnpm, run at the repo root).

**radiot-api** env:

| Var                                                                                     | Value                                                                |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `API_URL`                                                                               | `https://api.radiot.app`                                             |
| `WEB_ORIGIN`                                                                            | `https://radiot.app`                                                 |
| `COOKIE_DOMAIN`                                                                         | `radiot.app` (session cookie shared with the web app)                |
| `BETTER_AUTH_SECRET`                                                                    | `openssl rand -base64 32`                                            |
| `INTERNAL_SECRET`                                                                       | long random string, same as the worker                               |
| `WORKER_URL`                                                                            | the worker's production URL, e.g. `https://radiot-worker.vercel.app` |
| `IP_HASH_SALT`                                                                          | random string                                                        |
| `SMTP_URL`, `MAIL_FROM`                                                                 | e.g. Resend SMTP; empty = magic links only in logs                   |
| `GOOGLE_CLIENT_ID/SECRET`, `TURNSTILE_SECRET_KEY`, `VAPID_*`, `SENTRY_DSN`, `LIVEKIT_*` | optional                                                             |

**radiot-worker** env: `API_URL=https://api.radiot.app`, `INTERNAL_SECRET` (same value), `SENTRY_DSN`.
The build vendors static `ffmpeg` (ffmpeg-static) and `fpcalc` (AcoustID release) into `vendor/`.

**radiot-web** env: `NEXT_PUBLIC_SITE_URL=https://radiot.app`, `NEXT_PUBLIC_API_URL=https://api.radiot.app`,
`NEXT_PUBLIC_LIVEKIT_URL`, `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, `NEXT_PUBLIC_POSTHOG_KEY`.

Turn off Deployment Protection for the worker's production URL, or the API's job hand-off gets the
Vercel login page instead (the worker checks `INTERNAL_SECRET` itself).

Plan notes: everything fits **Hobby** (functions run up to 300 s; Socket.IO clients reconnect when a
function reaches its limit). There are no cron jobs: upkeep runs from station reads (see
`apps/api/src/services/maintenance.ts`).

## 3. LiveKit Cloud

Create a project, put URL/key/secret in the API env, and add a webhook to
`https://api.radiot.app/api/livekit/webhook` (events: track_published, participant_left). The webhook is
mic-enforcement layer 3. Do not skip it.

## 4. Go-live checklist

- [ ] `https://api.radiot.app/health` green; Sentry receiving; PostHog receiving `listen_start`.
- [ ] `https://api.radiot.app/api/now-playing` returns a track with `media.url` on the Blob host.
- [ ] Two devices side by side play in sync (within ~0.3 s) and crossfade at the same moment.
- [ ] Upload a song: it reaches "ready" (worker logs `media ready`) and shows up in the vote.
- [ ] Magic-link email delivers (SPF/DKIM set); Google OAuth redirect `https://api.radiot.app/api/auth/callback/google`.
- [ ] Load test (`infra/load`) meets targets against a preview deployment.
- [ ] Legal pages and DMCA contact published (see docs/legal.md).
- [ ] `pnpm admin:grant you@yourdomain` after signing in once.

## Running without a custom domain (current setup, 2026-11-18)

Live at `https://radiot-web.vercel.app` (api: `radiot-api.vercel.app`, worker: `radiot-worker.vercel.app`).
Two `*.vercel.app` hosts are different sites, so the API is served through the web origin to keep the
session cookie first-party:

- **radiot-api**: `API_URL` and `WEB_ORIGIN` = `https://radiot-web.vercel.app`, no `COOKIE_DOMAIN`.
  `EXTRA_WEB_ORIGINS` (comma-separated) lists any other host names the web app answers on.
- **radiot-web**: `NEXT_PUBLIC_SITE_URL` and `NEXT_PUBLIC_API_URL` = `https://radiot-web.vercel.app` (equal values
  make browsers call `/api` on whichever host they opened), `API_PROXY_TARGET=https://radiot-api.vercel.app`
  (next.config rewrites `/api/*` there; listed in turbo.json `env` so strict env mode passes it to the build),
  `NEXT_PUBLIC_SOCKET_URL=https://radiot-api.vercel.app` (rewrites can't carry WebSockets).
- **radiot-worker**: `API_URL=https://radiot-api.vercel.app`.

Limitation: the socket is anonymous (no cookie on the API host), so per-user socket rooms (personal
notifications, admin live alerts) don't fire. Moving to a custom domain fixes it: switch to the table above.
No Git remote is connected; deploy from the repo root with
`VERCEL_ORG_ID=<team> VERCEL_PROJECT_ID=<project> vercel deploy --prod` (each app's `.vercel/project.json` has the ids).
