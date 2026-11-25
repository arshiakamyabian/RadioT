# RadioT — Agent Handbook

> This file is the single source of truth for how to work in this repo. Keep it current. If a decision changes, update the relevant section in the same PR.

## 1. Product goal

A 24/7 live community web radio. Everyone hears the same stream at the same moment. Users request songs (upload or direct audio URL), the community votes on what plays next, and when there are no requests a fallback playlist loops. The user whose song is currently playing can turn on their camera (no mic, ever) and appear live on stage. Smooth, professional crossfades between every track. Mobile-first, SEO-friendly, built for organic growth.

## 2. Stack (decided)

- **Monorepo**: pnpm workspaces + Turborepo.
- **Hosting: Vercel for web, api, worker** (owner's decision 2026-11-16). **The stream engine is the one exception** (owner's request 2026-11-18): it runs Liquidsoap and Icecast and needs an always-on machine, so it is not on Vercel. Nothing about it is deployed yet; see `docs/streaming.md`.
- **apps/web**: Next.js 15 (App Router, RSC), TypeScript strict, Tailwind CSS, shadcn/ui, Framer Motion, next-intl (TR + EN). Plays the live stream with one global `<audio>` (`lib/stream-player.ts`: native HLS on Apple, hls.js elsewhere).
- **apps/api**: Fastify + Socket.IO (Redis adapter, WebSocket transport), Zod, as one Vercel Fluid function. Owns the queue, voting rounds, realtime fanout, and the **station timeline**.
- **apps/engine**: the stream engine (not on Vercel): `src/pieces.ts` (timeline → pieces), `liquidsoap/radiot.liq`, HTTP server for `/hls`, `/radiot.mp3`, `/now`, `/events`.
- **apps/worker**: one Vercel function (`POST /api/media`). Ingest, validation (`ffmpeg -i`), transcode (ffmpeg-static), loudness analysis (EBU R128), cue-in/cue-out, crossfade-start detection, Chromaprint (`fpcalc`) fingerprinting.
- **packages/shared**: Zod schemas, shared TS types, constants, branding (`STATION_NAME = "RadioT"`).
- **packages/db**: PostgreSQL (Neon) + Drizzle ORM, migrations, seed scripts.
- **Audio engine** (`apps/engine`, 2026-11-18): Node + Liquidsoap + Icecast. The engine follows the API timeline, cuts tracks and transition clips to the exact sample, and Liquidsoap plays them as one continuous stream: HLS (AAC 64/128/256k) and an Icecast MP3 fallback. Browsers play that one stream; no mixing in the browser. Postgres still holds the timeline.
- **Storage**: Vercel Blob (browser client uploads + cooked media + artwork). Redis: self-hosted on the Oracle VM (TLS port 6380, `infra/oracle`); moved off Upstash on 2026-11-23 after the free 500k-commands/month quota ran out and took the site down. Postgres: Neon.
- **Live camera**: LiveKit Cloud (dev and prod). Camera-only publish tokens. Server-side rejection of any audio track from performers.
- **Auth**: Better Auth (email magic link + Google). Postgres via Drizzle.
- **Infra**: no local containers. Dev uses hosted Neon/Upstash/Blob (or local Postgres/Redis) plus system ffmpeg/fpcalc. Production = three Vercel projects, see `docs/deploy.md`.
- **Quality**: ESLint, Prettier, Vitest (unit/integration), Playwright (e2e), Turbo cached CI.
- **Observability**: Sentry (errors), PostHog (product analytics), pino logs.
- **Safety**: Cloudflare Turnstile on write endpoints; Redis-backed rate limits; Chromaprint-based DMCA fingerprint blocklist.

## 3. Repo layout

```
radiot/
├── apps/
│   ├── web/              # Next.js (Vercel)
│   ├── api/              # Fastify + Socket.IO (Vercel function: api/index.mjs → dist/index.js)
│   ├── engine/           # stream engine: Liquidsoap + Icecast + Node (always-on machine)
│   └── worker/           # media pipeline (Vercel function: api/media.mjs → dist/vercel.js)
├── packages/
│   ├── shared/           # Zod schemas, types, constants, branding
│   ├── config/           # shared ESLint flat config
│   └── db/               # Drizzle schema, migrations, client
├── infra/
│   ├── load/             # k6 load tests
│   └── scripts/          # one-shot ops scripts (make-demo-tracks.sh)
├── integrations/
│   └── fivem/radiot/     # drop-in FiveM resource (in-game radio), see docs/fivem.md
├── content/
│   └── fallback/         # default.mp3 (committed) + any extra fallback songs (gitignored)
├── docs/
│   ├── architecture.md
│   ├── plan.md
│   ├── deploy.md
│   ├── observability.md
│   ├── streaming.md      # live stream: engine, outputs, local run, deployment notes
│   ├── mobile-playback.md # why mobile playback used to stop
│   ├── ml-models.md      # Demucs / Beat This! / All-In-One
│   ├── progress.md       # skipped tests, known gaps
│   ├── transitions.md    # transition engine: what exists, measurements, open items
│   ├── legal.md
│   └── MARKETING.md
├── CLAUDE.md             # this file
├── README.md
├── turbo.json
├── pnpm-workspace.yaml
└── package.json
```

