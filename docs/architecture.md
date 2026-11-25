# RadioT — Architecture

## Goals

- 24/7 live audio, same moment for every listener.
- User-submitted requests + community voting determine the queue.
- Fallback playlist fills gaps and loops.
- Professional crossfades between every track.
- Performer can appear live on camera (video-only) while their song plays.
- Mobile-first web app, SEO-ready, built for growth and horizontal scaling.

## High-level topology

Everything is on Vercel. There is no always-on audio server: the station is a **timeline in
Postgres**, and every listener's browser plays it from the same files at the same position.

```
            ┌──────────────────────────── Vercel ────────────────────────────┐
 browser ──►│ apps/web  (Next.js)          radiot.app                         │
   │        └────────────────────────────────────────────────────────────────┘
   │ GET /api/now-playing (timeline + server clock)      ┌─────────────────────┐
   │ Socket.IO over WebSocket (radio:now, radio:next…) ─►│ apps/api  Fastify   │──► Neon Postgres
   │                                                      │ + Socket.IO (Fluid) │──► Upstash Redis
   │                                                      └──────┬──────────────┘
   │                                         POST /api/media     │  ▲ POST /internal/worker-event
   │                                                      ┌──────▼──┴───────────┐
   │                                                      │ apps/worker         │ ffmpeg-static, fpcalc
   │                                                      └──────┬──────────────┘
   │  GET cooked/*.mp3 (Range, from the shared position)          │ put cooked/, art/
   └───────────────────────────────────────────────► Vercel Blob (CDN) ◄── browser uploads raw/
                                                     LiveKit Cloud (performer camera, webhook → api)
```

## Components

### apps/web (Vercel)

- Next.js App Router, React Server Components.
- Tailwind + shadcn/ui, Framer Motion (respects `prefers-reduced-motion`).
- next-intl (TR + EN), route-based locales.
- Persistent player via a `<RadioProvider>` mounted in the root layout: two `<audio>` decks routed through Web Audio (`lib/player.ts`). Route changes do NOT remount it.
- Media Session API for lock-screen controls and artwork.
- PWA manifest + service worker (cache shell, not the audio stream).
- Dynamic OG images via `@vercel/og` for now-playing, song-won, profile, chart pages.
- Reads realtime state from Socket.IO (WebSocket transport only) and media files from Vercel Blob.
- LiveKit viewer uses subscribe-only token.

### apps/api (Fastify on Vercel)

- Fastify 5 + `@fastify/cors`, `@fastify/helmet`, `@fastify/rate-limit`. `src/index.ts` exports the
  Node `http.Server`; Vercel runs it as one Fluid function (`api/index.mjs`) that also accepts
  Socket.IO WebSocket upgrades. Locally the same module calls `listen()`.
- Socket.IO with the Redis adapter, so broadcasts reach sockets on every function instance.
- Zod schemas from `packages/shared` at every HTTP/WS boundary.
- Better Auth server, Drizzle Postgres adapter.
- Owns:
  - Request lifecycle: create → Blob client-upload token → confirm → `POST WORKER_URL/api/media`.
  - **The station timeline** (`services/station.ts`), see below.
  - LiveKit token minting (camera-only) + webhook sink.
  - Admin API (skip = lock + start the next track now).
- Upkeep without cron (`services/maintenance.ts`): re-dispatch requests stuck in `ingesting`
  (every 10 min) and refresh the weekly chart (hourly), triggered by station reads and deduplicated
  with Redis keys.

### The station timeline (replaces Liquidsoap)

- A round = one track on air: `startedAt` (when its cue-in went on air) and `durationMs` = airtime =
  `cueOut − cueIn − crossfade`. The next track starts at `startedAt + durationMs`; the outgoing track
  keeps playing under it for its crossfade length.
- `tick()` advances the timeline: at `lockAt` it locks the round, picks the next track (vote winner,
  else the rotation) and announces it (`radio:next`, stored in Redis) so clients can prebuffer; at the
  end of airtime it starts that track. A transition that runs late by < 2 min keeps the scheduled start
  (`SEAMLESS_GRACE_MS`) so clients that already crossfaded stay on the timeline; later than that (no
  one was listening) the next track starts now.
