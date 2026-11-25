import {
  STEM_ACTIVE_DB,
  analysedEdges,
  gridFromBeats,
  nearestDownbeat,
  phrasePoints,
  stemLastActiveMs,
  stemLevelDb,
  stemOnsetMs,
  stemReferenceDb,
  type AiAnalysis,
} from './ai.js';
import { camelotCompatibility, foldTempo, type BeatGrid } from './features.js';
import { evalCurve } from './transitions.js';
import type { Curve, PlanOptions, PlanTrack, StemCurves, TransitionPlan } from './transitions.js';

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const ramp = (from: number, to: number, gFrom: number, gTo: number): Curve => [
  [0, gFrom],
  [clamp(from, 0, 1), gFrom],
  [clamp(Math.max(from, to), 0, 1), gTo],
  [1, gTo],
];
const MIN_SYNC_STRENGTH = 2.5;
/** The AI planner only looks for its exit in the last minute (stems are cut around it). */
const EXIT_SEARCH_MS = 60_000;
const MIN_OVERLAP_MS = 3000;
/** Longest blend without beat matching. */
const UNSYNCED_MAX_MS = 12_000;
/**
 * What the renderer reads around a plan, beyond its overlap: A from 4 s before its exit (the
 * lead-in), B up to 14 s after the overlap (the lead-out). With edge-only stems both have to stay
 * inside the separated parts.
 */
const STEMS_BEFORE_EXIT_MS = 4500;
const STEMS_AFTER_OVERLAP_MS = 15_000;

/** Where A's audible music ends: the DSP drop point when known, else the cue-out. */
function audibleEnd(a: PlanTrack) {
  const drop = a.features?.outro.dropMs;
  return drop && drop > a.cueInMs ? Math.min(a.cueOutMs, drop) : a.cueOutMs;
}

export interface ExitPoint {
  atMs: number;
  reason: string;
}

/**
 * Where A starts handing over, chosen from A alone: the start of its outro when the model found
 * one, otherwise the phrase end (section boundary or 8-bar mark, on a downbeat) that leaves a
 * good overlap length and the least of A's vocals still to come. Because it ignores B, voting
 * can close a few seconds before it.
 */
export function aiExitPoint(a: PlanTrack, maxSeconds: number): ExitPoint | null {
  const ai = a.ai;
  if (!ai || ai.downbeatsMs.length < 8) return null;
  const end = audibleEnd(a);
  const maxLen = maxSeconds * 1000;
  // The exit may sit further back than one overlap (a long outro): the mix then completes
  // before A's last bars, which is what a DJ does with a long outro.
  const earliest = Math.max(
    a.cueInMs + (a.cueOutMs - a.cueInMs) * 0.4,
    end - EXIT_SEARCH_MS,
    analysedEdges(ai).tailStartMs + STEMS_BEFORE_EXIT_MS,
  );
  const latest = end - MIN_OVERLAP_MS - 1000;
  if (latest <= earliest) return null;

  const outro = ai.segments.find((s) => s.label === 'outro' && s.startMs < end - MIN_OVERLAP_MS);
  const target = Math.min(maxLen, 16_000);
  let best: ExitPoint | null = null;
  let bestScore = -Infinity;
  for (const p of phrasePoints(ai)) {
    if (p < earliest || p > latest) continue;
    const remaining = end - p;
    // Overlap this exit would get; an exit far from the end also leaves A's remainder unheard.
    const overlap = Math.min(remaining, maxLen);
    let score = -Math.abs(overlap - target) / 4000 - Math.max(0, remaining - maxLen) / 8000;
    let reason = 'phrase end';
    if (outro && Math.abs(nearestDownbeat(ai, outro.startMs) - p) < 600) {
      score += 3;
      reason = 'start of the outro';
    } else if (ai.segments.some((s) => Math.abs(s.startMs - p) < 600)) {
      score += 1;
      reason = `start of the ${ai.segments.find((s) => Math.abs(s.startMs - p) < 600)!.label}`;
    }
    const lastVocal = stemLastActiveMs(ai, 'vocals', p, end);
    const vocalShare = lastVocal === null ? 0 : (lastVocal - p) / remaining;
    score -= 2 * vocalShare;
    if (score > bestScore) {
      bestScore = score;
      best = { atMs: p, reason };
    }
  }
  return best;
}

/** Whole bars of A's grid from `atMs` to its 4-beat downbeat grid. */
function firstDownbeatAfter(ai: AiAnalysis, atMs: number) {
  return ai.downbeatsMs.find((d) => d >= atMs - 50) ?? null;
}

const usable = (g: BeatGrid | null): g is BeatGrid => !!g && g.strength >= MIN_SYNC_STRENGTH;

