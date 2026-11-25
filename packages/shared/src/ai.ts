import { z } from 'zod';
import type { BeatGrid } from './features.js';

const ms = z.number().int();

export const STEM_NAMES = ['drums', 'bass', 'other', 'vocals'] as const;
export type StemName = (typeof STEM_NAMES)[number];

/** Section labels All-In-One predicts (Harmonix set). */
export const SEGMENT_LABELS = [
  'start',
  'end',
  'intro',
  'outro',
  'break',
  'bridge',
  'inst',
  'solo',
  'verse',
  'chorus',
] as const;

/**
 * What the pretrained models found in a cooked track (apps/worker/ml/analyze.py). Times are
 * milliseconds in the cooked file. Stem curves are RMS levels in 0.1 dBFS every `stepMs`.
 */
export const aiAnalysisSchema = z.object({
  v: z.literal(1),
  models: z.object({
    stems: z.string(),
    beats: z.string(),
    structure: z.string().nullable(),
  }),
  durationMs: ms,
  bpm: z.number().positive().nullable(),
  beatsMs: z.array(ms),
  downbeatsMs: z.array(ms),
  segments: z.array(z.object({ startMs: ms, endMs: ms, label: z.string() })),
  stemCurves: z.object({
    stepMs: z.number().int().positive(),
    drums: z.array(z.number().int()),
    bass: z.array(z.number().int()),
    other: z.array(z.number().int()),
    vocals: z.array(z.number().int()),
  }),
  /** File names of the FLAC stems (relative to the track's stem folder / storage prefix). */
  stemFiles: z.record(z.string(), z.string()),
  /**
   * Parts of the song that were separated, [startMs, endMs] each (usually the opening and the last
   * minute; the stems are silent in between). Unset: the whole song.
   */
  analysedMs: z.array(z.tuple([ms, ms])).optional(),
  /** Storage key prefix of the uploaded stems (`stems/<kind>/<id>/`); unset in the lab. */
  stemPrefix: z.string().optional(),
  timings: z.record(z.string(), z.number()).optional(),
});
export type AiAnalysis = z.infer<typeof aiAnalysisSchema>;

/** Where the separated opening ends, and where the separated ending starts (ms). */
export function analysedEdges(ai: AiAnalysis) {
  const r = ai.analysedMs;
  if (!r || r.length < 2) return { headEndMs: Infinity, tailStartMs: -Infinity };
  return { headEndMs: r[0]![1], tailStartMs: r[r.length - 1]![0] };
}

/** Level of a stem at `atMs` in dBFS (-90 outside the track). */
export function stemLevelDb(ai: AiAnalysis, stem: StemName, atMs: number): number {
  const c = ai.stemCurves[stem];
  const i = Math.round(atMs / ai.stemCurves.stepMs);
  return i < 0 || i >= c.length ? -90 : c[i]! / 10;
}

/** Loudest level the stem reaches across the song (95th percentile), dBFS. */
export function stemReferenceDb(ai: AiAnalysis, stem: StemName): number {
  const step = ai.stemCurves.stepMs;
  const inside = (i: number) =>
    !ai.analysedMs || ai.analysedMs.some(([a, b]) => i * step >= a && i * step < b);
  const s = ai.stemCurves[stem].filter((_, i) => inside(i)).sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length * 0.95)]! / 10 : -90;
}

/** A stem counts as playing when it is within this many dB of its own loud passages. */
export const STEM_ACTIVE_DB = 18;

export function stemActive(ai: AiAnalysis, stem: StemName, atMs: number, refDb?: number) {
  const ref = refDb ?? stemReferenceDb(ai, stem);
  return ref > -60 && stemLevelDb(ai, stem, atMs) >= ref - STEM_ACTIVE_DB;
}

