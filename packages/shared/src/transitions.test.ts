import { describe, expect, it } from 'vitest';
import { trackFeaturesSchema } from './features.js';
import {
  earliestMixMs,
  flowScore,
  orderForFlow,
  planAirtimeMs,
  planTransition,
  transitionPlanSchema,
  type PlanOptions,
  type PlanTrack,
} from './transitions.js';

const INTROS = ['cold', 'fade-in', 'soft'] as const;
const OUTROS = ['hard', 'fade', 'tail', 'soft'] as const;

interface Shape {
  bpm: number;
  dur: number;
  camelot: string;
  energy: number;
  intro: (typeof INTROS)[number];
  introMs: number;
  outro: (typeof OUTROS)[number];
  outroMs: number;
  /** How long before the cue-out the last loud moment is. */
  dropBeforeEndMs: number;
  vocal: boolean;
}

/** A track as the worker would describe it: steady beat, an intro and an outro of the given kind. */
function track(shape: Partial<Shape> = {}): PlanTrack {
  const s: Shape = {
    bpm: 120,
    dur: 180_000,
    camelot: '8A',
    energy: 0.6,
    intro: 'cold',
    introMs: 8000,
    outro: 'hard',
    outroMs: 12_000,
    dropBeforeEndMs: 200,
    vocal: false,
    ...shape,
  };
  const step = 500;
  const n = Math.ceil(s.dur / step);
  const introEnd = s.intro === 'cold' ? 200 : s.introMs;
  const outroStart = s.outro === 'hard' ? s.dur - 200 : s.dur - s.outroMs;
  const grid = { periodMs: 60_000 / s.bpm, anchorMs: 500, strength: 4 };
  return {
    cueInMs: 200,
    cueOutMs: s.dur,
    crossfadeDurationMs: 4000,
    features: trackFeaturesSchema.parse({
      v: 1,
      bpm: s.bpm,
      grid,
      headGrid: grid,
      tailGrid: grid,
      downbeatConfidence: 0.8,
      phraseOffsetBars: 0,
      beatStartMs: 500,
      beatEndMs: s.outro === 'hard' ? s.dur - 500 : outroStart,
      key: { tonic: 9, mode: 'minor', camelot: s.camelot, confidence: 0.8 },
      energy: s.energy,
      intro: { type: s.intro, endMs: introEnd, levelLu: s.intro === 'cold' ? 0 : -8 },
      outro: {
        type: s.outro,
        startMs: outroStart,
        fadeStartMs: outroStart,
        dropMs: s.dur - s.dropBeforeEndMs,
        levelLu: s.outro === 'hard' ? 0 : -10,
      },
      curveStepMs: step,
      loudness: Array.from({ length: n }, (_, i) =>
        i * step < introEnd && s.intro !== 'cold' ? -80 : i * step > outroStart ? -100 : 0,
      ),
      vocal: Array.from({ length: n }, () => (s.vocal ? 80 : 5)),
      vocalInMs: s.vocal ? 200 : null,
      vocalOutMs: s.vocal ? s.dur : null,
    }),
  };
}

