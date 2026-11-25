import { camelotOf, type BeatGrid, type TrackFeatures } from '@radiot/shared';
import { stft } from './dsp/fft.js';
import { lowpassZeroPhase } from './dsp/filters.js';
import { LoudnessMeter } from './dsp/loudness.js';

export const ANALYSIS_RATE = 22_050;
const ONSET_FFT = 1024;
const ONSET_HOP = 256;
const FPS = ANALYSIS_RATE / ONSET_HOP;
const CURVE_STEP_MS = 500;

export interface AnalysisInput {
  left: Float32Array;
  right: Float32Array;
}

export interface DeepAnalysis {
  features: TrackFeatures;
  cueInMs: number;
  cueOutMs: number;
  durationMs: number;
  /** Integrated loudness measured here (the station gain still uses ffmpeg's figure). */
  lufs: number;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const norm = (x: number, lo: number, hi: number) => clamp((x - lo) / (hi - lo), 0, 1);

function percentile(values: ArrayLike<number>, p: number): number {
  const sorted = Float64Array.from(values).sort();
  if (!sorted.length) return 0;
  return sorted[clamp(Math.round(p * (sorted.length - 1)), 0, sorted.length - 1)]!;
}

/** Linear interpolation into a per-frame envelope at time `sec`. */
function sampleEnv(env: Float32Array, sec: number): number {
  const f = (sec * ANALYSIS_RATE - ONSET_FFT / 2) / ONSET_HOP;
  if (f <= 0 || f >= env.length - 1) return 0;
  const i = Math.floor(f);
  return env[i]! + (env[i + 1]! - env[i]!) * (f - i);
}

/** Peak of the envelope within ±`radiusSec` of `sec`. */
function peakNear(env: Float32Array, sec: number, radiusSec = 0.03): number {
  const centre = (sec * ANALYSIS_RATE - ONSET_FFT / 2) / ONSET_HOP;
  const r = Math.max(1, Math.round(radiusSec * FPS));
  let best = 0;
  for (let i = Math.round(centre) - r; i <= Math.round(centre) + r; i++) {
    if (i >= 0 && i < env.length && env[i]! > best) best = env[i]!;
  }
  return best;
}

/** Log-spectral flux, overall and for the kick/bass band, one value per onset frame. */
function onsetEnvelopes(mid: Float32Array) {
  const bins = ONSET_FFT / 2 + 1;
  const binHz = ANALYSIS_RATE / ONSET_FFT;
  // ~1/3-octave bands from 40 Hz up.
  const edges: number[] = [];
  for (let f = 40; f < ANALYSIS_RATE / 2; f *= 2 ** (1 / 3)) edges.push(f);
  edges.push(ANALYSIS_RATE / 2);
  const bandOf = new Int16Array(bins).fill(-1);
  for (let k = 0; k < bins; k++) {
    const f = k * binHz;
    for (let b = 0; b + 1 < edges.length; b++) {
      if (f >= edges[b]! && f < edges[b + 1]!) bandOf[k] = b;
    }
  }
  const nBands = edges.length - 1;
  const lowBands = edges.filter((e) => e < 160).length - 1;
  const frames = Math.max(0, Math.floor((mid.length - ONSET_FFT) / ONSET_HOP) + 1);
  const all = new Float32Array(frames);
  const low = new Float32Array(frames);
  const history = [new Float64Array(nBands), new Float64Array(nBands)];
  const cur = new Float64Array(nBands);
  stft(mid, ONSET_FFT, ONSET_HOP, (mag, f) => {
    cur.fill(0);
    for (let k = 0; k < bins; k++) if (bandOf[k]! >= 0) cur[bandOf[k]!]! += mag[k]!;
    const ref = history[f % 2]!; // the frame two hops ago
    let fluxAll = 0;
    let fluxLow = 0;
    for (let b = 0; b < nBands; b++) {
      const v = Math.log1p(cur[b]!);
      const d = v - ref[b]!;
      if (f >= 2 && d > 0) {
        fluxAll += d;
        if (b <= lowBands) fluxLow += d;
      }
      ref[b] = v;
    }
    all[f] = fluxAll / nBands;
    low[f] = fluxLow / Math.max(1, lowBands + 1);
  });
  return { all, low };
}

/** Subtracts a ±0.75 s moving average and keeps the positive part: peaks stand out from pads. */
function sharpen(env: Float32Array): Float32Array {
  const w = Math.round(0.75 * FPS);
  const out = new Float32Array(env.length);
  let acc = 0;
  let count = 0;
  for (let i = 0; i < env.length + w; i++) {
    if (i < env.length) {
      acc += env[i]!;
      count++;
    }
    const drop = i - 2 * w - 1;
    if (drop >= 0) {
      acc -= env[drop]!;
      count--;
    }
    const c = i - w;
    if (c >= 0) out[c] = Math.max(0, env[c]! - acc / count);
  }
  return out;
}

/**
 * Beat period in seconds, in the 70–140 BPM octave (half/double time is folded by the planner).
 * Uses the autocorrelation of the onset curve at several metrical levels at once; looking at
 * the beat lag alone is fooled by dotted and triplet hi-hat patterns (2/3 or 4/3 of the tempo).
 */
function estimatePeriod(flux: Float32Array, from: number, to: number): number | null {
  const a = Math.max(0, Math.round(from * FPS));
  const b = Math.min(flux.length, Math.round(to * FPS));
  if (b - a < FPS * 10) return null;
  // Blur the onsets by a few frames first: beat lengths are rarely a whole number of frames,
  // and razor-sharp peaks would favour whichever lag happens to land on one.
  const raw = flux;
  flux = new Float32Array(raw.length);
  for (let i = a; i < b; i++) {
    flux[i] =
      ((raw[i - 2] ?? 0) +
        4 * (raw[i - 1] ?? 0) +
        6 * raw[i]! +
        4 * (raw[i + 1] ?? 0) +
        (raw[i + 2] ?? 0)) /
      16;
  }
  let mean = 0;
  for (let i = a; i < b; i++) mean += flux[i]!;
  mean /= b - a;
  const maxLag = Math.min(Math.round(8.2 * FPS), Math.floor((b - a) / 2));
  const acf = new Float64Array(maxLag + 2);
  for (let lag = 0; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = a; i + lag < b; i++) s += (flux[i]! - mean) * (flux[i + lag]! - mean);
    acf[lag] = s / (b - a - lag);
  }
  if (acf[0]! <= 0) return null;
  const at = (sec: number) => {
    const lag = sec * FPS;
    const i = Math.floor(lag);
    return i + 1 > maxLag ? 0 : (acf[i]! + (acf[i + 1]! - acf[i]!) * (lag - i)) / acf[0]!;
  };
  // A real beat repeats at 1, 2, 4 and 8 beats. Scoring all four levels together is what
  // rejects the dotted / triplet periods that a single-lag search falls for.
  let best = 0;
  let bestScore = -Infinity;
  for (let p = 60 / 140; p < 60 / 70; p += 0.0005) {
    const score = (at(p) + at(2 * p) + at(4 * p) + at(8 * p)) / 4;
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best || null;
}

/** Mean onset strength on the beats of a grid inside [from, to]. */
function comb(env: Float32Array, period: number, phase: number, from: number, to: number) {
  let sum = 0;
  let n = 0;
  const first = Math.ceil((from - phase) / period);
  for (let k = first; phase + k * period <= to; k++) {
    sum += sampleEnv(env, phase + k * period);
    n++;
  }
  return n ? sum / n : 0;
}

/** Best-fitting constant-tempo grid near `period0` (searching ±`spread`) inside [from, to]. */
function fitGrid(
  env: Float32Array,
  period0: number,
  spread: number,
  from: number,
  to: number,
): { period: number; phase: number; strength: number } | null {
  if (to - from < period0 * 16) return null;
  let mean = 0;
  const a = Math.max(0, Math.round(from * FPS));
  const b = Math.min(env.length, Math.round(to * FPS));
  for (let i = a; i < b; i++) mean += env[i]!;
  mean /= Math.max(1, b - a);
  if (mean <= 0) return null;

  let best = { period: period0, phase: from, score: -1 };
  const search = (pLo: number, pHi: number, pStep: number, phaseStep: number, around?: number) => {
    for (let p = pLo; p <= pHi; p += pStep) {
      const phLo = around === undefined ? from : around - 0.03;
      const phHi = around === undefined ? from + p : around + 0.03;
      for (let ph = phLo; ph < phHi; ph += phaseStep) {
        const score = comb(env, p, ph, from, to);
        if (score > best.score) best = { period: p, phase: ph, score };
      }
    }
  };
  // The longer the span, the finer the tempo step must be to keep the last beat in place.
  const span = to - from;
  const coarseStep = (period0 * 0.02) / span;
  search(period0 * (1 - spread), period0 * (1 + spread), coarseStep, 1 / FPS);
  const fineStep = (period0 * 0.002) / span;
  const centre = best.period;
  const phase = best.phase;
  search(centre - 3 * coarseStep, centre + 3 * coarseStep, fineStep, 0.002, phase);
  return { period: best.period, phase: best.phase, strength: best.score / mean };
}

/**
 * Kick-drum onset curve: rise of the energy below 150 Hz, one value per `KICK_HOP` samples.
 * Low-frequency hits are what must line up in a mix, and they can sit a few ms off the
 * broadband onset grid (layered claps, swing), so grids are anchored to these.
 */
const KICK_HOP = 32;
function kickEnvelope(mid: Float32Array): Float32Array {
  const low = lowpassZeroPhase(mid, 150, ANALYSIS_RATE);
  const win = 256;
  const cum = new Float64Array(low.length + 1);
  for (let i = 0; i < low.length; i++) cum[i + 1] = cum[i]! + low[i]! * low[i]!;
  const frames = Math.max(0, Math.floor((low.length - win) / KICK_HOP));
  const level = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    level[f] = Math.log10((cum[f * KICK_HOP + win]! - cum[f * KICK_HOP]!) / win + 1e-9);
  }
  const env = new Float32Array(frames);
  for (let f = 8; f < frames; f++) env[f] = Math.max(0, level[f]! - level[f - 8]!);
  return env;
}