## 4. Commands

From repo root unless noted:

- `pnpm install` — install everything.
- `pnpm db:generate` — generate a Drizzle migration after editing `packages/db/src/schema`.
- `pnpm db:migrate` — apply Drizzle migrations.
- `pnpm db:seed` — seed settings (fallback playlist import arrives in Phase 2).
- `pnpm dev` — turbo run dev → runs web (3000) + api (4000) + worker (4100) + engine (4200, starts Liquidsoap and Icecast) in parallel.
- `infra/scripts/stream-dev.sh start|stop|status` — the whole stack on this machine's Wi-Fi address, to test the stream on a phone.
- `pnpm lint` — ESLint across all packages.
- `pnpm typecheck` — tsc --noEmit everywhere.
- `pnpm test` — Vitest unit/integration.
- `pnpm test:e2e` — Playwright.
- `pnpm build` — production build.
- `pnpm format` / `pnpm format:check` — Prettier.
- `pnpm fallback:demo` / `pnpm fallback:import` — synthesize demo tracks / ingest `content/fallback/*` (runs the pipeline locally, uploads to Blob).
- `pnpm admin:grant <email> [--revoke]` — make a user admin (they must sign in once first).

## 5. Rules for the agent (non-negotiable)

1. **TypeScript strict** everywhere. No `any` without a `// reason:` comment.
2. **Zod at every boundary** (HTTP, Socket.IO, worker jobs). Share schemas from `packages/shared`.
3. **Never enable the performer mic.** Three-layer enforcement:
   - Client calls `getUserMedia({ video: true, audio: false })`.
   - LiveKit token sets `canPublishSources: [TrackSource.CAMERA]` and `canPublishData: false`.
   - LiveKit server webhook rejects any `track_published` with `kind=audio` from a performer and ends their session.
     Any change to camera code MUST preserve all three layers; add/update the `mic-enforcement.test.ts` suite.
