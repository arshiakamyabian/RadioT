import { z } from 'zod';
import type { AiAnalysis } from './ai.js';
import { aiExitPoint, planAiTransition } from './ai-transitions.js';
import { camelotCompatibility, foldTempo, type BeatGrid, type TrackFeatures } from './features.js';

/** Gain automation: [position 0..1 in the overlap, linear gain] points joined by equal-power arcs. */
export const curveSchema = z.array(z.tuple([z.number().min(0).max(1), z.number().min(0).max(2)]));
export type Curve = z.infer<typeof curveSchema>;

const bandCurvesSchema = z.object({ low: curveSchema, mid: curveSchema, high: curveSchema });
export type BandCurves = z.infer<typeof bandCurvesSchema>;

export const stemCurvesSchema = z.object({
  base: curveSchema,
  drums: curveSchema,
  bass: curveSchema,
  vocals: curveSchema,
});
export type StemCurves = z.infer<typeof stemCurvesSchema>;

export const transitionStyleSchema = z.enum(['beatmatch', 'smooth', 'tight', 'cut', 'quick']);
export type TransitionStyle = z.infer<typeof transitionStyleSchema>;

/**
 * How track A hands over to track B. Positions are milliseconds in each cooked file. During the
 * overlap A plays [aStartMs, aEndMs] and B plays [bStartMs, bEndMs]; afterwards B simply
 * continues from bEndMs at normal speed. With `sync` the two are time-warped onto one beat grid
 * that glides from A's tempo to B's, so both are at their own tempo where they are loudest.
 */
export const transitionPlanSchema = z.object({
  v: z.literal(1),
  style: transitionStyleSchema,
  reasons: z.array(z.string()),
  aStartMs: z.number().nonnegative(),
  aEndMs: z.number().nonnegative(),
  bStartMs: z.number(),
  bEndMs: z.number(),
  overlapMs: z.number().positive(),
  sync: z
    .object({
      beats: z.number().int().positive(),
      aPeriodMs: z.number().positive(),
      /** B's beat length after folding half/double time onto A's. */
      bPeriodMs: z.number().positive(),
    })
    .nullable(),
  a: bandCurvesSchema,
  b: bandCurvesSchema,
  /** Plain equal-power fade length for players that cannot use the rendered clip. */
  fallbackCrossfadeMs: z.number().nonnegative(),
  /**
   * Stem-aware gains (AI plans). `base` applies to the whole track; each stem curve replaces it
   * for that stem. When the stems are missing at render time the band curves above are used.
   */
  stems: z.object({ a: stemCurvesSchema, b: stemCurvesSchema }).nullish(),
});
export type TransitionPlan = z.infer<typeof transitionPlanSchema>;

export const transitionModeSchema = z.enum(['auto', 'smooth', 'quick', 'simple']);
export type TransitionMode = z.infer<typeof transitionModeSchema>;

export interface PlanOptions {
  /** auto = pick per pair; smooth / quick = force that style; simple = plain crossfade. */
  mode: TransitionMode;
  /** Longest overlap, seconds. */
  maxSeconds: number;
  /** Multiplier on the lengths the planner would pick (0.5 = shorter, 1.5 = longer). */
  lengthScale: number;
  beatmatch: boolean;
  /** Largest tempo difference (percent) that is still beat-matched. */
  tempoTolerancePct: number;
  bassSwap: boolean;
  defaultCrossfadeMs: number;
}

export const DEFAULT_PLAN_OPTIONS: PlanOptions = {
  mode: 'auto',
  maxSeconds: 20,
  lengthScale: 1,
  beatmatch: true,
  tempoTolerancePct: 6,
  bassSwap: true,
  defaultCrossfadeMs: 5000,
};

export interface PlanTrack {
  cueInMs: number;
  cueOutMs: number;
  crossfadeDurationMs?: number | null;
  features?: TrackFeatures | null;
  /** Pretrained-model analysis (beats, structure, stems); enables the AI planner. */
  ai?: AiAnalysis | null;
}

