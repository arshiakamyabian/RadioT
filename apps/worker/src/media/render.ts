import {
  evalCurve,
  type BandCurves,
  type Curve,
  type StemCurves,
  type TransitionPlan,
} from '@radiot/shared';
import { lowpassZeroPhase } from './dsp/filters.js';
import { LoudnessMeter } from './dsp/loudness.js';
import { limitTruePeak, truePeakDb } from './dsp/peaks.js';
import { warp } from './dsp/wsola.js';
import type { Pcm } from './pcm.js';

export const RENDER_RATE = 44_100;
const LEAD_IN_SEC = 4;
const MIN_LEAD_OUT_SEC = 8;
const MAX_LEAD_OUT_SEC = 14;
const LOW_HZ = 160;
const HIGH_HZ = 2500;
const MAX_CUT_DB = 6;
// Valleys (A's quiet outro meeting B's quiet intro) may be lifted further than bumps are cut.
const DEFAULT_MAX_LIFT_DB = 9;
const DEFAULT_SLEW_DB_PER_SEC = 2;

export interface RenderTrack {
  cueInMs: number;
  cueOutMs: number;
  /** Station loudness gain for this track, dB. */
  gainDb: number;
}

export interface RenderOptions {
  /** Hold the loudness steady through the transition (off = raw mix, as a plain crossfade). */
  leveler: boolean;
  /** True-peak ceiling in dBTP, or null to leave peaks alone. */
  ceilingDb: number | null;
  /** Fastest the leveller may change the gain, dB per second. Stem mixes change faster. */
  slewDbPerSec: number;
  /** Most the leveller may raise a valley, dB. */
  maxLiftDb: number;
}

/** Stem edits change the level faster and deeper than band curves do, so the leveller may follow faster. */
export const STEM_RENDER_OPTIONS: Partial<RenderOptions> = { slewDbPerSec: 6, maxLiftDb: 14 };

export const DEFAULT_RENDER_OPTIONS: RenderOptions = {
  leveler: true,
  ceilingDb: -1,
  slewDbPerSec: DEFAULT_SLEW_DB_PER_SEC,
  maxLiftDb: DEFAULT_MAX_LIFT_DB,
};

export interface TransitionMetrics {
  /** Highest inter-sample peak of the clip, dBTP. */
  truePeakDb: number;
  /** Short-term loudness (3 s) of A just before the overlap and of B just after it, LUFS. */
  beforeLufs: number;
  afterLufs: number;
  /**
   * How far the short-term loudness strays outside the range between those two levels at any
   * point of the transition, LU. 0 = no dip below both songs and no bump above both.
   */
  loudnessExcursionLu: number;
  /** Quietest 200 ms inside the transition, dBFS RMS (silence gaps show up here). */
  quietestDb: number;
  /** Beat-matched plans: median / worst-case distance between A's and B's beats, ms. */
  beatErrorMs: { median: number; p90: number; beats: number } | null;
  limiterReductionDb: number;
  levelerRangeDb: [number, number];
}

export interface RenderedTransition {
  channels: [Float32Array, Float32Array];
  sampleRate: number;
  /** A-file position of the clip's first sample. */
  aFileStartMs: number;
  leadInMs: number;
  overlapMs: number;
  /** Where B is alone and back at normal speed: clip position and the B-file position there. */
  handoff: { clipMs: number; bFileMs: number };
  clipMs: number;
  metrics: TransitionMetrics;
}

/** `decode(fromSec, durationSec)` must return stereo PCM at RENDER_RATE from that file position. */
export type Decode = (fromSec: number, durationSec: number) => Promise<Pcm>;

/** Stems that get their own gain in AI plans; everything else follows the `base` curve. */
export const MIXED_STEMS = ['drums', 'bass', 'vocals'] as const;
export type MixedStem = (typeof MIXED_STEMS)[number];
/** Like `Decode`, for each stem of a track (sample-aligned with the cooked file). */
export type DecodeStems = (fromSec: number, durationSec: number) => Promise<Record<MixedStem, Pcm>>;

const dbToLin = (db: number) => 10 ** (db / 20);
const smoothstep = (x: number) => x * x * (3 - 2 * x);