/** Median offset (seconds) of the kicks from the grid beats in [from, to], if they agree. */
function kickOffset(env: Float32Array, period: number, phase: number, from: number, to: number) {
  // The rise peaks when the energy window *starts* at the hit, so frame f marks time f * hop.
  const toFrame = (sec: number) => (sec * ANALYSIS_RATE) / KICK_HOP;
  const radius = Math.round((0.045 * ANALYSIS_RATE) / KICK_HOP);
  const offsets: number[] = [];
  for (let k = Math.ceil((from - phase) / period); phase + k * period <= to; k++) {
    const c = Math.round(toFrame(phase + k * period));
    let best = 0.4; // at least a 4 dB jump in a few ms
    let at = -1;
    for (let i = Math.max(0, c - radius); i <= Math.min(env.length - 1, c + radius); i++) {
      if (env[i]! > best) {
        best = env[i]!;
        at = i;
      }
    }
    if (at >= 0) offsets.push(((at - c) * KICK_HOP) / ANALYSIS_RATE);
  }
  if (offsets.length < 8) return 0;
  offsets.sort((x, y) => x - y);
  const med = offsets[offsets.length >> 1]!;
  const dev = offsets.map((o) => Math.abs(o - med)).sort((x, y) => x - y);
  return dev[dev.length >> 1]! <= 0.012 ? med : 0;
}

