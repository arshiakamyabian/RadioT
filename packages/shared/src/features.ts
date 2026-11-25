import { z } from 'zod';

const ms = z.number().int().nonnegative();

/** A constant-tempo beat grid: beat k is at `anchorMs + k * periodMs`; `anchorMs` is a downbeat. */
export const beatGridSchema = z.object({
  periodMs: z.number().positive(),
  anchorMs: z.number(),
  /** On-beat onset strength relative to the average (1 = no beat at all, 3+ = clear beat). */
  strength: z.number().nonnegative(),
});
export type BeatGrid = z.infer<typeof beatGridSchema>;

export const introTypeSchema = z.enum(['cold', 'fade-in', 'soft']);
export const outroTypeSchema = z.enum(['hard', 'fade', 'tail', 'soft']);

/**
 * Everything the transition planner needs to know about a track, computed once by the worker.
 * Times are milliseconds in the cooked file. Curves are sampled every `curveStepMs`.
 */
export const trackFeaturesSchema = z.object({
  v: z.literal(1),
  /** Tempo in BPM (null when no steady beat was found). */
  bpm: z.number().positive().nullable(),
  /** Whole-track grid; null when the tempo drifts or there is no clear beat. */
  grid: beatGridSchema.nullable(),
  /** Grids refined on the first / last minute, where transitions happen. */
  headGrid: beatGridSchema.nullable(),
  tailGrid: beatGridSchema.nullable(),
  /** 0..1: how sure we are which beat of the bar is "the one". */
  downbeatConfidence: z.number().min(0).max(1),
  /** Bars from the grid anchor to the first 8-bar phrase boundary (0..7). */
  phraseOffsetBars: z.number().int().min(0).max(7),
  /** First / last moment the drums are playing. */
  beatStartMs: ms.nullable(),
  beatEndMs: ms.nullable(),
  key: z
    .object({
      tonic: z.number().int().min(0).max(11),
      mode: z.enum(['major', 'minor']),
      camelot: z.string(),
      confidence: z.number().min(0).max(1),
    })
    .nullable(),
  /** 0..1 overall intensity (loudness of the master, onset density, tempo). */
  energy: z.number().min(0).max(1),
  intro: z.object({
    type: introTypeSchema,
    /** Where the track reaches its full level. */
    endMs: ms,
    /** Average level of the intro relative to the whole track (LU). */
    levelLu: z.number(),
  }),
  outro: z.object({
    type: outroTypeSchema,
    /** Where the full-level body ends and the fade / tail / quiet outro begins. */
    startMs: ms,
    /** Where a fade-out really starts (earlier than startMs for long fades). */
    fadeStartMs: ms,
    /** Last moment with real energy (10 LU below the body). */
    dropMs: ms,
    levelLu: z.number(),
  }),
  curveStepMs: z.number().int().positive(),
  /** Short-term loudness (3 s window) relative to the track's integrated loudness, in 0.1 LU. */
  loudness: z.array(z.number().int()),
  /** Foreground (vocal / lead) activity 0..100, or null when it could not be estimated. */
  vocal: z.array(z.number().int().min(0).max(100)).nullable(),
  vocalInMs: ms.nullable(),
  vocalOutMs: ms.nullable(),
});
export type TrackFeatures = z.infer<typeof trackFeaturesSchema>;

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;
// Camelot wheel number for each tonic (index = pitch class).
const CAMELOT_MINOR = [5, 12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10];
const CAMELOT_MAJOR = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1];

export function camelotOf(tonic: number, mode: 'major' | 'minor') {
  return mode === 'minor' ? `${CAMELOT_MINOR[tonic]}A` : `${CAMELOT_MAJOR[tonic]}B`;
}

export function keyName(tonic: number, mode: 'major' | 'minor') {
  return `${NOTE_NAMES[tonic]}${mode === 'minor' ? 'm' : ''}`;
}

/**
 * Harmonic compatibility of two Camelot codes, 0..1. Same key or relative major/minor = 1,
 * a step around the wheel = 0.9, two steps / diagonal = 0.6, everything else clashes.
 */
export function camelotCompatibility(a: string, b: string): number {
  const pa = /^(\d+)([AB])$/.exec(a);
  const pb = /^(\d+)([AB])$/.exec(b);
  if (!pa || !pb) return 0.5;
  const na = Number(pa[1]);
  const nb = Number(pb[1]);
  const steps = Math.min((na - nb + 12) % 12, (nb - na + 12) % 12);
  const sameLetter = pa[2] === pb[2];
  if (steps === 0) return 1;
  if (steps === 1) return sameLetter ? 0.9 : 0.6;
  if (steps === 2 && sameLetter) return 0.6;
  return 0.2;
}

/**
 * Tempo ratio b/a folded so that half- and double-time count as the same tempo
 * (70 and 140 BPM mix like one). Returns the multiplier applied to b and the folded ratio.
 */
export function foldTempo(bpmA: number, bpmB: number): { multiplier: 0.5 | 1 | 2; ratio: number } {
  let best: { multiplier: 0.5 | 1 | 2; ratio: number } = { multiplier: 1, ratio: bpmB / bpmA };
  for (const m of [0.5, 1, 2] as const) {
    const r = (bpmB * m) / bpmA;
    if (Math.abs(Math.log(r)) < Math.abs(Math.log(best.ratio))) best = { multiplier: m, ratio: r };
  }
  return best;
}