/**
 * Plans A -> B from the pretrained models' analysis: starts at A's exit point, beat-matches when
 * the tempos allow, and mixes per stem so the two vocals never overlap (A's voice goes first,
 * B's instrumental comes in before its voice, drums first when beat-matched, basslines swap on a
 * downbeat). Returns null when either side lacks the analysis, so the DSP planner takes over.
 */
export function planAiTransition(
  a: PlanTrack,
  b: PlanTrack,
  opts: PlanOptions,
): TransitionPlan | null {
  const aai = a.ai;
  const bai = b.ai;
  if (!aai || !bai || opts.mode !== 'auto') return null;
  const exit = aiExitPoint(a, opts.maxSeconds);
  if (!exit) return null;
  const end = audibleEnd(a);
  const reasons = [`AI: A leaves at the ${exit.reason} (${(exit.atMs / 1000).toFixed(1)} s)`];

  // ---- beat matching ---------------------------------------------------------------------------
  const ga = gridFromBeats(aai, exit.atMs - 30_000, a.cueOutMs);
  const gbRaw = gridFromBeats(bai, b.cueInMs, b.cueInMs + 60_000);
  const fold = ga && gbRaw ? foldTempo(60_000 / ga.periodMs, 60_000 / gbRaw.periodMs) : null;
  const gb = gbRaw && fold ? { ...gbRaw, periodMs: gbRaw.periodMs / fold.multiplier } : null;
  const keyA = a.features?.key;
  const keyB = b.features?.key;
  const keyOk =
    !keyA || !keyB || keyA.confidence < 0.3 || keyB.confidence < 0.3
      ? true
      : camelotCompatibility(keyA.camelot, keyB.camelot) >= 0.5;
  const tempoOk = !!fold && Math.abs(fold.ratio - 1) <= opts.tempoTolerancePct / 100;
  const room = end - exit.atMs;
  // B's stems end with its separated opening: the overlap plus the lead-out has to fit in it.
  const bRoom = analysedEdges(bai).headEndMs - STEMS_AFTER_OVERLAP_MS;
  let sync: TransitionPlan['sync'] = null;
  const aStart = exit.atMs;
  let aEnd: number;
  let bStart: number;
  let bEnd: number;
  let overlap: number;
  if (opts.beatmatch && tempoOk && keyOk && usable(ga) && usable(gb)) {
    const mean = (ga.periodMs + gb.periodMs) / 2;
    const firstDown = firstDownbeatAfter(bai, b.cueInMs) ?? b.cueInMs;
    const pickup = firstDown - b.cueInMs;
    const syncStart =
      pickup > 60 && pickup <= 4 * gb.periodMs ? firstDown - 4 * gb.periodMs : firstDown;
    let beats = 0;
    for (const n of [8, 16, 32, 64])
      if (
        n * mean <= Math.min(room, opts.maxSeconds * 1000) &&
        syncStart + n * gb.periodMs <= bRoom
      )
        beats = n;
    if (beats >= 8) {
      bStart = syncStart;
      aEnd = aStart + beats * ga.periodMs;
      bEnd = bStart + beats * gb.periodMs;
      overlap = beats * mean;
      sync = { beats, aPeriodMs: ga.periodMs, bPeriodMs: gb.periodMs };
      reasons.push(
        `beat-matched over ${beats} beats (${(60_000 / ga.periodMs).toFixed(1)} -> ${(60_000 / gb.periodMs).toFixed(1)} BPM)`,
      );
    }
  }
  if (!sync) {
    // Not even the shortest blend fits in B's separated opening (an unusually late cue-in).
    if (bRoom - b.cueInMs < MIN_OVERLAP_MS) return null;
    // Unsynchronised music clashes rhythmically, so keep such blends short (about 4-6 bars).
    overlap = clamp(
      room,
      MIN_OVERLAP_MS,
      Math.min(opts.maxSeconds * 1000, UNSYNCED_MAX_MS, bRoom - b.cueInMs),
    );
    aEnd = aStart + overlap;
    bStart = b.cueInMs;
    bEnd = bStart + overlap;
    reasons.push(
      !tempoOk
        ? 'tempos too far apart: blended without beat matching'
        : !keyOk
          ? 'keys clash: blended without beat matching'
          : 'no steady beat to match: blended',
    );
  }

  // ---- stem curves -----------------------------------------------------------------------------
  const uOf = (from: number, to: number, t: number) => (to > from ? (t - from) / (to - from) : 1);
  const aVocalLast = stemLastActiveMs(aai, 'vocals', aStart!, aEnd!);
  const bVocalOn = stemOnsetMs(bai, 'vocals', bStart!, bEnd! + 1000);
  const uBVocal = bVocalOn === null ? 1 : clamp(uOf(bStart!, bEnd!, bVocalOn), 0, 1);
  // A's voice is gone before B's starts: it fades over the first part of the overlap.
  const aVocalOut = aVocalLast === null ? 0 : clamp(Math.min(0.4, uBVocal - 0.05), 0.12, 0.4);
  const bVocalIn = Math.max(aVocalOut, uBVocal);
  if (aVocalLast !== null) reasons.push("A's vocals fade out first");
  if (bVocalOn !== null && uBVocal < aVocalOut)
    reasons.push("B's first vocal line is held back until A's voice is gone");
  else if (bVocalOn !== null && uBVocal < 1)
    reasons.push("B's instrumental comes in before its vocals");

  // B opens quietly (a build-up): A has to stay up until B reaches its full level, or the blend
  // sinks into a hole where both are quiet.
  const fb = b.features;
  const introU =
    fb && fb.intro.levelLu <= -5 && fb.intro.endMs > bStart! + 2000
      ? clamp((fb.intro.endMs - bStart!) / overlap!, 0, 0.85)
      : 0;
  if (introU > 0) reasons.push("B opens quietly: A stays up until B's full level arrives");
  const swapAt = sync ? clamp((Math.round(sync.beats / 2 / 4) * 4) / sync.beats, 0.25, 0.75) : 0.5;
  const swap = Math.max(swapAt, introU > 0 ? Math.min(0.9, introU + 0.05) : 0);
  const w = sync ? Math.min(0.04, 1 / sync.beats) : 0.06;
  const aCurves: StemCurves = {
    base: ramp(Math.max(0.45, introU), 1, 1, 0),
    vocals: aVocalLast === null ? ramp(0.45, 1, 1, 0) : ramp(0, aVocalOut, 1, 0),
    // Beat-matched: A's kick keeps time until the swap; otherwise it leaves before B's comes in.
    // Unsynchronised drums never overlap: A's out and B's in at the same instant, so the rhythm
    // changes hands without a hole (a hole is a loudness dip) or a clash.
    drums: sync ? ramp(swap, 1, 1, 0) : ramp(swap - w, swap, 1, 0),
    bass: ramp(swap - w, swap, 1, 0),
  };
  const bCurves: StemCurves = {
    base: ramp(0, introU > 0 ? 0.3 : 0.6, 0, 1),
    vocals: ramp(bVocalIn, Math.min(1, bVocalIn + 0.08), 0, 1),
    drums: sync ? ramp(0, 0.25, 0, 1) : ramp(swap - w, swap, 0, 1),
    bass: ramp(swap - w, swap, 0, 1),
  };
  reasons.push(
    sync
      ? 'drums enter first, basslines swap on a downbeat'
      : 'basslines swap, drums never double up',
  );

  return {
    v: 1,
    style: sync ? 'beatmatch' : 'smooth',
    reasons,
    aStartMs: aStart,
    aEndMs: aEnd!,
    bStartMs: bStart!,
    bEndMs: bEnd!,
    overlapMs: overlap!,
    sync,
    a: opts.bassSwap
      ? { low: aCurves.bass, mid: aCurves.base, high: aCurves.base }
      : { low: aCurves.base, mid: aCurves.base, high: aCurves.base },
    b: opts.bassSwap
      ? { low: bCurves.bass, mid: bCurves.base, high: bCurves.base }
      : { low: bCurves.base, mid: bCurves.base, high: bCurves.base },
    fallbackCrossfadeMs: Math.min(12_000, overlap!),
    stems: { a: aCurves, b: bCurves },
  };
}