/** Pitch-class profile from spectral peaks (80 Hz – 2 kHz), tuned to the track's own tuning. */
function chroma(mid: Float32Array): Float64Array {
  const nfft = 8192;
  const binHz = ANALYSIS_RATE / nfft;
  const fine = new Float64Array(120); // 10 bins per semitone
  const lo = Math.ceil(80 / binHz);
  const hi = Math.floor(2000 / binHz);
  stft(mid, nfft, nfft / 2, (mag) => {
    let frameMax = 0;
    for (let k = lo; k <= hi; k++) if (mag[k]! > frameMax) frameMax = mag[k]!;
    if (frameMax <= 1e-6) return;
    for (let k = lo; k <= hi; k++) {
      const m = mag[k]!;
      if (m < 0.05 * frameMax || m < mag[k - 1]! || m < mag[k + 1]!) continue;
      // Parabolic interpolation of the peak position.
      const a = Math.log(mag[k - 1]! + 1e-12);
      const c = Math.log(mag[k + 1]! + 1e-12);
      const off = (0.5 * (a - c)) / (a - 2 * Math.log(m) + c || 1);
      const f = (k + clamp(off, -0.5, 0.5)) * binHz;
      const pitch = 69 + 12 * Math.log2(f / 440);
      const idx = ((Math.round(pitch * 10) % 120) + 120) % 120;
      fine[idx]! += Math.sqrt(m);
    }
  });
  // Tuning: the tenth-of-a-semitone offset that concentrates the most energy on the grid.
  let bestOff = 0;
  let bestSum = -1;
  for (let off = -5; off < 5; off++) {
    let s = 0;
    for (let pc = 0; pc < 12; pc++) {
      for (let d = -1; d <= 1; d++) s += fine[(pc * 10 + off + d + 120) % 120]!;
    }
    if (s > bestSum) {
      bestSum = s;
      bestOff = off;
    }
  }
  const out = new Float64Array(12);
  for (let pc = 0; pc < 12; pc++) {
    for (let d = -4; d <= 5; d++) out[pc]! += fine[(pc * 10 + bestOff + d + 120) % 120]!;
  }
  return out;
}