/** Foreground share (0..100) above which a moment counts as vocals. */
export const VOCAL_ACTIVE = 35;
const MIN_GRID_STRENGTH = 2.5;

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

export function evalCurve(curve: Curve, u: number): number {
  if (!curve.length) return 1;
  if (u <= curve[0]![0]) return curve[0]![1];
  for (let i = 1; i < curve.length; i++) {
    const [u1, g1] = curve[i]!;
    if (u <= u1) {
      const [u0, g0] = curve[i - 1]!;
      const x = u1 > u0 ? (u - u0) / (u1 - u0) : 1;
      return g1 >= g0
        ? g0 + (g1 - g0) * Math.sin((x * Math.PI) / 2)
        : g1 + (g0 - g1) * Math.cos((x * Math.PI) / 2);
    }
  }
  return curve[curve.length - 1]![1];
}

const flat = (g: number): Curve => [
  [0, g],
  [1, g],
];
const ramp = (from: number, to: number, gFrom: number, gTo: number): Curve => [
  [0, gFrom],
  [clamp(from, 0, 1), gFrom],
  [clamp(to, 0, 1), gTo],
  [1, gTo],
];
const allBands = (c: Curve): BandCurves => ({ low: c, mid: c, high: c });

function curveAt(f: TrackFeatures, values: number[] | null, ms: number): number | null {
  if (!values) return null;
  const i = Math.round(ms / f.curveStepMs);
  return i < 0 || i >= values.length ? null : values[i]!;
}

/** Is someone singing/rapping at `ms`? Unknown (no estimate) counts as yes inside the body. */
function vocalAt(t: PlanTrack, ms: number): boolean {
  const f = t.features;
  if (!f || ms < t.cueInMs || ms > t.cueOutMs) return false;
  const v = curveAt(f, f.vocal, ms);
  if (v === null) return ms > f.intro.endMs && ms < f.outro.startMs;
  return v >= VOCAL_ACTIVE;
}

/** Short-term loudness of a track at `ms`, in LU relative to its own integrated loudness. */
function levelAt(t: PlanTrack, ms: number): number {
  const f = t.features;
  const v = f ? curveAt(f, f.loudness, ms) : null;
  return v === null ? (ms < t.cueInMs || ms > t.cueOutMs ? -60 : 0) : v / 10;
}

/**
 * Seconds of the overlap during which both tracks have audible vocals. A voice that sits more
 * than 8 LU under the other track at that moment is masked and does not count.
 */
export function vocalClashSeconds(a: PlanTrack, b: PlanTrack, plan: TransitionPlan): number {
  const step = 250;
  let clash = 0;
  for (let t = 0; t < plan.overlapMs; t += step) {
    const u = t / plan.overlapMs;
    const ta = plan.aStartMs + u * (plan.aEndMs - plan.aStartMs);
    const tb = plan.bStartMs + u * (plan.bEndMs - plan.bStartMs);
    const la = levelAt(a, ta) + 20 * Math.log10(Math.max(1e-3, evalCurve(plan.a.mid, u)));
    const lb = levelAt(b, tb) + 20 * Math.log10(Math.max(1e-3, evalCurve(plan.b.mid, u)));
    if (Math.abs(la - lb) > 8 || Math.min(la, lb) < -25) continue;
    if (vocalAt(a, ta) && vocalAt(b, tb)) clash += step / 1000;
  }
  return clash;
}

const usable = (g: BeatGrid | null | undefined): g is BeatGrid =>
  !!g && g.strength >= MIN_GRID_STRENGTH;

/** Nearest grid beat to `ms`; `every` = 4 snaps to downbeats (the anchor is a downbeat). */
function snap(grid: BeatGrid, ms: number, every = 1, mode: 'near' | 'floor' | 'ceil' = 'near') {
  const step = grid.periodMs * every;
  const k = (ms - grid.anchorMs) / step;
  const r =
    mode === 'near' ? Math.round(k) : mode === 'floor' ? Math.floor(k + 1e-6) : Math.ceil(k - 1e-6);
  return grid.anchorMs + r * step;
}