/** Kick-drum onset curve of a stereo stem: rise of the energy below 150 Hz, 1.45 ms steps. */
function transientEnvelope(ch: Float32Array[], from: number, to: number) {
  const win = 512;
  const hop = 64;
  const a = Math.max(0, Math.floor(from));
  const b = Math.min(ch[0]!.length, Math.ceil(to));
  const mono = new Float32Array(Math.max(0, b - a));
  for (const c of ch) for (let i = 0; i < mono.length; i++) mono[i] = mono[i]! + c[a + i]!;
  const low = lowpassZeroPhase(mono, 150, RENDER_RATE);
  const cum = new Float64Array(low.length + 1);
  for (let i = 0; i < low.length; i++) cum[i + 1] = cum[i]! + low[i]! * low[i]!;
  const frames = Math.max(0, Math.floor((low.length - win) / hop));
  const level = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    level[f] = Math.log10((cum[f * hop + win]! - cum[f * hop]!) / win + 1e-9);
  }
  const env = new Float32Array(frames);
  for (let f = 8; f < frames; f++) env[f] = Math.max(0, level[f]! - level[f - 8]!);
  return { env, start: a, hop };
}

/** Position (samples) of the kick within ±45 ms of `centre`, if there is a clear one. */
function hitNear(t: ReturnType<typeof transientEnvelope>, centre: number, sr: number) {
  const r = Math.round((0.045 * sr) / t.hop);
  const c = Math.round((centre - t.start) / t.hop);
  let best = 0.4; // at least a 4 dB jump in a few ms
  let at = -1;
  for (let f = Math.max(0, c - r); f <= Math.min(t.env.length - 1, c + r); f++) {
    if (t.env[f]! > best) {
      best = t.env[f]!;
      at = f;
    }
  }
  return at < 0 ? null : { pos: t.start + at * t.hop };
}

function median(xs: number[]) {
  const s = [...xs].sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)]! : 0;
}

function splitBands(x: Float32Array, sr: number) {
  const low = lowpassZeroPhase(x, LOW_HZ, sr);
  const lowMid = lowpassZeroPhase(x, HIGH_HZ, sr);
  return { low, lowMid };
}

/** Applies per-band gain automation to a stem and adds it to `out`. */
function mixStem(
  out: Float32Array,
  stem: Float32Array,
  sr: number,
  gainAt: (band: keyof BandCurves, n: number) => number,
) {
  const { low, lowMid } = splitBands(stem, sr);
  const BLOCK = 64;
  const n = out.length;
  for (let start = 0; start < n; start += BLOCK) {
    const end = Math.min(n, start + BLOCK);
    const g0 = [gainAt('low', start), gainAt('mid', start), gainAt('high', start)];
    const g1 = [gainAt('low', end), gainAt('mid', end), gainAt('high', end)];
    if (g0[0] === 0 && g0[1] === 0 && g0[2] === 0 && g1[0] === 0 && g1[1] === 0 && g1[2] === 0)
      continue;
    for (let i = start; i < end; i++) {
      const x = (i - start) / (end - start);
      const lo = low[i]!;
      const lm = lowMid[i]!;
      out[i] =
        out[i]! +
        lo * (g0[0]! + (g1[0]! - g0[0]!) * x) +
        (lm - lo) * (g0[1]! + (g1[1]! - g0[1]!) * x) +
        (stem[i]! - lm) * (g0[2]! + (g1[2]! - g0[2]!) * x);
    }
  }
}

/**
 * Renders the transition described by `plan` into one clip: a few seconds of A alone, the
 * overlap, then B alone until it is safe to hand back to B's own file. A's lead-in and B's
 * lead-out are untouched copies of the tracks (at station gain), which is what lets the player
 * splice the clip in and out without a seam.
 */