/** First moment at/after `fromMs` the stem plays for at least `holdMs` (null if never). */
export function stemOnsetMs(
  ai: AiAnalysis,
  stem: StemName,
  fromMs: number,
  toMs: number,
  holdMs = 400,
): number | null {
  const ref = stemReferenceDb(ai, stem);
  const step = ai.stemCurves.stepMs;
  let run = 0;
  for (let t = Math.max(0, fromMs); t <= toMs; t += step) {
    run = stemActive(ai, stem, t, ref) ? run + step : 0;
    if (run >= holdMs) return t - run + step;
  }
  return null;
}

/** Last moment in [fromMs, toMs] the stem plays (null if silent throughout). */
export function stemLastActiveMs(ai: AiAnalysis, stem: StemName, fromMs: number, toMs: number) {
  const ref = stemReferenceDb(ai, stem);
  const step = ai.stemCurves.stepMs;
  for (let t = toMs; t >= fromMs; t -= step) if (stemActive(ai, stem, t, ref)) return t;
  return null;
}

/**
 * Constant-tempo grid fitted to the model's beats inside [fromMs, toMs]: least squares of beat
 * time against beat index, anchored on a model downbeat. Strength follows the timing residual,
 * on the same scale as the DSP grids (≥ 2.5 = usable for beat matching).
 */
export function gridFromBeats(ai: AiAnalysis, fromMs: number, toMs: number): BeatGrid | null {
  const beats = ai.beatsMs.filter((b) => b >= fromMs && b <= toMs);
  if (beats.length < 12) return null;
  const n = beats.length;
  const xs = beats.map((_, i) => i);
  const mx = (n - 1) / 2;
  const my = beats.reduce((s, b) => s + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i]! - mx) * (beats[i]! - my);
    sxx += (xs[i]! - mx) ** 2;
  }
  const period = sxy / sxx;
  if (!(period > 200 && period < 1500)) return null;
  const intercept = my - period * mx;
  const residual = Math.sqrt(
    beats.reduce((s, b, i) => s + (b - (intercept + period * i)) ** 2, 0) / n,
  );
  const downs = ai.downbeatsMs.filter((d) => d >= fromMs && d <= toMs);
  // Anchor on the downbeat that agrees best with the fitted line.
  let anchor = intercept;
  let best = Infinity;
  for (const d of downs) {
    const k = Math.round((d - intercept) / period);
    const off = Math.abs(d - (intercept + k * period));
    if (off < best) {
      best = off;
      anchor = intercept + k * period;
    }
  }
  const strength = Math.max(0, Math.min(6, 6 - residual / 5));
  return {
    periodMs: Math.round(period * 1000) / 1000,
    anchorMs: Math.round(anchor * 10) / 10,
    strength: Math.round(strength * 100) / 100,
  };
}

export function segmentAt(ai: AiAnalysis, atMs: number) {
  return ai.segments.find((s) => atMs >= s.startMs && atMs < s.endMs) ?? null;
}

/** The downbeat nearest to `atMs` (or `atMs` itself when the model found none near it). */
export function nearestDownbeat(ai: AiAnalysis, atMs: number, withinMs = 1500) {
  let best = atMs;
  let dist = withinMs;
  for (const d of ai.downbeatsMs) {
    const x = Math.abs(d - atMs);
    if (x < dist) {
      dist = x;
      best = d;
    }
  }
  return best;
}

/**
 * Phrase ends: section boundaries, plus every 8 bars counted from the start of each section
 * (on the model's downbeats). These are where a DJ would start a mix.
 */
export function phrasePoints(ai: AiAnalysis): number[] {
  const out = new Set<number>();
  const downs = ai.downbeatsMs;
  for (const seg of ai.segments) {
    if (seg.label === 'start' || seg.label === 'end') continue;
    const first = downs.findIndex((d) => d >= seg.startMs - 400);
    if (first < 0) continue;
    for (let k = first; k < downs.length && downs[k]! < seg.endMs - 400; k += 8) out.add(downs[k]!);
    out.add(nearestDownbeat(ai, seg.endMs));
  }
  return [...out].sort((a, b) => a - b);
}