export interface PairCompatibility {
  /** Tempo of B relative to A after folding half/double time (1 = identical). */
  tempoRatio: number | null;
  tempoMatch: boolean;
  /** 0..1 harmonic compatibility (0.6 when a key is unknown). */
  key: number;
}

export function pairCompatibility(
  a: PlanTrack,
  b: PlanTrack,
  tolerancePct: number,
): PairCompatibility {
  const fa = a.features;
  const fb = b.features;
  const ga = fa?.tailGrid ?? fa?.grid;
  const gb = fb?.headGrid ?? fb?.grid;
  let tempoRatio: number | null = null;
  if (ga && gb) tempoRatio = foldTempo(60_000 / ga.periodMs, 60_000 / gb.periodMs).ratio;
  const keyKnown = fa?.key && fb?.key && fa.key.confidence >= 0.3 && fb.key.confidence >= 0.3;
  return {
    tempoRatio,
    tempoMatch:
      tempoRatio !== null &&
      usable(ga) &&
      usable(gb) &&
      Math.abs(tempoRatio - 1) <= tolerancePct / 100,
    key: keyKnown ? camelotCompatibility(fa!.key!.camelot, fb!.key!.camelot) : 0.6,
  };
}

/** The plain crossfade the station used before: equal power, full band, no analysis needed. */
export function simplePlan(
  a: PlanTrack,
  b: PlanTrack,
  opts: PlanOptions,
  reason: string,
): TransitionPlan {
  const body = Math.max(1000, a.cueOutMs - a.cueInMs);
  const overlap = clamp(a.crossfadeDurationMs ?? opts.defaultCrossfadeMs, 500, body / 2);
  return {
    v: 1,
    style: 'smooth',
    reasons: [reason],
    aStartMs: a.cueOutMs - overlap,
    aEndMs: a.cueOutMs,
    bStartMs: b.cueInMs,
    bEndMs: b.cueInMs + overlap,
    overlapMs: overlap,
    sync: null,
    a: allBands(ramp(0, 1, 1, 0)),
    b: allBands(ramp(0, 1, 0, 1)),
    fallbackCrossfadeMs: overlap,
  };
}

function curvesFor(
  style: TransitionStyle,
  bassSwap: boolean,
  swapAt = 0.5,
  duckMids = false,
  hold = 0,
  bInBy = 0.75,
) {
  let a: BandCurves;
  let b: BandCurves;
  switch (style) {
    case 'beatmatch': {
      // B's top end rises first, the basslines swap on a downbeat, then A's top end leaves.
      const w = 0.04;
      a = {
        low: ramp(swapAt - w, swapAt, 1, 0),
        mid: ramp(Math.min(0.45, swapAt), 1, 1, 0),
        high: ramp(Math.min(0.45, swapAt), 1, 1, 0),
      };
      b = {
        low: ramp(swapAt - w, swapAt, 0, 1),
        mid: ramp(0, Math.max(0.6, swapAt), 0, 1),
        high: ramp(0, Math.max(0.6, swapAt), 0, 1),
      };
      break;
    }
    case 'tight':
      // A plays out its (hard) ending untouched while B's intro rises underneath.
      a = { low: ramp(0.85, 1, 1, 0), mid: ramp(0.9, 1, 1, 0.7), high: ramp(0.9, 1, 1, 0.7) };
      b = { low: ramp(0.55, 0.95, 0, 1), mid: ramp(0, 0.8, 0, 1), high: ramp(0, 0.8, 0, 1) };
      break;
    case 'cut':
      // B starts at full level on the beat; A's ring-out dies under it, lows first.
      a = { low: ramp(0, 0.12, 1, 0), mid: ramp(0, 1, 1, 0), high: ramp(0, 1, 1, 0) };
      b = allBands(flat(1));
      break;
    case 'quick':
      // A is swept away from the bottom up (bass, then mids, then air) so nothing clashes.
      a = { low: ramp(0, 0.25, 1, 0), mid: ramp(0.08, 0.7, 1, 0), high: ramp(0.3, 1, 1, 0) };
      b = { low: ramp(0.25, 0.5, 0, 1), mid: ramp(0, 0.55, 0, 1), high: ramp(0, 0.55, 0, 1) };
      break;
    default: {
      // `hold` keeps A untouched for the first part (B's intro is being tucked in under it).
      const h = hold;
      const r = 1 - h;
      a = {
        low: ramp(h, h + 0.55 * r, 1, 0),
        mid: ramp(h + 0.1 * r, 1, 1, 0),
        high: ramp(h + 0.1 * r, 1, 1, 0),
      };
      const top =
        h > 0 && bInBy < 0.75
          ? Math.max(0.1, bInBy)
          : Math.max(0.1, Math.min(bInBy, Math.max(0.3, h + 0.75 * r) * (h ? 0.6 : 1)));
      b = {
        low: ramp(Math.min(h + 0.3 * r, top * 0.5), Math.min(h + 0.7 * r, top), 0, 1),
        mid: ramp(0, top, 0, 1),
        high: ramp(0, top, 0, 1),
      };
    }
  }
  if (!bassSwap && style !== 'cut') {
    a.low = a.mid;
    b.low = b.mid;
  }
  if (duckMids) {
    // Keep A's voice out of B's way: pull A's mid band down early.
    a.mid = ramp(0, 0.35, 1, 0.25)
      .slice(0, 3)
      .concat([[1, 0]]) as Curve;
  }
  return { a, b };
}