- Nothing runs on its own: `tick()` is called by every `/api/now-playing` and `/api/public/station`
  read and by a timer on warm API instances. It is cheap when nothing is due (cached `radio:due`) and a
  Redis lock makes exactly one caller do the work.
- Listeners poll at `dueAt` (+ jitter), so transitions happen on time while anyone is listening.

### Browser playback (`apps/web/lib/player.ts`)

- Clock: each poll returns `serverTime`; the lowest-RTT sample gives the device's clock offset.
- Join: load the on-air file with a media fragment `#t=<cueIn + (serverNow − startedAt)>` and fade in.
- Transition: the announced next track is preloaded on the second deck and started at `startsAt` with an
  equal-power crossfade of the outgoing track's `crossfadeMs`, scheduled with `setValueCurveAtTime`.
  Per-track `gainDb` is applied with a GainNode.
- Drift: every 2 s, drift < 1 s is absorbed by ±4% playback rate; larger drift seeks.
- iOS: both decks are unlocked with a silent clip inside the first tap.

### apps/worker (Vercel function)

`POST /api/media` (shared-secret header) acknowledges with 202 and processes in `waitUntil`, with up to
three attempts. The pipeline: download (Blob or the direct URL, SSRF-guarded) → probe (`ffmpeg -i`,
parsed) → in parallel: transcode to 192k CBR MP3 (exact seeking), artwork, EBU R128 loudness, RMS
envelope, Chromaprint → analysis (cue points, crossfade, gain) → DMCA fingerprint check → DB → report to
the API. `pnpm build` vendors static `ffmpeg` and `fpcalc` binaries for Linux.

### Live camera (LiveKit Cloud)

- Room per live broadcast session (one performer at a time; room name = `radiot-stage`).
- Tokens minted by the API only after:
  - User is authenticated, `age_confirmed_adult = true`, not banned.
  - The authenticated user owns the currently-playing request (or is an admin with a kill token).
- Performer grant: `canPublish: true`, `canPublishData: false`, `canPublishSources: [TrackSource.CAMERA]`.
- Listener grant: `canSubscribe: true, canPublish: false`.
- LiveKit webhook `track_published` handler: if `track.source === MICROPHONE` or `track.type === AUDIO`, call `removeParticipant()` and insert a `mic_violation` row.
- Session ends automatically: when request transitions off `now_playing`, API disconnects the performer after a 3s grace.
- Admin kill switch: API `/admin/stage/kill` endpoint removes all performers.

### Data layer

- **Postgres** via Drizzle. Core tables:
  - `users`, `sessions`, `accounts` (Better Auth managed).
  - `profiles` (badges, displayName, avatarUrl, locale).
  - `requests` (id, user_id, source: 'upload'|'url', raw_url, storage_key, title, artist, artwork_url, duration_ms, lufs, true_peak, cue_in_ms, cue_out_ms, crossfade_start_ms, fingerprint, sha256, status: 'ingesting'|'ready'|'queued'|'playing'|'played'|'rejected'|'expired', terms_accepted_at, ip_hash, created_at).
  - `fallback_tracks` (same analysis columns, no user).
  - `rounds` (id, current_request_id or fallback_track_id, started_at, lock_at, ends_at, winner_request_id).
  - `votes` (round_id, user_id, request_id, created_at, UNIQUE(round_id, user_id)).
  - `reactions` (user_id, emoji, created_at).
  - `chat_messages` (user_id, body, created_at, muted_until, deleted_at).
  - `live_sessions` (user_id, request_id, livekit_room, started_at, ended_at, end_reason).
  - `mic_violations` (user_id, request_id, created_at, detail).
  - `reports` (reporter_id, target_user_id, target_kind, target_id, reason, created_at, resolved_at).
  - `admin_actions` (admin_id, action, target, metadata, created_at).
  - `settings` (singleton JSON: lockLeadSeconds, roundExpiryCount, maxUploadMb, maxDurationMinutes, crossfadeDefaultMs, fallbackShuffle, requestsPerUserPerHour, lufsTarget, …).
  - `dmca_blocklist` (fingerprint, reason, created_at).
