import { describe, expect, it } from 'vitest';
import {
  computeCues,
  computeGain,
  fingerprintSimilarity,
  parseEbur128,
  rmsEnvelope,
} from './analysis.js';

const windows = (spec: [number, number][]) => spec.flatMap(([db, ms]) => Array(ms / 50).fill(db));

describe('computeGain', () => {
  it('moves loudness to target', () => {
    expect(computeGain(-20, -10, -14)).toBe(6);
    expect(computeGain(-10, -6, -14)).toBe(-4);
  });
  it('never pushes true peak above -1.5 dBTP', () => {
    expect(computeGain(-20, -3, -14)).toBe(1.5);
  });
});

describe('computeCues', () => {
  it('trims leading and trailing silence', () => {
    const env = windows([
      [-90, 1000],
      [-12, 30000],
      [-90, 2000],
    ]);
    const c = computeCues(env, 33000);
    expect(c.cueInMs).toBe(1000);
    expect(c.cueOutMs).toBe(31000);
  });

  it('starts the crossfade where a fade-out begins', () => {
    const env = windows([
      [-12, 40000],
      [-24, 6000], // a soft outro, > 6 dB below the loud body
      [-90, 1000],
    ]);
    const c = computeCues(env, 47000);
    expect(c.cueOutMs).toBe(46000);
    expect(c.crossfadeStartMs).toBeGreaterThanOrEqual(39000);
    expect(c.crossfadeStartMs).toBeLessThanOrEqual(40000);
    expect(c.crossfadeDurationMs).toBe(c.cueOutMs - c.crossfadeStartMs);
  });

  it('clamps the crossfade to 2-10 s', () => {
    const hardEnd = computeCues(windows([[-12, 30000]]), 30000);
    expect(hardEnd.crossfadeDurationMs).toBe(2000);
    const longTail = computeCues(
      windows([
        [-12, 30000],
        [-30, 25000],
      ]),
      55000,
    );
    expect(longTail.crossfadeDurationMs).toBe(10000);
  });

  it('handles all-silent input without throwing', () => {
    const c = computeCues(windows([[-120, 5000]]), 5000);
    expect(c.cueInMs).toBe(0);
    expect(c.cueOutMs).toBe(5000);
  });
});

describe('rmsEnvelope', () => {
  it('reports -3 dBFS for a full-scale sine', () => {
    const sr = 8000;
    const s = Float32Array.from({ length: sr }, (_, i) => Math.sin((2 * Math.PI * 440 * i) / sr));
    const env = rmsEnvelope(s, sr);
    expect(env).toHaveLength(20);
    expect(env[5]).toBeCloseTo(-3.01, 1);
  });
});

describe('parseEbur128', () => {
  it('reads integrated loudness and true peak from the summary', () => {
    const stderr = `[Parsed_ebur128_0 @ 0x1] Summary:

  Integrated loudness:
    I:         -17.7 LUFS
    Threshold: -28.1 LUFS

  True peak:
    Peak:       -9.7 dBFS`;
    expect(parseEbur128(stderr)).toEqual({ lufs: -17.7, truePeak: -9.7 });
  });
});

describe('fingerprintSimilarity', () => {
  const fp = Array.from({ length: 200 }, (_, i) => (i * 2654435761) | 0);
  it('scores identical and shifted fingerprints as matches', () => {
    expect(fingerprintSimilarity(fp, fp)).toBe(1);
    expect(fingerprintSimilarity(fp, fp.slice(30))).toBe(1);
  });
  it('scores unrelated fingerprints near 0.5', () => {
    const other = Array.from({ length: 200 }, (_, i) => ((i * 40503 + 977) * 2246822519) | 0);
    expect(fingerprintSimilarity(fp, other)).toBeLessThan(0.7);
  });
});