// Key profiles from Sha'ath (KeyFinder), which suit beat-driven music better than classical ones.
const MAJOR = [6.6, 2.0, 3.5, 2.3, 4.6, 4.0, 2.5, 5.2, 2.4, 3.7, 2.3, 3.4];
const MINOR = [6.5, 2.7, 3.5, 5.4, 2.6, 3.5, 2.5, 5.2, 4.0, 2.7, 4.3, 3.2];

function correlate(a: ArrayLike<number>, b: ArrayLike<number>, shift: number) {
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < 12; i++) {
    ma += a[i]!;
    mb += b[i]!;
  }
  ma /= 12;
  mb /= 12;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < 12; i++) {
    const x = a[(i + shift) % 12]! - ma;
    const y = b[i]! - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  return num / Math.sqrt(da * db || 1);
}

function detectKey(mid: Float32Array): TrackFeatures['key'] {
  const pc = chroma(mid);
  if (pc.every((v) => v === 0)) return null;
  const scores: { tonic: number; mode: 'major' | 'minor'; score: number }[] = [];
  for (let tonic = 0; tonic < 12; tonic++) {
    scores.push({ tonic, mode: 'major', score: correlate(pc, MAJOR, tonic) });
    scores.push({ tonic, mode: 'minor', score: correlate(pc, MINOR, tonic) });
  }
  scores.sort((x, y) => y.score - x.score);
  const best = scores[0]!;
  return {
    tonic: best.tonic,
    mode: best.mode,
    camelot: camelotOf(best.tonic, best.mode),
    confidence:
      Math.round(clamp((best.score - scores[1]!.score) * 5 + best.score * 0.5, 0, 1) * 100) / 100,
  };
}

/**
 * Foreground (vocal / lead) activity via REPET: the backing of beat-driven music repeats every
 * couple of bars, so whatever does *not* repeat in the 200 Hz – 4 kHz band is mostly the voice.
 * Returns the non-repeating share of that band, 0..1 per `CURVE_STEP_MS`.
 */
