import { describe, expect, it } from 'vitest';
import { aiAnalysisSchema, stemReferenceDb, type AiAnalysis } from './ai.js';
import { aiExitPoint, planAiTransition, vocalOverlapSeconds } from './ai-transitions.js';
import {
  DEFAULT_PLAN_OPTIONS,
  earliestMixMs,
  evalCurve,
  planTransition,
  transitionPlanSchema,
  type PlanTrack,
} from './transitions.js';

interface Shape {
  durMs: number;
  bpm: number;
  /** [startMs, endMs, label] */
  segments: [number, number, string][];
  /** Ranges where the vocal stem is loud. */
  vocals: [number, number][];
  drumsFromMs: number;
}

/** A track as analyze.py would describe it: steady beats, sections, a vocal stem curve. */
function aiTrack(shape: Partial<Shape> = {}): PlanTrack {
  const s: Shape = {
    durMs: 180_000,
    bpm: 120,
    segments: [
      [0, 15_000, 'intro'],
      [15_000, 150_000, 'verse'],
      [150_000, 176_000, 'outro'],
      [176_000, 180_000, 'end'],
    ],
    vocals: [[16_000, 148_000]],
    drumsFromMs: 0,
    ...shape,
  };
  const period = 60_000 / s.bpm;
  const beats: number[] = [];
  for (let t = 0; t < s.durMs; t += period) beats.push(Math.round(t));
  const step = 100;
  const n = Math.ceil(s.durMs / step);
  const curve = (on: (t: number) => boolean) =>
    Array.from({ length: n }, (_, i) => (on(i * step) ? -150 : -700));
  const ai: AiAnalysis = aiAnalysisSchema.parse({
    v: 1,
    models: { stems: 'htdemucs_ft', beats: 'beat_this:final0', structure: 'allin1:harmonix-all' },
    durationMs: s.durMs,
    bpm: s.bpm,
    beatsMs: beats,
    downbeatsMs: beats.filter((_, i) => i % 4 === 0),
    segments: s.segments.map(([startMs, endMs, label]) => ({ startMs, endMs, label })),
    stemCurves: {
      stepMs: step,
      drums: curve((t) => t >= s.drumsFromMs && t < s.durMs - 4000),
      bass: curve((t) => t < s.durMs - 4000),
      other: curve((t) => t < s.durMs - 4000),
      vocals: curve((t) => s.vocals.some(([a, b]) => t >= a && t < b)),
    },
    stemFiles: {
      drums: 'drums.flac',
      bass: 'bass.flac',
      other: 'other.flac',
      vocals: 'vocals.flac',
    },
  });
  return { cueInMs: 0, cueOutMs: s.durMs - 2000, ai };
}

const opts = { ...DEFAULT_PLAN_OPTIONS };

describe('AI exit point', () => {
  it('starts at the outro when the model found one', () => {
    const exit = aiExitPoint(aiTrack(), opts.maxSeconds);
    expect(exit?.atMs).toBe(150_000);
    expect(exit?.reason).toBe('start of the outro');
  });

  it('otherwise picks a phrase end on a downbeat, preferring one after the vocals', () => {
    const a = aiTrack({
      segments: [
        [0, 15_000, 'intro'],
        [15_000, 178_000, 'chorus'],
      ],
      vocals: [[16_000, 162_000]],
    });
    const exit = aiExitPoint(a, opts.maxSeconds)!;
    const downs = a.ai!.downbeatsMs;
    expect(downs).toContain(exit.atMs);
    expect(exit.atMs).toBeGreaterThanOrEqual(162_000 - 2000);
  });

  it('is the lock floor, independent of what plays next', () => {
    expect(earliestMixMs(aiTrack(), opts)).toBe(150_000);
  });
});

