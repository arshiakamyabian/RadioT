# AI transition samples (before / after)

Ten song pairs from the lab library, each rendered twice:

- `NN-before.mp3`: the DSP planner (tempo, key, intro/outro, band curves), no stems.
- `NN-after.mp3`: the AI planner: exits at the song's real structure points on a downbeat, per-stem
  mixing (the old song's voice leaves first, the new song's instrumental comes in before its
  voice, unsynchronised drums change hands at one instant, basslines swap), beat matching when
  tempo and key allow.

Each clip is a few seconds of the old song, the overlap, then the new song. The MP3s are excerpts
of copyrighted songs, so they are not committed (see `.gitignore`); `metrics.json` is.

**Regenerate** (needs the lab files and the model analysis, see `docs/ml-models.md`):

```bash
cd apps/worker
ml/.venv/bin/python ml/analyze.py --batch ../../.tmp/lab/cooked --out-dir ../../.tmp/lab/ai
LAB_DIR=../../.tmp/lab npx tsx scripts/lab.ts ai-samples
```

## Checks (`metrics.json`)

| Check         | Pass when                                                                         |
| ------------- | --------------------------------------------------------------------------------- |
| `noClipping`  | the encoded file's true peak is below 0 dBTP                                      |
| `loudness`    | short-term loudness never strays more than 1 LU outside the two songs' own levels |
| `noGap`       | the quietest 200 ms of the transition is above -45 dBFS (no silence)              |
| `beats`       | beat-matched pairs: median kick distance between the songs is 20 ms or less       |
| `vocalsApart` | both vocals audible together for at most 0.5 s (measured on the vocal stems)      |

## Results (2026-11-18)

| Pair | Style (after) | Overlap | Loudness excursion before → after | Vocals together before → after |
| ---- | ------------- | ------- | --------------------------------- | ------------------------------ |
| 01   | beat-matched  | 11.2 s  | 0.33 → 0.45 LU                    | 0 → 0 s                        |
| 02   | smooth        | 12 s    | 0.31 → 0.31 LU                    | **2.4 → 0 s**                  |
| 03   | smooth        | 12 s    | 0.30 → 0.19 LU                    | 0 → 0 s                        |
| 04   | smooth        | 12 s    | 0.51 → 0.37 LU                    | 0 → 0 s                        |
| 05   | smooth        | 12 s    | 0.64 → 0.56 LU                    | 0 → 0 s                        |
| 06   | smooth        | 10.9 s  | 0.77 → 0.75 LU                    | 0 → 0 s                        |
| 07   | smooth        | 11.4 s  | 0.69 → 0.42 LU                    | 0.1 → 0 s                      |
| 08   | smooth        | 12 s    | **1.63 → 0.65 LU**                | 0 → 0 s                        |
| 09   | smooth        | 8.8 s   | 0.49 → 0.60 LU                    | 0 → 0 s                        |
| 10   | smooth        | 12 s    | **1.32 → 0.41 LU**                | 0 → 0 s                        |

All checks pass for all ten AI renders. The DSP renders failed three: the loudness check on
pairs 08 and 10 and the vocals check on pair 02. The beat check applies to one pair (01: median
beat distance 11.6 ms; the DSP version of that pair: 16 ms).

**Read this with care.**

- Nobody has listened to these. The checks measure peaks, loudness, silence and vocal overlap,
  not whether a blend sounds good.
- Only pair 01 is beat-matched. The other songs differ too much in tempo (70 to 140 BPM) or key,
  so they blend without beat matching, which is by design (a short 4 to 6 bar blend).
- The loudness checks only pass with a faster, deeper loudness leveller than the DSP renders
  use (`STEM_RENDER_OPTIONS`: up to 6 dB per second and 14 dB of lift instead of 2 and 9). Stem
  edits remove whole instruments, which opens quick loudness holes that the slower leveller
  could not fill (two pairs measured 4.4 and 3.5 LU before this).
- Ten pairs from twelve songs of one genre is a small sample.