/**
 * Chooses how A should hand over to B from their analysis: where the overlap sits, how long it
 * is, whether the beats are matched, and the gain automation of each band.
 */
export function planTransition(
  a: PlanTrack,
  b: PlanTrack,
  options: Partial<PlanOptions> = {},
): TransitionPlan {
  const opts = { ...DEFAULT_PLAN_OPTIONS, ...options };
  const fa = a.features;
  const fb = b.features;
  if (opts.mode === 'simple') return simplePlan(a, b, opts, 'simple crossfade (admin setting)');
  const ai = planAiTransition(a, b, opts);
  if (ai) return ai;
  if (!fa || !fb) return simplePlan(a, b, opts, 'no deep analysis for this pair');

  const reasons: string[] = [];
  const compat = pairCompatibility(a, b, opts.tempoTolerancePct);
  const aGrid = fa.tailGrid ?? fa.grid;
  const bGridRaw = fb.headGrid ?? fb.grid;
  const fold =
    aGrid && bGridRaw ? foldTempo(60_000 / aGrid.periodMs, 60_000 / bGridRaw.periodMs) : null;
  // B's grid at A's metrical level (a 140 BPM track against a 70 BPM one counts every other beat).
  const bGrid: BeatGrid | null =
    bGridRaw && fold ? { ...bGridRaw, periodMs: bGridRaw.periodMs / fold.multiplier } : null;

  const bBody = b.cueOutMs - b.cueInMs;
  // Voting closes just before this point, so no plan may reach back past it.
  const earliestA = earliestMixMs(a, opts);
  const maxOverlap = Math.max(
    1000,
    Math.min(opts.maxSeconds * 1000, a.cueOutMs - earliestA, bBody * 0.4),
  );
  const scale = (ms: number) => ms * opts.lengthScale;

  const aHasBeat = (fromMs: number) => fa.beatEndMs !== null && fa.beatEndMs >= fromMs;
  let canSync =
    opts.beatmatch && compat.tempoMatch && !!aGrid && !!bGrid && usable(aGrid) && usable(bGrid);
  const keyClash = compat.key < 0.5;

  // ---- pick the style and a target length from A's ending and B's opening ------------------
  let style: TransitionStyle;
  let want: number; // overlap length before snapping to bars
  let aStart: number;
  // Fraction of the overlap during which A stays untouched (B is brought in under it).
  let holdUntil = 0;
  const outro = fa.outro;
  const bIntro = Math.max(0, fb.intro.endMs - b.cueInMs);
  const forced = opts.mode;
  const quietIntro = bIntro >= 3000 && fb.intro.levelLu <= -6;
  const quietOutro = outro.type === 'soft' && outro.levelLu <= -6;

  if (forced === 'quick') {
    style = 'quick';
    want = scale(2500);
    aStart = Math.min(outro.dropMs, a.cueOutMs) - want;
    reasons.push('quick transition (admin setting)');
  } else if (quietIntro && outro.type === 'hard' && forced !== 'smooth') {
    // B opens quietly: tuck that intro under A's last bars so it is at full level when A ends.
    style = 'tight';
    want = clamp(scale(bIntro), 2000, maxOverlap);
    aStart = outro.dropMs - want;
    reasons.push("B has a quiet intro: it plays under A's last bars and takes over as A ends");
  } else if (outro.type === 'fade' || outro.type === 'soft' || forced === 'smooth') {
    style = 'smooth';
    const from = outro.type === 'fade' ? outro.fadeStartMs : outro.startMs;
    const natural = forced === 'smooth' && outro.type === 'hard' ? 8000 : a.cueOutMs - from;
    want = clamp(scale(clamp(natural, 4000, 14_000)), 2000, maxOverlap);
    if (quietIntro && bIntro > want) {
      // Start B early enough that its quiet intro is over when A has gone.
      want = clamp(scale(bIntro), want, maxOverlap);
      reasons.push("B's quiet intro starts early, under A");
    }
    aStart = Math.max(from, a.cueOutMs - want);
    if (a.cueOutMs - aStart < want) aStart = a.cueOutMs - want;
    if (quietOutro && bIntro >= 1500 && fb.intro.type !== 'cold') {
      // Quiet outro meets a soft opening: start B under A's last full bars, so B is at full
      // level by the time A drops into its outro and the two quiet parts do not add up.
      const lead = Math.min(
        bIntro,
        Math.max(0, maxOverlap - (a.cueOutMs - from)),
        from - earliestA,
      );
      if (lead > 500) {
        aStart = from - lead;
        want = a.cueOutMs - aStart;
        reasons.push("B's opening plays under A's last full bars");
      }
    }
    holdUntil = clamp((from - aStart) / want, 0, 0.8);
    reasons.push(
      outro.type === 'fade'
        ? 'A fades out: long smooth crossfade over its fade'
        : outro.type === 'soft'
          ? 'A ends with a quiet outro: B comes in over it'
          : 'smooth crossfade (admin setting)',
    );
    if (keyClash && want > 6000 && !quietIntro) {
      want = 6000;
      aStart = a.cueOutMs - want;
      holdUntil = 0;
      reasons.push('keys clash: crossfade shortened');
    }
  } else if (outro.type === 'tail') {
    style = 'smooth';
    want = clamp(scale(a.cueOutMs - outro.startMs), 1500, Math.min(4000, maxOverlap));
    aStart = a.cueOutMs - want;
    reasons.push('A rings out: short blend over its tail');
  } else if (fb.intro.type === 'cold' || bIntro < 1500) {
    // Hard ending into a track that starts at full level.
    if (canSync && !keyClash && aHasBeat(a.cueOutMs - 4 * aGrid!.periodMs)) {
      style = 'beatmatch';
      want = clamp(scale(16 * aGrid!.periodMs), 4 * aGrid!.periodMs, maxOverlap);
      aStart = outro.dropMs - want;
      reasons.push('hard ending, tempos match: beat-matched blend into the next downbeat');
    } else {
      style = 'cut';
      want = clamp(aGrid ? aGrid.periodMs : 500, 300, 900);
      aStart = outro.dropMs;
      reasons.push(
        keyClash
          ? 'hard ending, keys clash: clean cut on the beat'
          : 'hard ending into a cold start: clean cut on the beat',
      );
    }
  } else if (canSync && !keyClash) {
    // Hard ending, B has a rising intro and the tempos match: mix the intro under A's last bars.
    style = 'beatmatch';
    want = clamp(scale(clamp(bIntro, 8 * aGrid!.periodMs, 32 * aGrid!.periodMs)), 2000, maxOverlap);
    aStart = outro.dropMs - want;
    reasons.push("hard ending, tempos match: B's intro is beat-matched under A's last bars");
  } else {
    style = keyClash ? 'quick' : 'tight';
    want = clamp(scale(clamp(bIntro, 2000, keyClash ? 3000 : 6000)), 1500, maxOverlap);
    aStart = outro.dropMs - want;
    reasons.push(
      keyClash
        ? 'hard ending, keys clash: quick filtered transition'
        : "hard ending: B's intro rises under A's final bars",
    );
  }
  if (style !== 'beatmatch' && style !== 'cut' && canSync && !aHasBeat(aStart + want / 2))
    canSync = false;
  if (style === 'cut') canSync = false;
  aStart = Math.max(earliestA, aStart);

  // A's quiet outro is a bed, not something to wait for: B is at full level within ~3 s.
  const bInBy = (overlapMs: number) =>
    quietOutro ? (holdUntil > 0 ? holdUntil : clamp(3000 / overlapMs, 0.15, 0.75)) : 0.75;
  const build = (overlapWanted: number, duck: boolean): TransitionPlan => {
    let aS = Math.max(
      earliestA,
      style === 'cut' ? aStart : Math.min(aStart, a.cueOutMs - overlapWanted),
    );
    if (style !== 'cut' && style !== 'smooth')
      aS = Math.max(earliestA, outro.dropMs - overlapWanted);
    let plan: TransitionPlan;
    if (canSync && aGrid && bGrid) {
      const mean = (aGrid.periodMs + bGrid.periodMs) / 2;
      // Whole phrases only: 1, 2, 4, 8 or 16 bars.
      let beats = 4;
      for (const n of [8, 16, 32, 64]) if (n * mean <= overlapWanted * 1.15) beats = n;
      // A's side starts on one of its downbeats; hard endings finish on the last one.
      const lastDown = snap(aGrid, outro.dropMs + aGrid.periodMs / 4, 4, 'floor');
      let aS2 = style === 'smooth' ? snap(aGrid, aS, 4) : lastDown - beats * aGrid.periodMs;
      while (
        beats > 4 &&
        (aS2 < earliestA || aS2 + beats * aGrid.periodMs > a.cueOutMs + aGrid.periodMs)
      ) {
        beats /= 2;
        aS2 = style === 'smooth' ? aS2 : lastDown - beats * aGrid.periodMs;
      }
      if (aS2 < earliestA) aS2 = snap(aGrid, earliestA, 4, 'ceil');
      // B's first downbeat lands on that A downbeat; anything before it (a pickup) plays earlier.
      const firstDown = snap(bGrid, b.cueInMs, 4, 'ceil');
      const pickup = firstDown - b.cueInMs;
      const bS2 = pickup > 60 ? firstDown - 4 * bGrid.periodMs : firstDown;
      const swapBeat = Math.round(beats / 2 / 4) * 4 || Math.round(beats / 2);
      const { a: ca, b: cb } = curvesFor(
        style,
        opts.bassSwap,
        swapBeat / beats,
        duck,
        holdUntil,
        bInBy(beats * mean),
      );
      plan = {
        v: 1,
        style,
        reasons: [...reasons, `beat-matched over ${beats} beats`],
        aStartMs: aS2,
        aEndMs: aS2 + beats * aGrid.periodMs,
        bStartMs: bS2,
        bEndMs: bS2 + beats * bGrid.periodMs,
        overlapMs: beats * mean,
        sync: { beats, aPeriodMs: aGrid.periodMs, bPeriodMs: bGrid.periodMs },
        a: ca,
        b: cb,
        fallbackCrossfadeMs: Math.min(12_000, beats * mean),
      };
    } else {
      let overlap = overlapWanted;
      let bS = b.cueInMs;
      if (style === 'cut') {
        // B's first downbeat (or first sound) lands on A's next beat after its final hit.
        const usableA = usable(aGrid) ? aGrid : null;
        const hit = usableA ? snap(usableA, outro.dropMs - 40, 1, 'ceil') : outro.dropMs;
        const bDown = usable(bGridRaw) ? snap(bGridRaw, b.cueInMs, 4, 'ceil') : b.cueInMs;
        const lead = bDown - b.cueInMs <= (bGridRaw?.periodMs ?? 0) * 2 ? bDown - b.cueInMs : 0;
        aS = Math.max(earliestA, Math.min(hit, a.cueOutMs) - lead);
        overlap = Math.max(overlap, a.cueOutMs - aS);
        overlap = clamp(overlap, 250, 2500);
        bS = b.cueInMs;
      }
      const { a: ca, b: cb } = curvesFor(
        style,
        opts.bassSwap,
        0.5,
        duck,
        holdUntil,
        bInBy(overlap),
      );
      plan = {
        v: 1,
        style,
        reasons: [...reasons],
        aStartMs: aS,
        aEndMs: aS + overlap,
        bStartMs: bS,
        bEndMs: bS + overlap,
        overlapMs: overlap,
        sync: null,
        a: ca,
        b: cb,
        fallbackCrossfadeMs: Math.min(12_000, overlap),
      };
    }
    return plan;
  };

  // ---- avoid two voices at once: shorten, then duck A's mids ---------------------------------
  let plan = build(want, false);
  if (style !== 'cut') {
    const floor = canSync && aGrid ? 8 * aGrid.periodMs : 2000;
    let length = want;
    let clash = vocalClashSeconds(a, b, plan);
    while (clash > 1.5 && length / 2 >= floor) {
      length /= 2;
      plan = build(length, false);
      clash = vocalClashSeconds(a, b, plan);
      if (clash <= 1.5) plan.reasons.push('shortened so the two vocals do not overlap');
    }
    if (clash > 1.5) {
      plan = build(length, true);
      plan.reasons.push("both vocals are active: A's mids are ducked under B");
    }
  }
  return plan;
}