export async function renderTransition(
  decodeA: Decode,
  decodeB: Decode,
  a: RenderTrack,
  b: RenderTrack,
  plan: TransitionPlan,
  options: Partial<RenderOptions> = {},
  stems?: { a: DecodeStems; b: DecodeStems },
): Promise<RenderedTransition> {
  const opts = { ...DEFAULT_RENDER_OPTIONS, ...options };
  const stemPlan = plan.stems && stems ? plan.stems : null;
  const sr = RENDER_RATE;
  const leadIn = Math.min(LEAD_IN_SEC, Math.max(0.5, (plan.aStartMs - a.cueInMs) / 1000));
  const overlap = plan.overlapMs / 1000;
  const aStart = plan.aStartMs / 1000;
  const aEnd = plan.aEndMs / 1000;
  let bStart = plan.bStartMs / 1000;
  const aSpan = aEnd - aStart;
  const bSpan = (plan.bEndMs - plan.bStartMs) / 1000;
  const L = Math.round(leadIn * sr);
  const D = Math.round(overlap * sr);
  const maxOut = Math.round(MAX_LEAD_OUT_SEC * sr);
  const total = L + D + maxOut;

  // ---- decode both sides ---------------------------------------------------------------------
  const aFrom = aStart - leadIn;
  const aTail = Math.min(1.5, Math.max(0.03, a.cueOutMs / 1000 - aEnd));
  const aPcm = await decodeA(aFrom, leadIn + aSpan + aTail + 0.25);
  const bFrom = Math.max(0, bStart - 0.25);
  const bPcm = await decodeB(bFrom, bStart - bFrom + bSpan + MAX_LEAD_OUT_SEC + 0.5);
  const aStems = stemPlan ? await stems!.a(aFrom, leadIn + aSpan + aTail + 0.25) : null;
  const bStems = stemPlan
    ? await stems!.b(bFrom, bStart - bFrom + bSpan + MAX_LEAD_OUT_SEC + 0.5)
    : null;
  const gA = dbToLin(a.gainDb);
  const gB = dbToLin(b.gainDb);
  const scale = (pcm: Pcm, g: number) => {
    for (const c of pcm.channels) for (let i = 0; i < c.length; i++) c[i] = c[i]! * g;
  };
  scale(aPcm, gA);
  scale(bPcm, gB);
  for (const s of MIXED_STEMS) {
    if (aStems) scale(aStems[s], gA);
    if (bStems) scale(bStems[s], gB);
  }

  // ---- time maps: clip sample -> input sample ------------------------------------------------
  const sync = plan.sync;
  let beatClip: number[] = []; // clip positions (samples) of the shared beats
  let phiA = (n: number) => n;
  let phiB = (n: number) => n - L + (bStart - bFrom) * sr;
  if (sync) {
    const aP = (sync.aPeriodMs / 1000) * sr;
    const bP = (sync.bPeriodMs / 1000) * sr;
    beatClip = [L];
    for (let i = 0; i < sync.beats; i++) {
      beatClip.push(beatClip[i]! + aP + (bP - aP) * smoothstep((i + 0.5) / sync.beats));
    }
    // Nudge B so its drum hits sit exactly on A's (the grids alone are good to a few ms).
    const envA = transientEnvelope(aPcm.channels, L - sr, L + sync.beats * aP + sr);
    const b0 = (bStart - bFrom) * sr;
    const envB = transientEnvelope(bPcm.channels, b0 - sr, b0 + sync.beats * bP + sr);
    const offsets: number[] = [];
    for (let i = 0; i <= sync.beats; i++) {
      const ha = hitNear(envA, L + i * aP, sr);
      const hb = hitNear(envB, b0 + i * bP, sr);
      if (ha && hb) {
        offsets.push(hb.pos - (b0 + i * bP) - (ha.pos - (L + i * aP)));
      }
    }
    if (process.env.LAB_DEBUG)
      console.log('kick offsets (ms):', offsets.map((o) => Math.round((o / sr) * 1000)).join(' '));
    const shift =
      offsets.length >= 4 ? Math.max(-0.03 * sr, Math.min(0.03 * sr, median(offsets))) : 0;
    bStart += shift / sr;
    const knots = (period: number, origin: number) => (n: number) => {
      if (n <= beatClip[0]!) return origin + (n - beatClip[0]!);
      const last = beatClip.length - 1;
      if (n >= beatClip[last]!) return origin + last * period + (n - beatClip[last]!);
      let i = Math.min(last - 1, Math.floor(((n - L) / D) * last));
      while (i > 0 && beatClip[i]! > n) i--;
      while (i < last - 1 && beatClip[i + 1]! <= n) i++;
      return origin + (i + (n - beatClip[i]!) / (beatClip[i + 1]! - beatClip[i]!)) * period;
    };
    phiA = knots(aP, L);
    phiB = knots(bP, (bStart - bFrom) * sr);
  }

  // A track and its stems are placed together (one grain sequence), so they stay sample-aligned.
  const place = (channels: Float32Array[], phi: (n: number) => number): Float32Array[] => {
    if (sync) return warp(channels, phi, total, sr, { refChannels: 2 });
    const off = Math.round(phi(0));
    return channels.map((src) => {
      const dst = new Float32Array(total);
      for (let n = Math.max(0, -off); n < total && n + off < src.length; n++)
        dst[n] = src[n + off]!;
      return dst;
    });
  };
  const withStems = (pcm: Pcm, st: Record<MixedStem, Pcm> | null) =>
    st
      ? [
          ...pcm.channels,
          ...MIXED_STEMS.flatMap((s) => fit(st[s].channels, pcm.channels[0]!.length)),
        ]
      : pcm.channels;
  const placedA = place(withStems(aPcm, aStems), phiA);
  const placedB = place(withStems(bPcm, bStems), phiB);
  const stemA = placedA.slice(0, 2);
  const stemB = placedB.slice(0, 2);
  const partsOf = (placed: Float32Array[]) =>
    Object.fromEntries(
      MIXED_STEMS.map((s, i) => [s, placed.slice(2 + 2 * i, 4 + 2 * i)]),
    ) as Record<MixedStem, Float32Array[]>;

  // ---- band gains ----------------------------------------------------------------------------
  const tailLen = Math.round(aTail * sr);
  const click = Math.round(0.004 * sr);
  const curveGainA = (curve: Curve, n: number) => {
    if (n <= L) return 1;
    if (n < L + D) return evalCurve(curve, (n - L) / D);
    // After the overlap A's own ring-out (if the curve leaves any) fades away.
    const end = evalCurve(curve, 1);
    const x = (n - (L + D)) / tailLen;
    return x >= 1 ? 0 : end * Math.cos((x * Math.PI) / 2);
  };
  const curveGainB = (curve: Curve, n: number) => {
    if (n < L - click) return 0;
    if (n < L) return (evalCurve(curve, 0) * (n - (L - click))) / click;
    if (n < L + D) return evalCurve(curve, (n - L) / D);
    return 1;
  };
  const gainA = (band: keyof BandCurves, n: number) => curveGainA(plan.a[band], n);
  const gainB = (band: keyof BandCurves, n: number) => curveGainB(plan.b[band], n);
  const mix: [Float32Array, Float32Array] = [new Float32Array(total), new Float32Array(total)];
  if (stemPlan) {
    mixWithStems(mix, stemA, partsOf(placedA), stemPlan.a, (c, n) => curveGainA(c, n));
    mixWithStems(mix, stemB, partsOf(placedB), stemPlan.b, (c, n) => curveGainB(c, n));
  } else {
    for (let c = 0; c < 2; c++) {
      mixStem(mix[c]!, stemA[c]!, sr, gainA);
      mixStem(mix[c]!, stemB[c]!, sr, gainB);
    }
  }

  // ---- no dips, no bumps --------------------------------------------------------------------
  // A and B each have their own level around the transition. The blend must stay between those
  // two levels: never quieter than both (the classic crossfade dip) and never louder than both.
  // The check is on 3 s windows, so the gain is solved for those windows directly: each pass
  // measures every window through the transition and spreads its error over the audio inside
  // it. Gain moves are slew-limited and return to exactly 0 dB before the clip ends.
  const HOP = 0.1;
  const steps = Math.floor(total / sr / HOP) + 1;
  const level = new Float64Array(steps); // correction in dB per 100 ms
  const natural = new LoudnessMeter(mix, sr);
  const levelA = natural.lufs(Math.max(0, leadIn - 3), leadIn);
  const levelB = natural.lufs(leadIn + overlap, leadIn + overlap + 3);
  const bandLow = Math.min(levelA, levelB);
  const bandHigh = Math.max(levelA, levelB);
  const firstStep = Math.ceil((leadIn - 1) / HOP);
  const lastWindow = Math.floor((leadIn + overlap + 1.5) / HOP); // last window centre to hold
  const lastStep = Math.floor((total / sr - 2.5) / HOP);
  const half = Math.round(1.5 / HOP);
  if (opts.leveler) {
    for (let pass = 0; pass < 8; pass++) {
      const meter = new LoudnessMeter(mix, sr);
      const error = new Float64Array(steps);
      for (let i = firstStep; i <= lastWindow; i++) {
        const l = meter.lufs(i * HOP - 1.5, i * HOP + 1.5);
        // Aim a little inside the band so the finished clip clears the 1 LU check comfortably.
        error[i] = Math.max(bandLow - 0.2, Math.min(bandHigh + 0.2, l)) - l;
      }
      const next = new Float64Array(steps);
      for (let i = firstStep; i <= lastStep; i++) {
        let sum = 0;
        let n = 0;
        for (let k = Math.max(firstStep, i - half); k <= Math.min(lastWindow, i + half); k++) {
          sum += error[k]!;
          n++;
        }
        next[i] = n ? Math.max(-MAX_CUT_DB, Math.min(opts.maxLiftDb, level[i]! + sum / n)) : 0;
      }
      // Slew limit, backwards then forwards, so the gain is always heading where it needs to be.
      const maxStep = opts.slewDbPerSec * HOP;
      for (let i = lastStep; i >= firstStep; i--) {
        const after = i === lastStep ? 0 : next[i + 1]!;
        next[i] = Math.max(after - maxStep, Math.min(after + maxStep, next[i]!));
      }
      for (let i = firstStep; i <= lastStep; i++) {
        const before = i === firstStep ? 0 : next[i - 1]!;
        next[i] = Math.max(before - maxStep, Math.min(before + maxStep, next[i]!));
      }
      const applied = new Float64Array(steps);
      for (let i = 0; i < steps; i++) {
        applied[i] = next[i]! - level[i]!;
        level[i] = next[i]!;
      }
      applyGainCurve(mix, applied, HOP, sr);
    }
  }
  if (process.env.LAB_DEBUG) {
    const m = new LoudnessMeter(mix, sr);
    const row = (f: (i: number) => number) =>
      Array.from({ length: Math.floor(steps / 5) }, (_, k) => f(k * 5).toFixed(1)).join(' ');
    console.log(
      'leadIn',
      leadIn,
      'overlap',
      overlap,
      'A',
      levelA.toFixed(1),
      'B',
      levelB.toFixed(1),
    );
    console.log(
      'gain dB  :',
      row((i) => level[i]!),
    );
    console.log(
      'ST(3s)   :',
      row((i) => m.lufs(i * HOP - 3, i * HOP)),
    );
  }
  let lo = 0;
  let hi = 0;
  let releaseEnd = leadIn + overlap + 1.5;
  for (let i = 0; i < steps; i++) {
    lo = Math.min(lo, level[i]!);
    hi = Math.max(hi, level[i]!);
    if (Math.abs(level[i]!) > 0.05) releaseEnd = Math.max(releaseEnd, i * HOP);
  }

  // ---- trim the lead-out, limit peaks, measure ------------------------------------------------
  const leadOut = Math.min(
    MAX_LEAD_OUT_SEC,
    Math.max(MIN_LEAD_OUT_SEC, releaseEnd - (leadIn + overlap) + 2.5),
  );
  const length = L + D + Math.round(leadOut * sr);
  const channels: [Float32Array, Float32Array] = [mix[0].slice(0, length), mix[1].slice(0, length)];
  const limiterReductionDb =
    opts.ceilingDb === null ? 0 : limitTruePeak(channels, sr, opts.ceilingDb);

  const meter = new LoudnessMeter(channels, sr);
  // The band is each song's own (unlevelled) level: A just before the overlap, B just after.
  const beforeLufs = levelA;
  const afterLufs = levelB;
  const low = bandLow;
  const high = bandHigh;
  let excursion = 0;
  for (let t = leadIn; t <= leadIn + overlap + 3 && t <= length / sr; t += 0.1) {
    const l = meter.lufs(t - 3, t);
    excursion = Math.max(excursion, low - l, l - high);
  }
  let quietest = 0;
  const w = Math.round(0.2 * sr);
  for (let s = Math.max(0, L - sr); s + w <= Math.min(length, L + D + 3 * sr); s += w / 2) {
    let e = 0;
    for (const c of channels) for (let i = s; i < s + w; i++) e += c[i]! * c[i]!;
    quietest = Math.min(quietest, 10 * Math.log10(e / (2 * w) + 1e-12));
  }

  let beatErrorMs: TransitionMetrics['beatErrorMs'] = null;
  if (sync) {
    const envA = transientEnvelope(stemA, L - sr, L + D + sr);
    const envB = transientEnvelope(stemB, L - sr, L + D + sr);
    const errors: number[] = [];
    for (const beat of beatClip) {
      const ha = hitNear(envA, beat, sr);
      const hb = hitNear(envB, beat, sr);
      if (ha && hb) {
        errors.push((Math.abs(hb.pos - ha.pos) / sr) * 1000);
      }
    }
    if (process.env.LAB_DEBUG)
      console.log('beat errors (ms):', errors.map((e) => Math.round(e)).join(' '));
    errors.sort((x, y) => x - y);
    beatErrorMs = errors.length
      ? {
          median: Math.round(errors[Math.floor(errors.length / 2)]! * 10) / 10,
          p90:
            Math.round(errors[Math.min(errors.length - 1, Math.floor(errors.length * 0.9))]! * 10) /
            10,
          beats: errors.length,
        }
      : null;
  }

  const round1 = (x: number) => Math.round(x * 10) / 10;
  return {
    channels,
    sampleRate: sr,
    aFileStartMs: Math.round(aFrom * 1000 * 10) / 10,
    leadInMs: Math.round(leadIn * 1000),
    overlapMs: Math.round(overlap * 1000),
    handoff: {
      clipMs: Math.round((leadIn + overlap) * 1000),
      bFileMs: Math.round((bStart + bSpan) * 1000 * 10) / 10,
    },
    clipMs: Math.round((length / sr) * 1000),
    metrics: {
      truePeakDb: round1(truePeakDb(channels)),
      beforeLufs: round1(beforeLufs),
      afterLufs: round1(afterLufs),
      loudnessExcursionLu: Math.round(excursion * 100) / 100,
      quietestDb: round1(quietest),
      beatErrorMs,
      limiterReductionDb: round1(limiterReductionDb),
      levelerRangeDb: [round1(lo), round1(hi)],
    },
  };
}