4. **Link imports (owner's decision 2026-11-20).** SoundCloud links are downloaded by the worker with yt-dlp; Spotify links are read for title/artist from the public track page and the same song is downloaded from SoundCloud by search (`scsearch5:`); Spotify audio itself is DRM-protected and never fetched. YouTube links (owner, 2026-11-23) work like Spotify: oEmbed title/channel → SoundCloud search; YouTube audio is never downloaded (ToS, and it blocks server IPs). Apple Music stays an `UnimplementedResolver` stub. Rights confirmation and the fingerprint blocklist apply to imports like uploads.
5. **Rights confirmation** is required on every upload/request. Store user + IP + timestamp + SHA-256 + Chromaprint in `requests` for accountability.
6. **Voting fairness**: one vote per signed-in user per round. No paid vote boosting, ever. Any monetization hook must be cosmetic only.
7. **Fallback never cuts mid-song.** Requested songs interrupt only at the next transition.
8. **Crossfades are computed, not guessed.** Worker precomputes cue-in, cue-out, crossfade-start, and loudness gain. The API ships them as `media` (`trackMedia()`); the browser player applies them.
9. **Stateless API**. All shared state goes through Postgres or Redis (including Socket.IO via `socket.io-redis-adapter`). Enables horizontal scaling.
10. **Shared types only from `packages/shared`.** Web and api must not import from each other directly.
11. **SEO**: every indexable page sets `metadata`, canonical URL, `hreflang`, OG image, and JSON-LD.
12. **Accessibility**: AA contrast, focus states, keyboard nav, `prefers-reduced-motion` respected.
13. **Secrets**: never commit. `.env.example` in every app lists every var.
14. **No destructive git without asking.** Follow the handbook’s git safety protocol.

## 6. Non-obvious decisions (and why)

- **Fastify (not Next.js API routes) for the realtime layer** — kept as its own Vercel project: `src/index.ts` builds the app and `export default app.server`; Vercel routes every path (incl. Socket.IO upgrades) to that one function. Socket.IO clients use `transports: ['websocket']` because long-polling needs sticky sessions.
- **Server-side stream; the timeline is still the plan (2026-11-18, replaces "no streaming server" of 2026-11-16).** Browsers used to fetch tracks and crossfade them, which stopped on phones whenever page JavaScript was throttled (`docs/mobile-playback.md`). Now `apps/engine` plays the timeline into Liquidsoap and everyone hears one HLS/MP3 stream. The API still decides what plays and when (rounds, votes, `station.tick()`, now driven by the engine's polling); rounds store `startedAt` + airtime as before. The stream reaches listeners ~9 s (phones ~13 s) after the engine, so the website shows the track that was on air `streamDelayMs` ago (`trackHeardAt`).
- **Joins are by file position, pieces are cut to the exact sample (2026-11-18).** `apps/engine/src/pieces.ts` queues track | clip | track by the clip's `aFileStartMs` / `handoffFileMs`; ffmpeg cuts every piece (Liquidsoap's own cue-out runs up to ~30 samples long). Tracks are cut at `mixFromMs` so what follows can be chosen after the lock. A clip that is not ready 1.2 s before the queue runs dry is replaced by a Liquidsoap crossfade. Check with `apps/engine/scripts/splice-check.py`.
- **`tick()` is lazy and single-flight.** Called on every station read and by a timer on warm API instances; a cached `radio:due` makes idle reads cheap and a Redis lock (`radio:tick`) makes one caller do the work. A transition < 2 min late keeps its scheduled start so clients that already crossfaded stay aligned.
- **The next track is chosen at lock**, not at transition, and kept in Redis (`radio:next`) so every client prebuffers the same file. If it became ineligible, the transition re-chooses.
- **No cron, no queue.** API → worker is an HTTP call; the worker answers 202 and runs the job in `waitUntil` with 3 attempts. Stuck `ingesting` requests are re-dispatched and the chart view refreshed from `services/maintenance.ts`, throttled by Redis keys (works on Hobby, which only allows daily crons).
- **ffprobe is not used** (no static npm binary). The worker parses `ffmpeg -i` output (`parseFfmpegInfo`). On Vercel the build vendors ffmpeg-static and AcoustID's static `fpcalc` into `apps/worker/vendor/`.
- **Cooked media is 192k CBR MP3** so seeking to the shared position is exact and bandwidth stays reasonable.
- **Transitions are pre-rendered clips, not a live mixer (2026-11-16).** At vote lock the API plans the hand-over from both tracks' analysis (`planTransition` in shared: beatmatch / smooth / tight / cut / quick) and the worker renders one MP3 per pair, cached in `transitions`. The engine joins the playing file, the clip and the next file by file position (no browser involved); a missing or late clip just leaves a plain crossfade done by Liquidsoap. `earliestMixMs` is the floor for every plan because voting closes right before it. Rotation is flow-ordered (`orderForFlow`) but a track is only passed over by one that has waited at least ¾ as long. See `docs/transitions.md`; verify the stream player with `apps/web/scripts/stream-check.mjs` and the joins with `apps/engine/scripts/splice-check.py`.
- **Lock time = currentSong.duration − 10s** (`lockLeadSeconds`, owner's choice 2026-11-16; was 30). At lock, we snapshot votes, pick a winner, mark it `queued`, and announce it as `radio:next` so every client can prebuffer. The UI shows no countdown, just "Voting open" until `round:locked`.
- **Rotation songs are votable** in the same round as new uploads (one vote per user across both). Most votes wins, ties go to new uploads; with zero votes the oldest new upload wins, else the rotation order (`pickRoundWinner`). A rotation winner airs as a `replay`.
- **Round scope = one playing song.** Votes are stored with `(round_id, user_id, request_id)` unique; users can change vote until lock.
- **Audio/video sync for the performer stage**: the stream runs `streamDelayMs` behind the engine, so the stage delays the LiveKit video by the same amount (`delaySeconds={streamDelaySeconds}`); the delay is an estimate good to about 2 s.
- **Uploads stay on air (owner's request 2026-11-16).** Once processed, an upload never leaves the station: after it airs, or "expires" unpicked from the vote, it loops in the rotation (`ROTATION_STATUSES` in `station.ts`, least recently played first). Fallback tracks play only while no uploads exist. New ready uploads still go through the vote first.
- **Vote weighting**: flat. No reputation-weighted votes in v1. Keeps fairness obvious.
- **Magic links without SMTP** are printed in the API log (`SMTP_URL` empty); production uses real SMTP (e.g. Resend).
- **Auth lives on the API, not Next.js** — Better Auth is mounted at `API_URL/api/auth/*`. Web and API are same-site (localhost ports locally; `radiot.app` + `api.radiot.app` in prod with `COOKIE_DOMAIN` set), so the session cookie works for both. Socket.IO reads the same cookie on handshake; anonymous sockets are allowed (listeners).
- **Guest mode (temporary, owner's request 2026-11-15).** There is no sign-in UI: every visitor gets an invisible Better Auth `anonymous` account ("Listener 1234"), so anyone can listen, request, vote and chat. `/sign-in` still works if visited directly (admins use it; a magic link upgrades the guest account). Trade-off against rule 6: a guest can clear cookies to get a fresh account and vote again. Mitigations are per-IP request caps, per-IP rate limits, Turnstile when configured, and multi-account vote flags. Revisit before public launch.
- **Game integration (FiveM) is listen-only.** The resource's server polls `GET /api/public/station` (CORS-open, no auth, 3 s cache) once per game server and pushes to players (with `relayDelayMs` for clock correction); each player's NUI plays the on-air file from Blob at the shared position and switches at `next.startsAt`. Requests/votes stay on the website.
- **Reactions are 3 stickers** (`REACTION_STICKERS` in shared); artwork is SVG in `apps/web/components/stickers.tsx`. The `reactions.emoji` column stores the sticker id.
- **Workspace packages ship built `dist/`** (`shared`, `db`); turbo builds them before `dev`/`typecheck`/`test`.

## 7. Working agreement

- Break work into the phases in `docs/plan.md`. Finish one phase before starting the next.
- After each phase: run `pnpm lint && pnpm typecheck && pnpm test`, fix failures, then post a short status (what shipped, how to run it, what’s next).
- Prefer editing existing files over creating new ones. Don’t add speculative abstractions.
- Don’t write code comments that restate the code. Only write a comment when the _why_ is non-obvious.
- UI changes: if possible, run `pnpm dev` and click through the feature before claiming done. If not possible in this environment, say so explicitly.

### Testing rules (to save time)

- Don't run the full test suite or e2e tests after every change. Only run typecheck, lint and the unit tests for the code you just changed.
- If a test fails, try to fix it once. If it still fails, mark it as skipped with a TODO note in `docs/progress.md` and move on.
- Don't rerun flaky tests multiple times.
- Run the full test suite (including e2e) only ONCE at the very end of a body of work (e.g. after the last phase).

## 8. Status

- [x] Decisions captured
- [x] Phase 1: Foundation — scaffold monorepo, Docker Compose, DB schema, auth, CI (2026-11-14)
- [x] Phase 2: Radio core
- (Phases 2–10 completed 2026-11-14; see docs/progress.md for skipped tests and known gaps)
- [x] Phase 3: Transitions
- [x] Phase 4: Requests
- [x] Phase 5: Voting
- [x] Phase 6: Performer camera
- [x] Phase 7: Social & admin
- [x] Phase 8: SEO & growth
- [x] Phase 9: Polish & load test
- [x] Phase 10: Marketing plan

## 9. Infra notes

- **TypeScript is pinned to `~6.0`** because typescript-eslint supports `<6.1`. Revisit when it adds TS 7 support.
- **Next.js is pinned to 15** (per stack decision) with `@next/eslint-plugin-next@15`.
- **Repo lives at `~/code/radiot`** (moved off the iCloud Desktop 2026-11-16: iCloud evicted files to 'dataless' and builds failed with read timeouts). Don't move it back into iCloud.
- **Ports:** web 3000, api 4000, worker 4100 (Postgres 5432 / Redis 6379 only if you run them locally).
- **Dev machine has 8 GB RAM**: Turbopack + Playwright can swap heavily. Full-stack e2e can be flaky under that pressure.
- Local Vercel CLI is 54.1.0; latest is 65.16.0. Upgrade recommended: `pnpm add -g vercel@latest` (only needed once you want to deploy `apps/web` from this machine).
- LiveKit Cloud project URL + API key/secret go into `apps/api/.env` and `apps/web/.env.local`. Don’t commit them.
- Vercel Blob token (`BLOB_READ_WRITE_TOKEN`) goes into `apps/api/.env` and `apps/worker/.env`; `MEDIA_BASE_URL` is derived from it.
