# Progress notes

Running log of skipped tests, known gaps and environment caveats. Clear entries as they're resolved.

## Skipped tests (TODO)

- **`apps/web/e2e/social-admin.spec.ts`** — marked `test.fixme`. Covers chat (word filter, slow mode),
  reactions, reports, public profiles and admin moderation (delete message, resolve report, audit log).
  It passed end to end once (21 s) and surfaced two real bugs that are now fixed (admin redirected off
  `/admin` before `/api/me` resolved; session refetch flickering the user to signed-out). The remaining
  failure is a click on the admin "audit" tab that stalls until timeout. On the dev machine this
  coincides with heavy memory pressure (8 GB RAM, ~7 GB swap, iCloud `fileproviderd` syncing the repo
  at ~80% CPU). TODO: re-run on a machine without memory pressure / in CI with infra; if it still
  stalls, trace the audit tab's re-render.

- **Guest mode e2e** — `auth.spec.ts`, `home.spec.ts` and the `signIn` helper were updated for guest
  mode (2026-11-15) but not yet re-run (per testing rules, e2e runs once at the end of a body of work).

## Known gaps / not yet verified

- **Lighthouse ≥ 95 / INP < 200 ms** — not measured. Run `pnpm build && pnpm --filter @radiot/web start`
  then Lighthouse (mobile) on `/en`; the dev server and this machine's memory pressure make local numbers meaningless.
  Likely wins if needed: replace `motion` in `OnAir`/`NowPlayingCard` with CSS animations (home first-load JS ~214 kB).
- **k6 load tests** — scripts written (`infra/load`), not executed (k6 not installed here).
- **Google sign-in** — wired but untested (needs OAuth credentials).
- **Turnstile, web push (VAPID), Sentry, PostHog** — env-gated; untested without real keys.
- **Vercel migration (2026-11-16)** — Liquidsoap/Icecast/HLS, BullMQ, S3/RustFS, Mailpit and Docker
  Compose were removed; playback is now browser-side on the station timeline. Not yet verified:
  - A real deploy of the three projects (Fastify `export default app.server` + Socket.IO WebSocket
    upgrades on Vercel; worker `includeFiles: vendor/**` picking up ffmpeg/fpcalc).
  - Two-device sync and crossfade by ear, incl. iOS Safari lock screen / background tabs.
  - Vercel Blob CORS for Web Audio (`crossOrigin="anonymous"` + `MediaElementSource`); if Blob ever
    omits CORS headers, audio plays silent through the GainNode.
  - Existing tracks in the old RustFS bucket are not migrated: re-run `pnpm fallback:import` against Blob.
  - Full-stack e2e (`stage.spec.ts`, `mic-enforcement.spec.ts`, auth via Mailpit) assumed the compose
    stack (local LiveKit, Mailpit). They need LiveKit Cloud keys, and the auth helper must read magic
    links from the API log instead of Mailpit. TODO.
- **Transition engine (2026-11-17)** — see `docs/transitions.md`. Still open:
  - Nobody has listened to the samples yet (`docs/transitions/samples/`, or Admin → Transitions).
  - Deployed 2026-11-18 (migration 0004 on Neon, all three projects). First production clip: "tight", 0.46 LU
    excursion, −3.8 dBTP. Old tracks are re-analysed in the background by `services/maintenance.ts`.
  - No integration tests for the station's side (planning at lock, clip cache, `onTransitionReady`):
    there is no database test harness in `apps/api`. The planner, rotation order and vote-lock
    floor are covered by unit tests in `packages/shared/src/transitions.test.ts`.
  - The browser-side splices (`lib/player.ts`, `lib/align.ts`) were removed on 2026-11-18 when playback moved
    to the server-side stream (`docs/streaming.md`).
- **LiveKit** — only Cloud now (the local `livekit-server` went with Docker Compose).

- **Live stream (2026-11-18, branch `server-stream`, not deployed)** — see `docs/streaming.md`,
  `docs/mobile-playback.md`. Still open:
  - Never run on a real phone: iPhone and Pixel were emulated (Playwright WebKit / Chromium). Locking a real
    iPhone and listening through a track change is the test owed.
  - The engine host does not exist yet (needs HTTPS, Node 22, ffmpeg, Liquidsoap 2.4, Icecast); no load test
    beyond a few local listeners; the longest unattended run was minutes.
  - Transition clips are still rendered by the worker; a slow render means a Liquidsoap crossfade for that
    change. `now playing` on the website runs on a fixed delay estimate (`STREAM_DELAY_MS`), good to ~2 s.
  - Local only: `apps/web/e2e` expects the stack from `infra/scripts/stream-dev.sh`; the e2e suite was not run.
- **Mobile player + station freeze (2026-11-19, branch `mobile-player`, off the deployed `62468bc`)**:
  - Phones and tablets use `SimplePlayer` (`apps/web/lib/player.ts`): one `<audio>`, no Web Audio, no
    clips; track changes run off `timeupdate`/`ended` (they fire on a locked screen), it never pauses
    itself, and drift is fixed by one seek beyond 2 s. Hard cuts instead of crossfades on phones.
    Override with `localStorage.radiotPlayer = 'simple' | 'synced'`. Not yet tried on a real phone.
  - Desktop drift correction is ±0.5 % with `preservesPitch = false` (the old ±4 % time-stretch warbled).
  - UI: reaction meter only animates while moving; no blurred cover / backdrop blur on small screens.
  - Station froze on 2026-11-19 06:53 UTC with round `75532f39` still `open` past its lock time and no
    tick logging anything. Most likely cause: the background ticker on a Vercel instance was frozen inside the
    lock transaction, holding the round's row lock. Fix: no background ticker on Vercel; station
    transactions set `lock_timeout`, `statement_timeout`, `idle_in_transaction_session_timeout`;
    a failed tick no longer fails `/api/now-playing`.
- **Transition repeat + timeline jumps (2026-11-20)**: after every AI clip the engine resumed b at
  `handoffFileMs`, but the clip already holds b alone from `handoffClipMs` to `clipMs` (the 8-14 s
  lead-out), so that stretch played twice (measured on air: 8.00 s) and the program fell that far
  behind the timeline; ~170 hard jumps a day followed. Fixed in the engine (`pieces.ts`, deployed on
  the VM). A 15 s upload from before the 60 s minimum stayed in the replay rotation and broke the
  hand-over after it on every loop; `inRotation()` now skips uploads under `MIN_TRACK_SECONDS`
  (API change, needs the API deploy).
