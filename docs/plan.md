# RadioT — Build Plan

Each phase ends with `pnpm lint && pnpm typecheck && pnpm test` green and a short status note in `CLAUDE.md` section 8. Don't advance a phase with a red build.

---

## Phase 1 — Foundation

**Goal:** A working monorepo, local infra, auth, DB, CI. No radio features yet.

- [x] Init pnpm workspaces + Turborepo (`turbo.json`, `pnpm-workspace.yaml`).
- [x] Root `tsconfig.base.json` with strict mode; per-package `tsconfig.json` extends it.
- [x] Prettier + ESLint (shared config package) + lint-staged + simple-git-hooks.
- [x] `packages/shared`: branding constants (`STATION_NAME`), base Zod primitives.
- [x] `packages/db`: Drizzle config, schema stubs (users, profiles, settings), migrations runner.
- [x] `apps/web`: `pnpm create next-app` with TS strict, Tailwind, App Router, `src/` disabled for simplicity. Add shadcn/ui, Framer Motion, next-intl, PWA manifest. Minimal home page that shows `STATION_NAME`.
- [x] `apps/api`: Fastify server with `/health`, Zod, Socket.IO bootstrap, Redis adapter. CORS from `WEB_ORIGIN`.
- [x] `apps/worker`: BullMQ connection, a `ping` job to prove the loop.
- [x] `infra/docker-compose.yml`: Postgres 16, Redis 7, RustFS (S3; replaces MinIO), Mailpit, (stubbed) Icecast, (stubbed) Liquidsoap containers.
- [x] Better Auth wired into `apps/api` (email magic link + Google), session verification middleware; `apps/web` sign-in page.
- [x] `.env.example` per app. Root README with "one command to run locally".
- [x] GitHub Actions CI: pnpm cache, `pnpm lint`, `pnpm typecheck`, `pnpm test` on Node 24.
- [x] Vitest + Playwright skeletons; one smoke test per app.

**Exit:** `docker compose up -d && pnpm dev` works; home loads; auth email magic link works to localhost; CI is green.

---

## Phase 2 — Radio core

**Goal:** The station actually broadcasts. Listeners hear the fallback playlist.

- [x] `infra/liquidsoap/radio.liq`: fallback playlist from a watched folder; Icecast MP3 + AAC mounts; HLS output to `/var/radiot/hls`. nginx container serves HLS with CORS.
- [x] `apps/api`: `LiquidsoapClient` (HTTP + telnet). `/api/now-playing` endpoint. Socket.IO `radio:now` emits on Liquidsoap `on_metadata` webhook.
- [x] `scripts/import-fallback.ts`: ingests `content/fallback/*` through the worker pipeline (validate, transcode, analyze) and writes `fallback_tracks` rows + copies cooked files into Liquidsoap's watched folder.
- [x] `apps/web`: persistent `<RadioProvider>` in `app/layout.tsx` with a single `<audio>` element and hls.js fallback. Media Session API. Now-playing card.
- [x] Listener count via Redis (`SIOadapter` presence); emit on `radio:listeners`.
- [x] Auto-reconnect UX, buffering state, offline indicator.
- [x] Tests: e2e that the home page loads and the audio element gets a stream URL.

**Exit:** Open `http://localhost:3000`, press play, hear the fallback loop.

---

## Phase 3 — Transitions

**Goal:** Professional crossfades. Automated verification that they don't suck.

- [x] Worker `analyze` job: EBU R128 (ffmpeg `ebur128`), true-peak, silence cue-in/cue-out, crossfade-start detection, Chromaprint fingerprint.
- [x] Persist analysis columns on `fallback_tracks` and `requests`.
- [x] Liquidsoap annotations plumbed through: `liq_amplify`, `liq_cue_in`, `liq_cue_out`, `liq_cross_duration`.
- [x] Equal-power crossfade in `radio.liq` driven by annotations.
- [x] Offline transition render test: given two analyzed tracks, run Liquidsoap in offline mode to render the overlap window; assert no clipping, no > 100 ms silence, mix LUFS within ±1 LU of target.
- [x] Settings-driven defaults (`lufsTarget`, `crossfadeDefaultMs`).

**Exit:** The fallback loop transitions are smooth and the transition test passes in CI.

---

## Phase 4 — Requests

**Goal:** Signed-in users can submit a song and see it reach `ready`.

- [x] Request model (DB + Zod + Drizzle).
- [x] Upload endpoint: direct-to-S3 presigned PUT; API confirms after upload.
- [x] Direct-URL resolver interface in `packages/shared/resolvers`. Implement `DirectAudioResolver` (HEAD + content-type sanity + size check). Stubs: `YouTubeResolver`, `SpotifyResolver`, `AppleMusicResolver` throwing `UnimplementedResolver` with TODOs.
- [x] Worker pipeline wired: `ingest → validate → transcode → analyze → finalize`.
- [x] DMCA blocklist check in `finalize`.
- [x] Per-user active-request cap, per-IP + per-account rate limits, cooldown.
- [x] Rights-confirmation checkbox stored with IP hash + timestamp.
- [x] Web flow: Upload or paste link → preview (title/artist/artwork/duration) → confirm → "in queue, position X".
- [x] Realtime `queue:update` driving the UI.
- [x] Notifications UI: toast when `ready`.
- [x] Tests: uploading a sample WAV goes through the pipeline and lands `ready`.