/**
 * How long A is on air before B's cue-in is (virtually) on air: the round's airtime. B's
 * timeline is anchored at the end of the overlap, where it is back at normal speed.
 */
export function planAirtimeMs(a: PlanTrack, b: PlanTrack, plan: TransitionPlan): number {
  return Math.max(0, plan.aStartMs - a.cueInMs + plan.overlapMs - (plan.bEndMs - b.cueInMs));
}

/**
 * The earliest point (ms into A's file) at which any transition out of A may begin. Voting
 * must close before this, because the next track has to be known when the mix starts, and
 * `planTransition` never starts earlier. It depends on A alone: how long the mix really gets
 * also depends on B (a long quiet intro is started early, under A), which is not known yet.
 */
export function earliestMixMs(a: PlanTrack, options: Partial<PlanOptions> = {}): number {
  const opts = { ...DEFAULT_PLAN_OPTIONS, ...options };
  const body = a.cueOutMs - a.cueInMs;
  const f = a.features;
  // With the AI analysis A's exit point is known before B is: voting closes just before it.
  const exit = opts.mode === 'auto' ? aiExitPoint(a, opts.maxSeconds) : null;
  if (exit) return exit.atMs;
  if (!f || opts.mode === 'simple') {
    return a.cueOutMs - clamp(a.crossfadeDurationMs ?? opts.defaultCrossfadeMs, 500, body / 2);
  }
  const earliest = a.cueInMs + Math.min(20_000, body * 0.4);
  const bar = (f.tailGrid ?? f.grid)?.periodMs ?? 0;
  const longest = Math.min(opts.maxSeconds * 1000, a.cueOutMs - earliest) + bar * 4;
  return Math.max(earliest, Math.min(a.cueOutMs - 1000, a.cueOutMs - longest));
}