/**
 * Seconds of the overlap during which both vocals are audible at once, measured on the vocal
 * stems with the plan's gains (stem curves, or the mid band for plans without them). A voice
 * more than 10 dB under the other is masked and does not count.
 */
export function vocalOverlapSeconds(
  a: PlanTrack,
  b: PlanTrack,
  plan: TransitionPlan,
): number | null {
  if (!a.ai || !b.ai) return null;
  const refA = stemReferenceDb(a.ai, 'vocals');
  const refB = stemReferenceDb(b.ai, 'vocals');
  const step = 100;
  let both = 0;
  for (let t = 0; t < plan.overlapMs; t += step) {
    const u = t / plan.overlapMs;
    const ta = plan.aStartMs + u * (plan.aEndMs - plan.aStartMs);
    const tb = plan.bStartMs + u * (plan.bEndMs - plan.bStartMs);
    const ga = evalCurve(plan.stems?.a.vocals ?? plan.a.mid, u);
    const gb = evalCurve(plan.stems?.b.vocals ?? plan.b.mid, u);
    const la = stemLevelDb(a.ai, 'vocals', ta) + 20 * Math.log10(Math.max(1e-4, ga));
    const lb = stemLevelDb(b.ai, 'vocals', tb) + 20 * Math.log10(Math.max(1e-4, gb));
    const aOn = la >= refA - STEM_ACTIVE_DB;
    const bOn = lb >= refB - STEM_ACTIVE_DB;
    if (aOn && bOn && Math.abs(la - lb) <= 10) both += step / 1000;
  }
  return Math.round(both * 10) / 10;
}