- **Redis** (Upstash): Socket.IO adapter, rate limits, now-playing / up-next / tick lock, maintenance throttles.
- **Vercel Blob** (public store, unguessable keys): raw uploads (`raw/`, uploaded by the browser with a scoped client token), cooked MP3s (`cooked/`), artwork (`art/`).

### Realtime channels

- `radio:now` — a new track went on air.
- `radio:next` — the next track and its start time (at lock).
- `radio:listeners` — listener count.
- `queue:update` — ready list changes.
- `round:update` — vote counts, lock countdown.
- `round:locked` — winner announced.
- `reactions` — floating emoji.
- `chat:message` — new chat.
- `stage:state` — camera up/down.

### Transition algorithm (deterministic)

At ingest, the analyzer produces:

- `gain_db` = `targetLufs − integratedLufs` clamped so `truePeak + gain_db ≤ −1.5 dBTP`.
- `cue_in_ms` — first sample where RMS exceeds `-50 dBFS` sustained ≥ 200 ms.
- `cue_out_ms` — last sample where RMS exceeds `-40 dBFS` sustained ≥ 200 ms.
- `crossfade_start_ms` — latest moment within the last 20s where RMS drops ≥ 6 dB below the track's loudest 10s window.
- `crossfade_duration_ms` — clamp(`cue_out_ms − crossfade_start_ms`, 2000, 10000).

The API hands these to browsers as `media` (`trackMedia()` in `packages/shared`); the player applies
the cue points, `gainDb` and an equal-power crossfade of `crossfadeMs` (see Browser playback).

### Voting & rounds

- A round opens when a song starts playing. `round.current_request_id` or `round.fallback_track_id` is set.
- All `requests.status = 'ready'` are candidates.
- Users vote once per round; `UNIQUE(round_id, user_id)` enforces it. Vote can be changed until `lock_at`.
- `lock_at = now_playing.started_at + duration − lockLeadSeconds`.
- At lock, API picks top by vote count (ties → earliest `created_at`), marks it `queued` and announces it as `radio:next`. If no candidates, the next rotation track is announced instead.
- Unplayed requests increment `rounds_waited`; expire when `rounds_waited ≥ roundExpiryCount`.

### Security / abuse

- Cloudflare Turnstile on request submit, chat send, vote (first vote per round).
- Redis token-bucket rate limits per user and per IP for every write endpoint.
- Audit log (`admin_actions`) for every admin action.
- Chromaprint fingerprint matched against `dmca_blocklist` at ingest; matched requests auto-reject.
- Rights checkbox stored with timestamp + IP hash.
- Ban table: user bans and IP bans separately.

### SEO

- Metadata API on every page; canonical + `hreflang`.
- `app/sitemap.ts` generated from DB: home, `/history/[id]`, `/u/[handle]`, `/charts/weekly`, static pages.
- JSON-LD:
  - Home: `RadioStation` + `BroadcastService` + `MusicRecording` (currently playing).
  - Song pages: `MusicRecording`.
  - Profiles: `ProfilePage`.
- Dynamic OG images for every indexable page, cached at the edge.
- `/embed` route: a lightweight server-rendered player other sites can iframe.

### Scaling

- Vercel scales web, api and worker automatically; Socket.IO instances share broadcasts via Redis.
- Audio is plain files on Blob's CDN, so audience size does not load any of our servers.
- Timeline reads are a couple of Redis GETs when nothing is due.

### Known trade-offs

- Listeners are in sync within the accuracy of their clock estimate and buffering (typically < 0.3 s),
  not sample-exact. Good enough for radio and for the performer stage.
- A tab that was frozen (phone locked, laptop asleep) resyncs when it wakes; it can miss a crossfade.
- No Icecast URL any more: external players can't "tune in" to a stream URL. Embeds use `/embed`; the
  FiveM resource does the same timeline sync in its NUI page.
- Raw uploads are public under unguessable keys (Blob store is public).