describe('planTransition', () => {
  it('keeps every plan inside the limits, whatever the two tracks look like', () => {
    const optionSets: Partial<PlanOptions>[] = [
      {},
      { mode: 'smooth' },
      { mode: 'quick' },
      { maxSeconds: 8 },
      { maxSeconds: 32, lengthScale: 1.5 },
      { beatmatch: false, bassSwap: false },
    ];
    let plans = 0;
    for (const options of optionSets)
      for (const outro of OUTROS)
        for (const intro of INTROS)
          for (const bpm of [120, 123, 140, 60])
            for (const dur of [180_000, 58_000])
              for (const extra of [
                {},
                { introMs: 18_000 },
                { dropBeforeEndMs: 9000, outroMs: 25_000 },
              ]) {
                const a = track({ outro, dur, vocal: true, ...extra });
                const b = track({ intro, bpm, camelot: '9A', vocal: true, ...extra });
                const plan = planTransition(a, b, options);
                const where = JSON.stringify({ options, outro, intro, bpm, dur, extra });
                expect(transitionPlanSchema.safeParse(plan).success, where).toBe(true);
                // Voting closes just before this point: the mix may not begin earlier.
                expect(plan.aStartMs, where).toBeGreaterThanOrEqual(earliestMixMs(a, options));
                expect(plan.aEndMs - plan.aStartMs, where).toBeGreaterThan(0);
                expect(plan.bEndMs, where).toBeGreaterThan(plan.bStartMs);
                // One bar of slack: beat-matched plans are rounded to whole phrases.
                expect(plan.overlapMs, where).toBeLessThanOrEqual(
                  (options.maxSeconds ?? 20) * 1000 + 2000,
                );
                const air = planAirtimeMs(a, b, plan);
                expect(air, where).toBeGreaterThan(0);
                expect(air, where).toBeLessThanOrEqual(a.cueOutMs - a.cueInMs + 1000);
                plans++;
              }
    expect(plans).toBeGreaterThan(800);
  });

  it('beat-matches a hard ending into a cold start at the same tempo', () => {
    const plan = planTransition(track(), track({ bpm: 122, camelot: '9A' }));
    expect(plan.style).toBe('beatmatch');
    expect(plan.sync?.beats).toBe(16);
    // A's side ends on its last downbeat, a whole number of its own beats after it started.
    expect(plan.aEndMs - plan.aStartMs).toBeCloseTo(16 * 500, 3);
  });

  it('counts half and double time as the same tempo', () => {
    expect(planTransition(track(), track({ bpm: 60 })).sync).not.toBeNull();
    expect(planTransition(track({ bpm: 70 }), track({ bpm: 140 })).sync).not.toBeNull();
  });

  it('cuts instead of mixing when the tempos or keys do not fit', () => {
    expect(planTransition(track(), track({ bpm: 140 })).style).toBe('cut');
    expect(planTransition(track(), track({ camelot: '2B' })).style).toBe('cut');
    expect(planTransition(track(), track({ bpm: 122 }), { beatmatch: false }).sync).toBeNull();
  });

  it('crossfades over a fade-out without warping either track', () => {
    const plan = planTransition(track({ outro: 'fade' }), track());
    expect(plan.style).toBe('smooth');
    expect(plan.sync).toBeNull();
    expect(plan.aEndMs).toBe(180_000);
  });

  it('falls back to the plain crossfade without analysis or when the admin asks for it', () => {
    const bare: PlanTrack = { cueInMs: 0, cueOutMs: 120_000, crossfadeDurationMs: 3000 };
    for (const plan of [
      planTransition(bare, track()),
      planTransition(track(), track(), { mode: 'simple' }),
    ]) {
      expect(plan.sync).toBeNull();
      expect(plan.a.low).toEqual(plan.a.high);
      expect(transitionPlanSchema.safeParse(plan).success).toBe(true);
    }
  });

  it('shortens the mix, then ducks A, rather than let two vocals run over each other', () => {
    const quiet = planTransition(track(), track({ bpm: 122 }));
    const sung = planTransition(track({ vocal: true }), track({ bpm: 122, vocal: true }));
    expect(sung.overlapMs).toBeLessThan(quiet.overlapMs);
    expect(sung.reasons.join(' ')).toMatch(/vocals/);
  });
});

describe('orderForFlow', () => {
  const current = track();
  const fits = () => ({ ...track({ bpm: 121 }), waitedMs: 0 });
  const clashes = () => ({ ...track({ bpm: 97, camelot: '2B', energy: 0.1 }), waitedMs: 0 });

  it('prefers the better follow-up among the longest-waiting tracks', () => {
    expect(flowScore(current, fits())).toBeGreaterThan(flowScore(current, clashes()));
    const a = { ...clashes(), waitedMs: 600_000 };
    const b = { ...fits(), waitedMs: 590_000 };
    expect(orderForFlow(current, [a, b])[0]).toBe(b);
  });

  it('starts with the longest-waiting track when nothing is on air', () => {
    const rows = [clashes(), fits(), clashes()];
    const ordered = orderForFlow(null, rows);
    expect(ordered[0]).toBe(rows[0]);
    expect(new Set(ordered)).toEqual(new Set(rows));
  });

  it('does not pass over a track for one that has waited much less', () => {
    const a = { ...clashes(), waitedMs: 600_000 };
    const b = { ...fits(), waitedMs: 200_000 };
    expect(orderForFlow(current, [a, b])[0]).toBe(a);
    const never = { ...clashes(), waitedMs: Infinity };
    expect(orderForFlow(current, [never, b])[0]).toBe(never);
  });

  it('gets every track of a small library on air (no two songs alternating forever)', () => {
    // Three tracks; one of them follows neither of the others well.
    const library = [
      { id: 'odd', plan: track({ bpm: 97, camelot: '2B', energy: 0.1, dur: 60_000 }) },
      { id: 'x', plan: track({ bpm: 120, dur: 60_000 }) },
      { id: 'y', plan: track({ bpm: 121, dur: 60_000 }) },
    ];
    const lastPlayed = new Map([
      ['odd', -3],
      ['x', -2],
      ['y', -1],
    ]);
    let onAir = library[2]!;
    const aired: string[] = [];
    for (let turn = 0; turn < 12; turn++) {
      const rows = library
        .filter((t) => t.id !== onAir.id)
        .sort((p, q) => lastPlayed.get(p.id)! - lastPlayed.get(q.id)!)
        .map((t) => ({ ...t.plan, id: t.id, waitedMs: (turn - lastPlayed.get(t.id)!) * 60_000 }));
      const next = orderForFlow(onAir.plan, rows)[0]!;
      lastPlayed.set(next.id, turn);
      aired.push(next.id);
      onAir = library.find((t) => t.id === next.id)!;
    }
    expect(aired.filter((id) => id === 'odd').length).toBeGreaterThanOrEqual(3);
  });
});
