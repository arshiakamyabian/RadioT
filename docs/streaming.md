# Live stream (server-side playout)

Since 2026-11-18 (owner's request) RadioT plays one continuous stream made on a server, instead
of every browser fetching tracks and crossfading them itself. Every device hears the same
program. This replaces the "the timeline is the station" design; `docs/mobile-playback.md`
explains why.

**Not on Vercel.** The stream needs a process that runs all the time (Liquidsoap and the engine),
which Vercel functions are not. The website, API, worker, voting and chat stay on Vercel; only the
engine needs a machine of its own. Nothing was deployed as part of this work.

## Overview

```
 Vercel                                     Engine host (always on)
┌────────────┐  GET /api/now-playing  ┌──────────────────────────────────────────────┐
│ apps/api   │◄───────────────────────│ apps/engine  (Node)                          │
│ votes,     │  what is on air, what  │  - follows the API timeline                  │
│ rounds,    │  is next, transition   │  - downloads tracks + clips as local FLAC    │
│ transition │  clips                 │  - tells Liquidsoap which piece to play next │
│ plans      │                        │  - serves /hls, /radiot.mp3, /now, /events   │
└─────▲──────┘                        └───────┬───────────────────────▲──────────────┘
      │ render job                            │ telnet (queue)        │ on-air callback
┌─────┴──────┐                        ┌───────▼───────────────────────┴──────────────┐
│ apps/worker│  stems, clips (MP3)    │ Liquidsoap: gapless pieces, fallback         │
│ analysis + │───────────────────────►│ crossfade, limiter, encoders                 │
│ clip render│        (storage)       └───────┬──────────────────────────────┬───────┘
└────────────┘                         HLS segments (AAC 64/128/256k)    MP3 128k
                                              │                              │
                                       engine /hls/*                  Icecast ──► engine /radiot.mp3
                                              │                              │
                                              └──────────► listeners ◄───────┘
┌────────────┐   /now + /events (SSE)
│ apps/web   │◄───────────────────────  what is on air, delayed to match the audio
│ (Vercel)   │   <audio> plays /hls/radiot.m3u8 (native on Apple, hls.js elsewhere)
└────────────┘
```

| Part         | Where                               | Job                                                                                |
| ------------ | ----------------------------------- | ---------------------------------------------------------------------------------- |
| API timeline | `apps/api` (`station.ts`)           | Decides what plays and when: votes, rounds, rotation, transition plans. Unchanged. |
| Worker       | `apps/worker`                       | Analyses songs, renders each transition into one clip. Unchanged.                  |
| Engine       | `apps/engine`                       | Turns the timeline into pieces for Liquidsoap; serves the outputs and the state.   |
| Liquidsoap   | `apps/engine/liquidsoap/radiot.liq` | Plays the pieces gaplessly, crossfades where asked, limits peaks, encodes.         |
| Icecast      | started by the engine               | Holds the MP3 mount for old devices (proxied by the engine at `/radiot.mp3`).      |
| Player       | `apps/web/lib/stream-player.ts`     | One `<audio>` element; recovery from drops, network changes and sleep.             |

## How a transition reaches the stream

The API plans each hand-over (`planTransition`: stem-aware and beat-matched from the saved `ai`
analysis; band curves from the DSP analysis for songs without it; a plain crossfade for songs
with neither). The worker renders that plan into one clip: a few seconds of the old song, the
overlap, then the new song until it is safe to hand back.

**What Liquidsoap does live, and what it does not.** Liquidsoap does not mix stems itself. It has
no pitch-preserving tempo glide and no way to automate separated stems against each other
sample-accurately, which beat-matching needs. So the mix is rendered ahead by the worker
(`renderTransition`, tested), and Liquidsoap joins it into the stream live, by file position:

```
song A [cursor … clip.aFileStartMs)  +  clip [0 … clipMs)  +  song B [clip.handoffFileMs … ]
```

The renderer defines these positions exactly, so the joins can be exact. Everything is converted to
FLAC by the engine with ffmpeg (the decoder the renderer uses) so positions mean the same thing
whatever the MP3 encoder padding.

One detail matters: Liquidsoap starts a `liq_cue_in` exactly, but ends a `liq_cue_out` late, by 2 to
33 samples (up to 0.75 ms) in the tests. That repeats a sliver of audio at every join. So the
engine cuts each piece to the exact sample with ffmpeg (`MediaCache.cut`, 16-bit WAV) and queues
whole files; a file ends exactly where it should. Measured with
`apps/engine/scripts/splice-check.py` on two real transition clips (a "smooth" and a "cut"): the
track, the clip and the next track each sit **+0 samples** from the plan, largest difference from
an offline rebuild under 1e-4 (float rounding). The same pieces came out of the HLS encoder with a
constant offset and no gaps or clicks over a 210 s capture spanning three transitions (see
"Verified" below).

Liquidsoap performs a transition itself in one case: **fallback**. If a clip is not ready when
it is needed (a late render, or a song with no analysis), the engine asks Liquidsoap for a
plain equal-power crossfade of the length the plan gave (`liq_cross_duration` on the ending piece).
The station never waits for a clip and never leaves a gap.

Timing is decided by `apps/engine/src/pieces.ts` (unit-tested): a track is queued in pieces, cut
at `mixFromMs` (the earliest point any transition out of it can start, sent by the API). When
voting has locked and the clip is on disk, the rest of the old song, the clip and the start of the
new song are queued; otherwise, as late as 1.2 s before the queue runs dry, the fallback is
chosen. A clip is only used if it can still start exactly on its mark.

## Voting lock

Voting still locks in the API. With the AI analysis the exit point of the song on air is known in
advance (it depends on that song alone), so the lock can come `aiLockLeadSeconds` (default 5 s)
before the mix starts instead of 10 s. The heavy work (stems, beats, sections) was done at import
and the likely winner's clip is rendered ahead (`prewarm`); only the winner's clip render and a
quick splice remain at lock time. If the winner's clip is not ready in time, the fallback
crossfade plays, which is the cost of closing voting late.

## What listeners see

The stream reaches a listener about 9 s after the engine puts a piece on air (encoding, 2-second
segments, the player's distance behind the live edge), 4 s more on phones. So `now playing` is
published by the engine with the delay, not by the API:

- `GET {engine}/now` and `GET {engine}/events` (Server-Sent Events) return `now`, `next`,
  recent `history` and `streamDelayMs` (`StreamState` in `packages/shared/src/stream.ts`).
- The website shows the track that was on air `streamDelayMs` ago (`trackHeardAt`), so the title
  changes when the listener hears the change. The progress bar and the live video on the stage
  (`DelayedVideo`) use the same delay.
- The delay is an estimate (`STREAM_DELAY_MS`, 9000 by default), good to about a segment (2 s).
  Safari's native player does not report the stream position, so it cannot be measured exactly.

## Verified

On the local stack (three songs in rotation, two with the model analysis, one DSP-only):

- **Transitions through the stream.** A 210 s capture of the HLS stream, spanning three
  transitions (a clip each: `cut`, `smooth`, `tight`), had no silence after the first 0.5 s of
  start-up, no sample step above 0.45 (no clicks), integrated loudness -14.4 LUFS (target -14)
  and a sample peak of -0.1 dBFS after AAC encoding.
- **Joins.** Sample-exact against the plan on two real clips (above).
- **Players.** `stream-check.mjs` on emulated iPhone 15 (WebKit, native HLS), Pixel 7 and desktop
  (Chromium, hls.js), through `localhost` and the machine's Wi-Fi address: all checks pass
  (details and limits in `docs/mobile-playback.md`).
- **Unit tests.** Planner (`pieces.test.ts`), player (`stream-player.test.ts`).

## Outputs

| URL (on the engine) | What                                                                                            |
| ------------------- | ----------------------------------------------------------------------------------------------- |
| `/hls/radiot.m3u8`  | HLS master playlist: `aac_64k`, `aac_128k`, `aac_256k` variants, 2 s segments, 10 in the window |
| `/radiot.mp3`       | Icecast MP3 128 kbps (old devices; also the player's fallback if HLS keeps failing)             |
| `/now`, `/events`   | state as JSON / Server-Sent Events                                                              |
| `/health`           | engine state: last poll, what is on air, what is queued, resync count                           |

## Run it locally

Needs `brew install liquidsoap icecast ffmpeg` (Liquidsoap 2.4 from Homebrew has the FFmpeg
encoders used here), Postgres and Redis.

```bash
infra/scripts/stream-dev.sh start    # worker, api, engine (+ Liquidsoap, Icecast), web
infra/scripts/stream-dev.sh status
infra/scripts/stream-dev.sh stop
```

`STREAM_DB=<postgres url>` uses a database other than `apps/api/.env`; `LOCAL_MEDIA=<dir>` is the
folder served as the media store; `WEB=0` skips the website. The script prints the engine URL and
the website URL on this machine's Wi-Fi address.

**On a real phone.** Put the phone on the same Wi-Fi as the computer and open the `website` URL
the script prints (it looks like `http://192.168.x.x:3000`). It is plain `http`: some features
that need a secure page (`navigator.audioSession`, for one) may be unavailable, and the lock-screen
controls were not checked over `http` on a real phone.
Some office or guest Wi-Fi networks block devices from reaching each other; if the page does not
open, use a phone hotspot or home Wi-Fi. A Wi-Fi address changes when the network changes.

**Checks.**

```bash
pnpm --filter @radiot/engine test                 # planner (file-position joins, clip/fallback timing)
node apps/web/scripts/stream-check.mjs            # iPhone / Pixel / desktop emulation against the local stack
```

`stream-check.mjs` needs Playwright browsers (`npx playwright install chromium webkit`).

## Configuration (`apps/engine/.env.example`)

| Variable                              | Default                 | Meaning                                                     |
| ------------------------------------- | ----------------------- | ----------------------------------------------------------- |
| `API_URL`                             | `http://localhost:4000` | The API whose timeline the engine plays.                    |
| `PORT`, `HOST`                        | `4200`, `0.0.0.0`       | Where the engine listens.                                   |
| `CORS_ORIGINS`                        | `*`                     | Origins allowed to call the engine from a browser.          |
| `RUN_DIR`                             | `./run`                 | Media cache, HLS segments, logs.                            |
| `CACHE_MAX_MB`                        | `4096`                  | Cache limit; least recently used files go first.            |
| `SPAWN`                               | `1`                     | Start Liquidsoap and Icecast with the engine.               |
| `HLS_SEGMENT_SECONDS`, `HLS_SEGMENTS` | `2`, `10`               | Segment length and live window.                             |
| `STREAM_DELAY_MS`                     | `9000`                  | Delay between the engine's clock and what a listener hears. |
| `ICECAST_*`, `LIQ_TELNET_PORT`        | see file                | Local ports and passwords (Icecast listens on loopback).    |

The API sends two new fields with every track (`mixFromMs`, `fileMs`), and has the setting
`aiLockLeadSeconds`.

## Running it for real

Not done yet, and not on Vercel. What it needs:

- **A small always-on machine** with Node 22, ffmpeg, Liquidsoap 2.4 and Icecast. For scale: on
  the M1 MacBook Air used for testing, Liquidsoap (decoding, three AAC encoders, one MP3 encoder)
  used about 15 % of one core and 58 MB of memory while other work was running; no server
  was measured. Run `pnpm --filter @radiot/engine start` under a supervisor (systemd or similar). The engine
  restarts Liquidsoap and Icecast itself if they exit. It starts playing at the position the API
  says is on air, so a restart costs a few seconds of silence.
- **HTTPS in front of it.** The website is https, and browsers block or rewrite http audio and
  event streams loaded into an https page, so the engine must be served over https too. Put Caddy
  or nginx in front; allow long-lived responses on `/events` and `/radiot.mp3`.
- **A CDN for the HLS segments** once there is real audience: segments never change and are sent
  as cacheable, the playlists as `no-store`. Without a CDN the engine host sends the stream to
  every listener itself: 128 kbps is 16 kB/s per listener, so 1,000 listeners is about 128 Mbit/s.
- **Web settings on Vercel:** `NEXT_PUBLIC_ENGINE_URL` (the engine's public URL). The API needs
  nothing new; `CORS_ORIGINS` on the engine should list the website's origin.
- **If the engine host is lost,** the website still loads and voting still works, but there is no
  audio until it is back. There is no second engine; a backup would be a second host started
  from the same `.env` (listeners reconnect on their own).

## Known limits

- **Live is not instant.** About 9-13 s from the engine to a listener's ears. Voting results and
  the title are shown on that delay; the "next" panel can show a result a few seconds before the
  listener hears the end of the current song.
- **No transition renders on the engine host.** Clips are still rendered by the worker, so the
  worker must keep up; a slow render means the fallback crossfade for that one change.
- **After a skip or an API outage** the engine rejoins the timeline with a hard cut (it flushes
  the queue). Normal song changes never cut.
- **Not tested:** a real phone (see `docs/mobile-playback.md`), more than a handful of
  simultaneous listeners, a long unattended run (the longest run was a few minutes), and
  Icecast behind a CDN.