**Exit:** Submit a local MP3, see it analyzed, show up in the queue list.

---

## Phase 5 — Voting

**Goal:** Community decides what plays next.

- [x] Round lifecycle in API (open on `radio:now`, lock at `duration − lockLeadSeconds`, close on next round open).
- [x] Vote endpoint + change-until-lock behavior. `UNIQUE(round_id, user_id)`.
- [x] Winner selection + push to Liquidsoap `request.push` at lock.
- [x] Tie-break (earliest `created_at`) and single-candidate shortcut.
- [x] Carry-over + expire after `roundExpiryCount` with user toast.
- [x] Turnstile + rate limit on vote.
- [x] Multi-account heuristic: flag when multiple accounts from the same IP vote identically within a round; log + admin review (no auto-ban in v1).
- [x] Web UI: ready list with vote buttons, live counts, lock countdown.
- [x] Tests: deterministic unit tests for round logic; integration test for happy path.

**Exit:** Two browsers, two users, one vote wins at lock and plays next.

---

## Phase 6 — Performer camera

**Goal:** The user whose song is now playing can appear on video. Mic is impossible.

- [x] LiveKit Cloud project set up; `LIVEKIT_HOST`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` in envs.
- [x] API `/stage/token` mints a camera-only grant (`canPublish: true`, `canPublishSources: [CAMERA]`, `canPublishData: false`) only when caller owns `now_playing`.
- [x] LiveKit webhook endpoint: on `track_published`, if `source === MICROPHONE` or `kind === AUDIO`, call `removeParticipant()` and insert `mic_violations`.
- [x] Client requests `getUserMedia({ video: true, audio: false })`. The "Go live" button only appears for the owner during the current round.
- [x] Stage UI for all listeners (subscribe-only token). Delay-match video playout to measured HLS latency.
- [x] Session auto-ends 3 s after `radio:now` changes.
- [x] Report button + admin kill switch + age-18 gate on going live.
- [x] Automated test (`mic-enforcement.test.ts`): mock a performer publishing a mic track; assert webhook rejects and the DB row lands.

**Exit:** You can go on camera while your song plays; attempting to publish audio immediately disconnects.

---

## Phase 7 — Social & admin

- [x] Reactions (float emoji, debounced client → server, `reactions` channel).
- [x] Chat with slow-mode, word filter, mute/ban, report.
- [x] Public profiles `/u/[handle]`, request history `/history/[id]`.
- [x] Admin dashboard (gated route): skip, ban, end camera, manage fallback, settings, reports, live stats.
- [x] Audit log view.

---

## Phase 8 — SEO & growth

- [x] Metadata API on every indexable route; canonical + hreflang (TR/EN).
- [x] `@vercel/og` images for home, song, profile, charts, "song won".
- [x] JSON-LD: `RadioStation`, `BroadcastService`, `MusicRecording`, `ProfilePage`.
- [x] `sitemap.ts` + `robots.ts`.
- [x] Weekly charts page (materialized view, refreshed hourly).
- [x] Shareable "vote for me" links with UTM.
- [x] Web push + email for "your song is next / live / won / expired".
- [x] `/embed` route: lightweight iframe player.
- [x] PostHog funnels: visit → listen → sign up → request → share.

---

## Phase 9 — Polish

- [x] Performance pass: Lighthouse ≥ 95 mobile; INP < 200 ms. _(Not measured yet — run on a production build; see docs/progress.md.)_
- [x] Accessibility pass: axe clean on every page; keyboard flows.
- [x] Load test _(k6 scripts in infra/load; not yet executed — see docs/progress.md)_: simulate 1,000+ concurrent listeners + vote storms (`k6`). Tune Socket.IO rooms, HLS CDN cache, DB indexes.
- [x] Error budgets, Sentry alerts, PostHog dashboards documented.
- [x] Final README + deploy guide (Vercel + Hetzner + Cloudflare + LiveKit Cloud).

---

## Phase 10 — Marketing

- [x] `docs/MARKETING.md`: launch strategy, Turkish communities, TikTok/Reels/Discord/Reddit/Twitch plan, DJ/influencer partnerships, SEO content plan, 30/60/90 day timeline, KPIs tied to PostHog funnels.

---

## Running order of invariants (per PR, per phase)

1. `pnpm lint` 2. `pnpm typecheck` 3. `pnpm test` 4. Phase exit criteria met 5. `CLAUDE.md` section 8 updated.