describe('AI plan', () => {
  it('beat-matches equal tempos from the exit point, on whole bars', () => {
    const a = aiTrack();
    const b = aiTrack({ bpm: 122 });
    const plan = planAiTransition(a, b, opts)!;
    transitionPlanSchema.parse(plan);
    expect(plan.style).toBe('beatmatch');
    expect(plan.aStartMs).toBe(150_000);
    expect(plan.sync!.beats % 4).toBe(0);
    expect(plan.stems).toBeTruthy();
  });

  it('never lets two vocals overlap, even when B sings right away', () => {
    const a = aiTrack({ vocals: [[16_000, 170_000]] });
    const b = aiTrack({ vocals: [[500, 150_000]] });
    const plan = planAiTransition(a, b, opts)!;
    expect(vocalOverlapSeconds(a, b, plan)).toBeLessThanOrEqual(0.5);
    // A's voice is down before B's comes up.
    const aOut = plan.stems!.a.vocals.find(([, g]) => g === 0)![0];
    const bIn = plan.stems!.b.vocals.find(([, g]) => g === 1)![0];
    expect(aOut).toBeLessThanOrEqual(bIn);
  });

  it("brings B's instrumental in before its vocals and its drums first when beat-matched", () => {
    const a = aiTrack();
    const b = aiTrack({ vocals: [[12_000, 150_000]] });
    const plan = planAiTransition(a, b, opts)!;
    const u = 0.3;
    expect(evalCurve(plan.stems!.b.drums, u)).toBeGreaterThan(0.9);
    expect(evalCurve(plan.stems!.b.base, u)).toBeGreaterThan(evalCurve(plan.stems!.b.vocals, u));
  });

  it('swaps the basslines within a beat, on a downbeat', () => {
    const plan = planAiTransition(aiTrack(), aiTrack(), opts)!;
    const swapA = plan.stems!.a.bass[2]![0];
    const swapB = plan.stems!.b.bass[2]![0];
    expect(swapA).toBe(swapB);
    expect((swapA * plan.sync!.beats) % 4).toBeCloseTo(0, 6);
  });

  it('blends without beat matching when the tempos are far apart', () => {
    const plan = planAiTransition(aiTrack({ bpm: 120 }), aiTrack({ bpm: 92 }), opts)!;
    expect(plan.sync).toBeNull();
    expect(plan.reasons.join(' ')).toMatch(/tempos too far apart/);
  });

  it('is what planTransition uses in auto mode, and not in the other modes', () => {
    const a = aiTrack();
    const b = aiTrack();
    expect(planTransition(a, b).stems).toBeTruthy();
    expect(planTransition(a, b, { mode: 'simple' }).stems).toBeFalsy();
    expect(planTransition({ ...a, ai: null }, b).stems).toBeFalsy();
  });
});

describe('edge-only analysis (opening and last minute separated)', () => {
  const edges = (t: PlanTrack, headMs: number, tailMs: number): PlanTrack => ({
    ...t,
    ai: {
      ...t.ai!,
      analysedMs: [
        [0, headMs],
        [t.ai!.durationMs - tailMs, t.ai!.durationMs],
      ],
    },
  });

  it('keeps the exit and its lead-in inside the separated ending', () => {
    const a = edges(aiTrack(), 45_000, 55_000);
    const exit = aiExitPoint(a, opts.maxSeconds)!;
    expect(exit.atMs - 4000).toBeGreaterThanOrEqual(180_000 - 55_000);
    expect(exit.reason).toBe('start of the outro');
  });

  it("keeps B's overlap and lead-out inside its separated opening", () => {
    const b = edges(aiTrack(), 45_000, 55_000);
    for (const maxSeconds of [20, 32]) {
      const plan = planAiTransition(edges(aiTrack(), 45_000, 55_000), b, { ...opts, maxSeconds })!;
      expect(plan).not.toBeNull();
      expect(plan.bEndMs + 14_500).toBeLessThanOrEqual(45_000);
    }
  });

  it('falls back to the DSP planner when nothing fits', () => {
    const late = { ...edges(aiTrack(), 45_000, 55_000), cueInMs: 40_000 };
    expect(planAiTransition(edges(aiTrack(), 45_000, 55_000), late, opts)).toBeNull();
  });

  it('measures the reference vocal level only where it was separated', () => {
    const t = edges(
      aiTrack({
        vocals: [
          [40_000, 45_000],
          [175_000, 177_000],
        ],
      }),
      45_000,
      55_000,
    );
    // Vocals are loud in 7% of the separated parts but under 5% of the whole curve once
    // the silent middle counts: the reference must still be the loud level.
    expect(stemReferenceDb(t.ai!, 'vocals')).toBe(-15);
  });
});
