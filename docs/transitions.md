# Transitions (branch `fable-transitions`)

Status (2026-11-18): deployed to production (migration 0004 applied on Neon, worker/api/web
redeployed). Clips render on Vercel; the first one ("tight", 11.1 s overlap) measured 0.46 LU excursion and
−3.8 dBTP. Still nobody has listened to it by ear.

## What exists

- **Analysis** (`apps/worker/src/media/features.ts`): loudness curve, energy-based cues, intro type
  (cold / fade-in / soft), outro type (hard / fade / tail / soft), BPM, kick-anchored beat grid,
  downbeats, key (Camelot), energy, vocal activity (REPET heuristic). Pure TypeScript so it runs on
  the Vercel worker. Tempo matches librosa on all 12 songs (half/double time folded).
- **Planner** (`packages/shared/src/transitions.ts`): picks beatmatch / smooth / tight / cut / quick
  per pair; bass swap; shortens or ducks when two vocals overlap; `orderForFlow` for the rotation.
- **Renderer** (`apps/worker/src/media/render.ts`): one clip per pair (A lead-in, overlap, B
  lead-out) with WSOLA tempo glide, zero-phase band split, leveller, true-peak limiter, metrics.
- **API**: plan at vote lock, clip cache (`transitions` table, migration 0004), speculative
  pre-render, admin preview endpoints, new settings (`transitionMode`, `transitionMaxSeconds`, ...).
- **Player** (`apps/web/lib/player.ts`): splices into the clip by cross-correlation and back out
  with a delay line; falls back to the plain crossfade whenever a clip is missing or late.
- **Admin**: Settings has the transition options (`transitionMode` is a dropdown); the Transitions
  tab plans and renders any two tracks and plays the clip with its measurements.
- **Lab**: `apps/worker/scripts/lab.ts` (analyze / plans / render / samples), samples and
  `metrics.json` in `docs/transitions/samples/` (MP3s are gitignored: copyrighted excerpts).

## Decisions

- No Liquidsoap: it was removed earlier; transitions are pre-rendered clips, not a live mixer.
- Loudness check = no dip below / bump above the two songs' own levels (3 s windows), not one
  flat level, which would turn a new song down to match a quiet ending.
- Voting now closes 10 s before the earliest moment the next song can start mixing in (up to
  ~35 s before the song ends with the default 20 s maximum overlap).
- Gain rule changed: hot masters are no longer played quieter than target.

## Measured (12 samples)

10 of 12 pass all checks (re-rendered 2026-11-17 with the current planner). Two exceed 1 LU (1.3 and 1.6): a long quiet outro meeting a quiet intro.
Beat error on synthetic loops: 7 ms median. On real pairs 7-19 ms, dominated by swung drums.

## Player splices, measured in Chrome (2026-11-17)

(Superseded 2026-11-18: the browser no longer splices clips. The engine joins them by file
position into the live stream; see `docs/streaming.md`. The measurements below describe the old
browser player and are kept for the record. The scripts `transition-check.mjs` and
`transition-verify.mjs` were removed with it.)

| Run                                                          | Splice in      | Splice out | Difference from the clip at the splices         |
| ------------------------------------------------------------ | -------------- | ---------- | ----------------------------------------------- |
| pishezton → RadioT Default (cut), first clip of the session  | 0.00 ms        | 0.00 ms    | −44 dB / −64 dB (at the measurement floor)      |
| same pair as the second clip in a row (deck already delayed) | 0.00 ms        | 0.00 ms    | −44 dB / −64 dB                                 |
| Night Lovell → pishezton (cut)                               | not measurable | 0.00 ms    | A ends on one held tone that repeats every 2 ms |

Only "cut" clips came up in these runs (three short tracks enabled in the lab database); the
splice code is the same for every style, but a long beat-matched clip has not been recorded.

Bugs found and fixed on the way:

- Splice back: with a short overlap the next track's deck was started before the file's first
  sample (clamped to 0) and ran ~2.8 s ahead of the clip, so it was never aligned and the swap
  fell back to a blind 250 ms fade. The deck now starts once its position is ≥ 0.
- Alignment locked onto the wrong bass period on bass-heavy audio (off by multiples of 20 ms).
  `findOffset` now compares without the low end and, between equal matches, takes the one
  nearest the timeline.
- A deck that came out of a clip stays delayed; the next splice-in measured it before the delay
  and would have been ~100 ms off. The tap now sits after the delay.
- Rotation: `orderForFlow` could pass a track over on every pick, so a small library alternated
  between two songs forever. A track is now only passed over by one that waited ≥ ¾ as long.
- Planner: a quiet outro meeting a soft intro could start mixing before the point voting closes
  for (`earliestMixMs`), leaving the player no time to fetch the clip. `earliestMixMs` is now the
  floor of every plan and no longer depends on the outro type (voting closes up to ~32 s before
  the end with the default settings).
- Local dev only: `/api/now-playing` answered the web app's credentialed request with a wildcard
  CORS header, which browsers reject. Admins were also bounced off `/admin` when the session
  resolved before the role did.

## Not done / not verified

- Nobody has listened to any of it. Listen to the samples (or Admin → Transitions, which renders
  any pair) before deploying.
- Safari / iOS and background tabs: untested. Anything that fails there should fall back to the
  plain crossfade, but that is an expectation, not a measurement.
- Two of the 12 samples still exceed 1 LU (see above).
- No integration tests for the station side (no database harness in `apps/api`).
- Deploy needs `pnpm db:migrate` on Neon; old tracks are re-analysed automatically in the background.