/** Pads or trims stem channels to the length of the track excerpt they belong to. */
function fit(channels: Float32Array[], length: number): Float32Array[] {
  return channels.map((c) => {
    if (c.length === length) return c;
    const out = new Float32Array(length);
    out.set(c.subarray(0, Math.min(length, c.length)));
    return out;
  });
}

/**
 * Adds one track to the mix with stem-aware gains: the full track follows `base`, and each
 * separated stem adds (its curve - base) of itself. Where all curves agree this is exactly the
 * original track (nothing depends on how clean the separation is); where they differ, that stem
 * is turned up or down on its own.
 */
function mixWithStems(
  mix: [Float32Array, Float32Array],
  full: Float32Array[],
  parts: Record<MixedStem, Float32Array[]>,
  curves: StemCurves,
  gainAt: (curve: Curve, n: number) => number,
) {
  const n = mix[0].length;
  const BLOCK = 64;
  for (let start = 0; start < n; start += BLOCK) {
    const end = Math.min(n, start + BLOCK);
    const g0 = gainAt(curves.base, start);
    const g1 = gainAt(curves.base, end);
    const d0 = MIXED_STEMS.map((s) => gainAt(curves[s], start) - g0);
    const d1 = MIXED_STEMS.map((s, k) => gainAt(curves[s], end) - g1 - d0[k]!);
    const silent = g0 === 0 && g1 === 0 && d0.every((x) => x === 0) && d1.every((x) => x === 0);
    if (silent) continue;
    for (let i = start; i < end; i++) {
      const x = (i - start) / (end - start);
      const g = g0 + (g1 - g0) * x;
      for (let c = 0; c < 2; c++) {
        let v = full[c]![i]! * g;
        for (let k = 0; k < MIXED_STEMS.length; k++) {
          const d = d0[k]! + d1[k]! * x;
          if (d !== 0) v += parts[MIXED_STEMS[k]!][c]![i]! * d;
        }
        mix[c]![i] = mix[c]![i]! + v;
      }
    }
  }
}

/** Multiplies by a dB curve given every `hopSec`, interpolated per sample. */
function applyGainCurve(channels: Float32Array[], db: Float64Array, hopSec: number, sr: number) {
  const n = channels[0]!.length;
  const hop = hopSec * sr;
  for (let i = 0; i < n; i++) {
    const p = i / hop;
    const k = Math.floor(p);
    const d0 = db[k] ?? 0;
    const d1 = db[k + 1] ?? d0;
    if (d0 === 0 && d1 === 0) continue;
    const g = 10 ** ((d0 + (d1 - d0) * (p - k)) / 20);
    for (const c of channels) c[i] = c[i]! * g;
  }
}