function foregroundActivity(mid: Float32Array, periodSec: number, steps: number): number[] {
  const nfft = 2048;
  const hop = 512;
  const fps = ANALYSIS_RATE / hop;
  const binHz = ANALYSIS_RATE / nfft;
  const lo = Math.round(200 / binHz);
  const hi = Math.round(4000 / binHz);
  const width = hi - lo + 1;
  const frames = Math.max(0, Math.floor((mid.length - nfft) / hop) + 1);
  const spec = new Float32Array(frames * width);
  stft(mid, nfft, hop, (mag, f) => {
    for (let k = 0; k < width; k++) spec[f * width + k] = mag[lo + k]!;
  });
  const period = periodSec * fps;
  const fore = new Float64Array(frames);
  const total = new Float64Array(frames);
  const pool = new Float32Array(7);
  for (let f = 0; f < frames; f++) {
    let fe = 0;
    let te = 0;
    for (let k = 0; k < width; k++) {
      let n = 0;
      for (let j = -3; j <= 3; j++) {
        const g = Math.round(f + j * period);
        if (g >= 0 && g < frames) pool[n++] = spec[g * width + k]!;
      }
      // Median of the same bin across neighbouring repetitions = the repeating backing.
      const view = pool.subarray(0, n).sort();
      const model = n ? view[n >> 1]! : 0;
      const s = spec[f * width + k]!;
      const rest = Math.max(0, s - model);
      fe += rest * rest;
      te += s * s;
    }
    fore[f] = fe;
    total[f] = te;
  }
  const floor = percentile(total, 0.5) * 0.01; // ignore near-silent frames
  const out: number[] = [];
  for (let i = 0; i < steps; i++) {
    const centre = ((i * CURVE_STEP_MS) / 1000) * fps - nfft / 2 / hop;
    const a = Math.max(0, Math.round(centre - 0.75 * fps));
    const b = Math.min(frames, Math.round(centre + 0.75 * fps));
    let fe = 0;
    let te = 0;
    for (let f = a; f < b; f++) {
      fe += fore[f]!;
      te += total[f]!;
    }
    out.push(te > floor * Math.max(1, b - a) ? fe / te : 0);
  }
  return out;
}

