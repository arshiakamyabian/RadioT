# Music AI models used for transitions

RadioT plans each song change from what three pretrained models find in the songs. They run
once per song, when it is imported or uploaded (`apps/worker/ml/analyze.py`), and the results
are stored in the database (`ai` column) with the stems in storage. Mixing at the moment of the
transition only uses those stored results, so it stays fast.

## The models, in plain words

### Demucs (htdemucs_ft): splits a song into stems

Demucs listens to a finished song and pulls it apart into four tracks ("stems"): **drums**,
**bass**, **vocals**, and **other** (everything else: guitars, synths, keys...). It's from Meta
AI. `htdemucs_ft` is the fine-tuned Hybrid Transformer version: four models, one per stem, which
is the most accurate setting Demucs offers. Stems are saved as 16-bit FLAC (lossless).

RadioT uses the stems to mix like a DJ with separate faders per instrument: the old song's voice
leaves first, the new song's beat and music come in before its voice, and the basslines swap in
one beat so they never rumble on top of each other.

### Beat This!: finds the beats and the "one"

Beat This! (CPJKU, Johannes Kepler University Linz, 2024) marks every beat in a song and which
beats are **downbeats** (the "1" of each bar). It is a transformer trained on many genres and
does not assume a fixed tempo. RadioT uses checkpoint `final0` without the DBN post-processing.
If it ever fails, madmom's RNN + DBN beat tracker (the older standard) is used instead.

RadioT uses the beats to line up the two songs' drums (beat-matching) and starts every mix on a
downbeat.

### All-In-One: finds the song's sections

All-In-One (Taejun Kim and Juhan Nam, 2023) labels the song's structure: **intro**, **verse**,
**chorus**, **bridge**, **break**, **instrumental**, **solo**, **outro**. It is trained on the
Harmonix set and reads Demucs stems, so it reuses the stems above. RadioT uses the 8-model
ensemble `harmonix-all`.

RadioT uses the sections to choose _where_ a mix starts: at the start of the outro if there is
one, otherwise at a phrase end (a section boundary or every 8 bars), preferring a moment after
the singer has finished.

All-In-One depends on NATTEN, a compiled library that does not build against current PyTorch on
macOS. RadioT replaces the four NATTEN functions it uses with plain PyTorch
(`apps/worker/ml/shims/natten`). The replacement is checked against a direct implementation by
`apps/worker/ml/test_natten_shim.py` (identical to within 5e-7), so the model gives the same
results as with NATTEN, just a little slower.

## What it costs

On an 8 GB M1 MacBook Air (CPU), per minute of music: Demucs about 3 minutes, Beat This! about
2 seconds, All-In-One about 30 seconds. Peak memory about 1.7 GB. One song is processed at a
time. Stems take about 15-20 MB per minute of music.

The environment (`apps/worker/ml/.venv`) takes about 1.1 GB, and the model weights about 0.5 GB
(downloaded on first use into `~/.cache/torch` and `~/.cache/huggingface`).

Vercel functions have no Python ML runtime for this, so the deployed worker keeps using the DSP
analysis only (`features`); the AI planner is used for any pair where both songs have the `ai`
analysis.

## Set up

```bash
# once (needs uv: https://docs.astral.sh/uv/)
pnpm --filter @radiot/worker ml:setup
# then in apps/worker/.env
ML_PYTHON=/full/path/to/radiot/apps/worker/ml/.venv/bin/python
```

With `ML_PYTHON` set, the worker runs the models after every import/upload, and
`pnpm --filter @radiot/worker ml:backfill` analyses tracks that are already in the database.

## Run each model yourself on a song

All commands from `apps/worker/ml`, with any audio file as `song.mp3`.

**Everything RadioT does** (stems + beats + sections, as JSON):

```bash
.venv/bin/python analyze.py song.mp3 --out song.json --stems-dir song-stems/
```

**Demucs** (stems into `separated/htdemucs_ft/song/*.wav`):

```bash
.venv/bin/python -m demucs.separate -n htdemucs_ft song.mp3
# two stems only (vocals / everything else), faster:
.venv/bin/python -m demucs.separate -n htdemucs_ft --two-stems vocals song.mp3
```

**Beat This!** (writes `song.beats`: one line per beat, time and position in the bar):

```bash
.venv/bin/beat_this song.mp3 -o song.beats
```

**All-In-One** (sections, beats and tempo into `struct/song.json`; the shim stands in for NATTEN):

```bash
PYTHONPATH=shims TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD=1 \
  .venv/bin/python -c "import allin1; print(allin1.analyze('song.mp3', out_dir='struct', multiprocess=False))"
```

**madmom** (the fallback beat tracker; prints beat times and their position in the bar):

```bash
.venv/bin/DBNDownBeatTracker single song.mp3
```

## Lab

`apps/worker/scripts/lab.ts` runs the planner and renderer on local files:

```bash
cd apps/worker
ml/.venv/bin/python ml/analyze.py --batch ../../.tmp/lab/cooked --out-dir ../../.tmp/lab/ai
npx tsx scripts/lab.ts ai-plans --all     # what the AI planner decides for every pair
npx tsx scripts/lab.ts ai-samples         # renders docs/transitions/ai-samples (before/after)
```
