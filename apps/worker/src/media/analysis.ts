import type { TrackAnalysis } from '@radiot/shared';

export const ENVELOPE_WINDOW_MS = 50;
const SUSTAIN_WINDOWS = 200 / ENVELOPE_WINDOW_MS;
const LOUDEST_WINDOWS = 10_000 / ENVELOPE_WINDOW_MS;
const SMOOTH_WINDOWS = 1_000 / ENVELOPE_WINDOW_MS;
const TAIL_SEARCH_MS = 20_000;
const MAX_TRUE_PEAK = -1.5;
// Inter-sample overshoot tolerated on tracks that are turned *down* (already-clipped masters).
const MAX_OVERSHOOT = 1;

const toPower = (db: number) => 10 ** (db / 10);
const toDb = (p: number) => (p <= 0 ? -120 : 10 * Math.log10(p));

/** RMS per 50 ms window, in dBFS, from mono float PCM. */
export function rmsEnvelope(samples: Float32Array, sampleRate: number): number[] {
  const size = Math.round((sampleRate * ENVELOPE_WINDOW_MS) / 1000);
  const env: number[] = [];
  for (let i = 0; i < samples.length; i += size) {
    let sum = 0;
    const end = Math.min(i + size, samples.length);
    for (let j = i; j < end; j++) sum += samples[j]! * samples[j]!;
    env.push(toDb(sum / Math.max(1, end - i)));
  }
  return env;
}

/**
 * Loudness gain toward the target. Boosts stop where the peaks would clip. Cuts are only held
 * back to keep reconstruction overshoot under +1 dBTP: a hot (clipped) master must still land
 * on the target loudness, or it plays quieter than everything else.
 */
export function computeGain(lufs: number, truePeak: number, targetLufs: number): number {
  const wanted = targetLufs - lufs;
  const gain =
    wanted <= 0
      ? Math.min(wanted, MAX_OVERSHOOT - truePeak)
      : Math.max(0, Math.min(wanted, MAX_TRUE_PEAK - truePeak));
  return Math.round(gain * 100) / 100;
}

function movingPower(env: number[], width: number): number[] {
  const out = new Array<number>(env.length).fill(-120);
  let acc = 0;
  for (let i = 0; i < env.length; i++) {
    acc += toPower(env[i]!);
    if (i >= width) acc -= toPower(env[i - width]!);
    out[i] = toDb(acc / Math.min(i + 1, width));
  }
  return out;
}

export function computeCues(env: number[], durationMs: number) {
  const w = ENVELOPE_WINDOW_MS;
  const sustained = (i: number, threshold: number) => {
    for (let k = 0; k < SUSTAIN_WINDOWS; k++) if ((env[i + k] ?? -120) <= threshold) return false;
    return true;
  };

  let cueIn = 0;
  for (let i = 0; i + SUSTAIN_WINDOWS <= env.length; i++) {
    if (sustained(i, -50)) {
      cueIn = i;
      break;
    }
  }

  let cueOutWin = env.length;
  for (let i = env.length - SUSTAIN_WINDOWS; i >= 0; i--) {
    if (sustained(i, -40)) {
      cueOutWin = i + SUSTAIN_WINDOWS;
      break;
    }
  }

  const cueInMs = cueIn * w;
  const cueOutMs = Math.min(durationMs, Math.max(cueInMs + w, cueOutWin * w));

  // Reference: the loudest 10 s stretch of the track.
  const loud = movingPower(env, LOUDEST_WINDOWS);
  let refDb = -120;
  for (let i = cueIn; i < cueOutWin; i++) refDb = Math.max(refDb, loud[i]!);

  // Latest moment in the last 20 s where the (1 s smoothed) level is still within 6 dB of the
  // reference. After it the track has started to fade, which is where the next one should enter.
  const smooth = movingPower(env, SMOOTH_WINDOWS);
  const searchStart = Math.max(cueIn, Math.floor((cueOutMs - TAIL_SEARCH_MS) / w));
  let fadeWin = searchStart;
  for (let i = cueOutWin - 1; i >= searchStart; i--) {
    // smooth[i] trails by one second, so map it back to the window where that second starts.
    if (smooth[i]! >= refDb - 6) {
      fadeWin = Math.max(searchStart, i - SMOOTH_WINDOWS + 1);
      break;
    }
  }

  const rawDuration = cueOutMs - fadeWin * w;
  const crossfadeDurationMs = Math.min(10_000, Math.max(2_000, rawDuration));
  const crossfadeStartMs = Math.max(cueInMs, cueOutMs - crossfadeDurationMs);
  return { cueInMs, cueOutMs, crossfadeStartMs, crossfadeDurationMs };
}

export function buildAnalysis(input: {
  durationMs: number;
  lufs: number;
  truePeak: number;
  envelope: number[];
  targetLufs: number;
}): TrackAnalysis {
  return {
    durationMs: input.durationMs,
    lufs: input.lufs,
    truePeak: input.truePeak,
    gainDb: computeGain(input.lufs, input.truePeak, input.targetLufs),
    ...computeCues(input.envelope, input.durationMs),
  };
}

/** Parses the summary block printed by ffmpeg's ebur128 filter. */
export function parseEbur128(stderr: string): { lufs: number; truePeak: number } {
  const summary = stderr.slice(stderr.lastIndexOf('Summary:'));
  const lufs = Number(/I:\s+(-?[\d.]+|-inf) LUFS/.exec(summary)?.[1]);
  const peakMatch = /True peak:\s+Peak:\s+(-?[\d.]+|-inf) dBFS/.exec(summary);
  const truePeak = Number(peakMatch?.[1]);
  if (!Number.isFinite(lufs)) throw new Error('could not measure loudness (silent or unreadable)');
  return { lufs, truePeak: Number.isFinite(truePeak) ? truePeak : -120 };
}

/**
 * Similarity of two Chromaprint raw fingerprints (0..1), allowing for a time offset.
 * Each int is 32 bits; identical audio scores ~1, unrelated audio ~0.5.
 */
export function fingerprintSimilarity(a: number[], b: number[], maxOffset = 80): number {
  if (!a.length || !b.length) return 0;
  let best = 0;
  for (let off = -maxOffset; off <= maxOffset; off++) {
    let bits = 0;
    let n = 0;
    for (let i = Math.max(0, off); i < a.length && i - off < b.length; i++) {
      bits += popcount((a[i]! ^ b[i - off]!) >>> 0);
      n++;
    }
    if (n < 20) continue;
    best = Math.max(best, 1 - bits / (n * 32));
  }
  return best;
}

export const FINGERPRINT_MATCH_THRESHOLD = 0.8;

function popcount(x: number) {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}