/**
 * 0..1: how well B follows A in a rotation. Rewards matching tempo, compatible keys and a
 * gentle energy step, so the station flows instead of jumping around.
 */
export function flowScore(a: PlanTrack, b: PlanTrack, tolerancePct = 6): number {
  const fa = a.features;
  const fb = b.features;
  if (!fa || !fb) return 0.5;
  const compat = pairCompatibility(a, b, tolerancePct);
  const diff = compat.tempoRatio === null ? 0.12 : Math.abs(compat.tempoRatio - 1);
  const tempo =
    diff <= tolerancePct / 100
      ? 1 - diff * 4
      : clamp(0.6 - (diff - tolerancePct / 100) * 3, 0, 0.6);
  const step = fb.energy - fa.energy;
  // A small lift is ideal; big drops and big jumps both feel abrupt.
  const energy = clamp(1 - Math.abs(step - 0.05) * 2.2, 0, 1);
  return Math.round((0.45 * tempo + 0.35 * compat.key + 0.2 * energy) * 1000) / 1000;
}

/** How much of the longest wait a track must itself have waited to be played ahead of it. */
const FLOW_MIN_WAIT_SHARE = 0.75;

/**
 * Orders rotation candidates (given least-recently-played first) for flow: at each step the best
 * follow-up among the `window` longest-waiting tracks is taken.
 *
 * `waitedMs` (time since the track last aired, Infinity if never) keeps that fair: a track is
 * only passed over by one that has waited at least three quarters as long. Without it a track
 * that follows nothing well would be passed over on every pick and never air, which in a small
 * library means two songs alternating forever.
 */