/** Slope (dB/s) and r² of a straight-line fit to `values` sampled every `stepSec`. */
function linearFit(values: number[], stepSec: number) {
  const n = values.length;
  if (n < 3) return { slope: 0, r2: 0 };
  const mx = ((n - 1) * stepSec) / 2;
  const my = values.reduce((s, v) => s + v, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = i * stepSec - mx;
    const dy = values[i]! - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  return { slope: sxy / (sxx || 1), r2: syy ? (sxy * sxy) / (sxx * syy) : 0 };
}

export function analyzeTrack({ left, right }: AnalysisInput): DeepAnalysis {
  const n = Math.min(left.length, right.length);
  const durationSec = n / ANALYSIS_RATE;
  const durationMs = Math.round(durationSec * 1000);
  const mid = new Float32Array(n);
  for (let i = 0; i < n; i++) mid[i] = (left[i]! + right[i]!) / 2;

  // ---- loudness, cue points, intro and outro ------------------------------------------------
  const meter = new LoudnessMeter([left, right], ANALYSIS_RATE);
  const lufs = meter.integrated();
  const FAST = 0.05;
  const fast: number[] = [];
  for (let t = 0; t <= durationSec; t += FAST) fast.push(meter.lufs(t - 0.05, t + 0.05));
  const runAbove = (i: number, len: number, threshold: number) => {
    for (let k = 0; k < len; k++) if ((fast[i + k] ?? -120) <= threshold) return false;
    return true;
  };
  let cueInIdx = 0;
  for (let i = 0; i + 4 <= fast.length; i++) {
    if (runAbove(i, 4, Math.max(lufs - 40, -62))) {
      cueInIdx = i;
      break;
    }
  }
  let cueOutIdx = fast.length - 1;
  for (let i = fast.length - 4; i >= 0; i--) {
    if (runAbove(i, 4, Math.max(lufs - 30, -54))) {
      cueOutIdx = i + 3;
      break;
    }
  }
  const cueInSec = Math.max(0, cueInIdx * FAST - 0.03);
  const cueOutSec = Math.min(durationSec, Math.max(cueInSec + 1, (cueOutIdx + 1) * FAST + 0.1));

  const SLOW = 0.1;
  const slowAt = (t: number) => meter.lufs(t - 0.5, t + 0.5) - lufs;
  const slow: number[] = [];
  for (let t = 0; t <= durationSec; t += SLOW) slow.push(slowAt(t));
  const slowMin = (from: number, to: number) => {
    let m = Infinity;
    for (let i = Math.round(from / SLOW); i <= Math.round(to / SLOW); i++) {
      m = Math.min(m, slow[i] ?? -120);
    }
    return m;
  };

  // Intro: where the track first reaches (and holds) its full level.
  let introEnd = cueInSec;
  for (let t = cueInSec; t < cueOutSec; t += SLOW) {
    if (slowAt(t) >= -4 && slowMin(t, Math.min(cueOutSec, t + 3)) >= -8) {
      introEnd = t;
      break;
    }
  }
  const fastRel = (from: number, to: number) =>
    fast.slice(Math.round(from / FAST), Math.round(to / FAST) + 1).map((v) => v - lufs);
  const rise = introEnd - cueInSec;
  let introType: TrackFeatures['intro']['type'] = 'cold';
  if (rise > 0.6) {
    const seg = fastRel(cueInSec, introEnd);
    const fit = linearFit(seg, FAST);
    introType =
      rise >= 2 && fit.slope > 0 && fit.r2 >= 0.7 && (seg[0] ?? 0) <= -15 ? 'fade-in' : 'soft';
  }

  // Outro: where the full-level body ends, and how the track leaves.
  let bodyEnd = cueOutSec;
  for (let t = cueOutSec; t > cueInSec; t -= SLOW) {
    if (slowAt(t) >= -4) {
      bodyEnd = t;
      break;
    }
  }
  let dropSec = cueOutSec;
  for (let i = Math.round(cueOutSec / FAST); i >= 0; i--) {
    if ((fast[i] ?? -120) - lufs >= -10) {
      dropSec = Math.min(cueOutSec, (i + 1) * FAST);
      break;
    }
  }
  const tail = cueOutSec - bodyEnd;
  let outroType: TrackFeatures['outro']['type'] = 'hard';
  let fadeStart = bodyEnd;
  if (tail > 1.5) {
    const fit = linearFit(fastRel(bodyEnd, cueOutSec), FAST);
    if (tail >= 3 && fit.slope < 0 && fit.r2 >= 0.75) {
      outroType = 'fade';
      // The body threshold trips ~4 dB into the fade; walk the fitted line back to its start.
      fadeStart = Math.max(cueInSec, bodyEnd - Math.min(15, 4 / -fit.slope));
    } else {
      outroType = tail < 3.5 ? 'tail' : 'soft';
    }
  }

  const steps = Math.floor(durationMs / CURVE_STEP_MS) + 1;
  const loudness: number[] = [];
  for (let i = 0; i < steps; i++) {
    const t = (i * CURVE_STEP_MS) / 1000;
    loudness.push(Math.round(clamp(meter.lufs(t - 1.5, t + 1.5) - lufs, -60, 20) * 10));
  }
  const levelOf = (from: number, to: number) =>
    to - from < 0.2 ? 0 : Math.round((meter.lufs(from, to) - lufs) * 10) / 10;

  // ---- tempo and beat grid ------------------------------------------------------------------
  const onsets = onsetEnvelopes(mid);
  const sharp = sharpen(onsets.all);
  const sharpLow = sharpen(onsets.low);
  const period0 = estimatePeriod(onsets.all, cueInSec, cueOutSec);
  let grid: BeatGrid | null = null;
  let headGrid: BeatGrid | null = null;
  let tailGrid: BeatGrid | null = null;
  let bpm: number | null = null;
  let downbeatConfidence = 0;
  let phraseOffsetBars = 0;
  let beatStartMs: number | null = null;
  let beatEndMs: number | null = null;
  let barSec = 0;

  if (period0) {
    const whole = fitGrid(sharp, period0, 0.015, cueInSec, cueOutSec);
    const HEAD = 60;
    const head =
      whole && fitGrid(sharp, whole.period, 0.01, cueInSec, Math.min(cueOutSec, cueInSec + HEAD));
    const tailFit =
      whole && fitGrid(sharp, whole.period, 0.01, Math.max(cueInSec, cueOutSec - HEAD), cueOutSec);
    if (whole) bpm = Math.round((60 / whole.period) * 100) / 100;
    if (whole) {
      const kicks = kickEnvelope(mid);
      whole.phase += kickOffset(kicks, whole.period, whole.phase, cueInSec, cueOutSec);
      if (head) {
        head.phase += kickOffset(
          kicks,
          head.period,
          head.phase,
          cueInSec,
          Math.min(cueOutSec, cueInSec + HEAD + 30),
        );
      }
      if (tailFit) {
        tailFit.phase += kickOffset(
          kicks,
          tailFit.period,
          tailFit.phase,
          Math.max(cueInSec, cueOutSec - HEAD - 30),
          cueOutSec,
        );
      }
    }

    // One tempo for the whole track? Then the head and tail grids agree with the global one.
    const steady =
      whole &&
      whole.strength >= 1.6 &&
      (!head || !tailFit || Math.abs(head.period - tailFit.period) / whole.period < 0.004);

    if (whole && steady) {
      const p = whole.period;
      const beatAt = (k: number) => whole.phase + k * p;
      const kFirst = Math.ceil((cueInSec - whole.phase) / p);
      const kLast = Math.floor((cueOutSec - whole.phase) / p);
      const count = kLast - kFirst + 1;

      // Downbeat: the beat of the bar with the strongest kick and the biggest section changes.
      const kick = new Float64Array(4);
      const change = new Float64Array(4);
      for (let phase = 0; phase < 4; phase++) {
        let prev: number | null = null;
        for (let k = kFirst + ((((phase - kFirst) % 4) + 4) % 4); k + 4 <= kLast; k += 4) {
          kick[phase]! += peakNear(sharpLow, beatAt(k));
          const e = meter.lufs(beatAt(k), beatAt(k + 4));
          if (prev !== null) change[phase]! += Math.abs(e - prev) ** 2;
          prev = e;
        }
      }
      const z = (xs: Float64Array) => {
        const m = xs.reduce((s, v) => s + v, 0) / xs.length;
        const sd = Math.sqrt(xs.reduce((s, v) => s + (v - m) ** 2, 0) / xs.length) || 1;
        return Array.from(xs, (v) => (v - m) / sd);
      };
      const zk = z(kick);
      const zc = z(change);
      const score = zk.map((v, i) => v + zc[i]!);
      const order = score.map((v, i) => [v, i] as const).sort((x, y) => y[0] - x[0]);
      const downPhase = order[0]![1];
      downbeatConfidence = Math.round(clamp((order[0]![0] - order[1]![0]) / 2, 0, 1) * 100) / 100;

      // Anchor = first downbeat at or after the cue-in.
      let k0 = kFirst;
      while ((((k0 - downPhase) % 4) + 4) % 4 !== 0) k0++;
      barSec = 4 * p;
      const bars = Math.floor((kLast - k0) / 4);

      // Drums present per bar: onset energy of the bar against the track's typical bar.
      const barFlux: number[] = [];
      for (let b = 0; b < bars; b++) {
        const a = Math.round((beatAt(k0 + 4 * b) * ANALYSIS_RATE - ONSET_FFT / 2) / ONSET_HOP);
        const e = Math.round((beatAt(k0 + 4 * b + 4) * ANALYSIS_RATE - ONSET_FFT / 2) / ONSET_HOP);
        let s = 0;
        for (let i = Math.max(0, a); i < Math.min(sharp.length, e); i++) s += sharp[i]!;
        barFlux.push(s / Math.max(1, e - a));
      }
      const typical = percentile(barFlux, 0.6);
      const present = barFlux.map((v) => v >= 0.45 * typical);
      const firstBar = present.findIndex((v, i) => v && (present[i + 1] ?? true));
      let lastBar = -1;
      for (let i = present.length - 1; i >= 0; i--) {
        if (present[i] && (present[i - 1] ?? true)) {
          lastBar = i;
          break;
        }
      }
      if (firstBar >= 0 && lastBar >= firstBar) {
        beatStartMs = Math.max(0, Math.round(beatAt(k0 + 4 * firstBar) * 1000));
        beatEndMs = Math.min(durationMs, Math.round(beatAt(k0 + 4 * (lastBar + 1)) * 1000));
      }

      // Phrases: 8-bar boundaries line up with the biggest bar-to-bar level changes.
      const barLevel = Array.from({ length: bars }, (_, b) =>
        meter.lufs(beatAt(k0 + 4 * b), beatAt(k0 + 4 * b + 4)),
      );
      let bestPhrase = -1;
      for (let off = 0; off < 8; off++) {
        let s = 0;
        for (let b = off; b < bars; b += 8) {
          if (b > 0) s += Math.abs(barLevel[b]! - barLevel[b - 1]!) ** 2;
        }
        if (s > bestPhrase) {
          bestPhrase = s;
          phraseOffsetBars = off;
        }
      }

      const toGrid = (fit: { period: number; phase: number; strength: number }, near: number) => {
        // Snap the local fit to the global bar numbering: pick its beat closest to a downbeat.
        const globalDown = beatAt(k0 + 4 * Math.round((near - beatAt(k0)) / (4 * p)));
        const k = Math.round((globalDown - fit.phase) / fit.period);
        return {
          periodMs: Math.round(fit.period * 1e6) / 1000,
          anchorMs: Math.round((fit.phase + k * fit.period) * 1e4) / 10,
          strength: Math.round(fit.strength * 100) / 100,
        };
      };
      grid = toGrid(whole, beatAt(k0));
      headGrid = head ? toGrid(head, cueInSec + Math.min(HEAD, count * p) / 2) : null;
      tailGrid = tailFit ? toGrid(tailFit, cueOutSec - Math.min(HEAD, count * p) / 2) : null;
    }
  }

  // ---- key, foreground activity, energy -----------------------------------------------------
  const key = detectKey(mid);
  let vocal: number[] | null = null;
  let vocalInMs: number | null = null;
  let vocalOutMs: number | null = null;
  if (grid && barSec > 0) {
    const raw = foregroundActivity(mid, 2 * barSec, steps);
    vocal = raw.map((v) => Math.round(clamp(v, 0, 1) * 100));
    const active = vocal.map((v, i) => v >= VOCAL_THRESHOLD && loudness[i]! > -150);
    const first = active.findIndex((v, i) => v && active[i + 1] && active[i + 2]);
    let last = -1;
    for (let i = active.length - 1; i >= 2; i--) {
      if (active[i] && active[i - 1] && active[i - 2]) {
        last = i;
        break;
      }
    }
    if (first >= 0) vocalInMs = first * CURVE_STEP_MS;
    if (last >= 0) vocalOutMs = Math.min(durationMs, last * CURVE_STEP_MS);
  }

  let fluxMean = 0;
  for (let i = 0; i < onsets.all.length; i++) fluxMean += onsets.all[i]!;
  fluxMean /= Math.max(1, onsets.all.length);
  const foldedBpm = bpm ? (bpm < 85 ? bpm * 2 : bpm) : 110;
  const energy =
    Math.round(
      (0.4 * norm(lufs, -16, -7) +
        0.4 * norm(fluxMean, 0.02, 0.07) +
        0.2 * norm(foldedBpm, 90, 170)) *
        100,
    ) / 100;

  const toMs = (sec: number) => Math.round(sec * 1000);
  return {
    cueInMs: toMs(cueInSec),
    cueOutMs: toMs(cueOutSec),
    durationMs,
    lufs: Math.round(lufs * 100) / 100,
    features: {
      v: 1,
      bpm,
      grid,
      headGrid,
      tailGrid,
      downbeatConfidence,
      phraseOffsetBars,
      beatStartMs,
      beatEndMs,
      key,
      energy,
      intro: { type: introType, endMs: toMs(introEnd), levelLu: levelOf(cueInSec, introEnd) },
      outro: {
        type: outroType,
        startMs: toMs(bodyEnd),
        fadeStartMs: toMs(fadeStart),
        dropMs: toMs(dropSec),
        levelLu: levelOf(bodyEnd, cueOutSec),
      },
      curveStepMs: CURVE_STEP_MS,
      loudness,
      vocal,
      vocalInMs,
      vocalOutMs,
    },
  };
}

/** Foreground share (0..100) above which a moment counts as "someone is singing or rapping". */
export const VOCAL_THRESHOLD = 35;