export function orderForFlow<T extends PlanTrack & { waitedMs?: number }>(
  current: PlanTrack | null,
  lruFirst: T[],
  window = 3,
): T[] {
  const rest = [...lruFirst];
  const out: T[] = [];
  let prev = current;
  while (rest.length) {
    let pick = 0;
    if (prev) {
      const longest = rest[0]!.waitedMs;
      let best = -1;
      for (let i = 0; i < Math.min(window, rest.length); i++) {
        const waited = rest[i]!.waitedMs;
        if (i > 0 && longest !== undefined && waited !== undefined) {
          if (longest === Infinity ? waited !== Infinity : waited < longest * FLOW_MIN_WAIT_SHARE)
            continue;
        }
        // Waiting longer is worth a little, so ties go to the track that has waited most.
        const s = flowScore(prev, rest[i]!) - i * 0.02;
        if (s > best) {
          best = s;
          pick = i;
        }
      }
    }
    const [next] = rest.splice(pick, 1);
    out.push(next!);
    prev = next!;
  }
  return out;
}

/** Where a rendered clip sits relative to the two files; stored with the clip and sent to players. */
export const transitionClipSchema = z.object({
  /** Position in A's file of the clip's first sample. */
  aFileStartMs: z.number().nonnegative(),
  /** A alone, untouched: the player splices from A's file into the clip somewhere in here. */
  leadInMs: z.number().nonnegative(),
  overlapMs: z.number().nonnegative(),
  /** From here on the clip is B alone at normal speed... */
  handoffClipMs: z.number().nonnegative(),
  /** ...playing this position of B's file, so the player can splice back to the file. */
  handoffFileMs: z.number(),
  clipMs: z.number().positive(),
});
export type TransitionClip = z.infer<typeof transitionClipSchema>;

/** The renderer's measurements of a clip (see docs/transitions.md for what each means). */
export const transitionMetricsSchema = z.object({
  truePeakDb: z.number(),
  beforeLufs: z.number(),
  afterLufs: z.number(),
  loudnessExcursionLu: z.number(),
  quietestDb: z.number(),
  beatErrorMs: z.object({ median: z.number(), p90: z.number(), beats: z.number() }).nullable(),
  limiterReductionDb: z.number(),
  levelerRangeDb: z.tuple([z.number(), z.number()]),
});
export type TransitionMetricsRecord = z.infer<typeof transitionMetricsSchema>;
