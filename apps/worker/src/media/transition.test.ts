import { describe, expect, it } from 'vitest';
import { planTransition, type TrackAnalysis } from '@radiot/shared';
import { computeGain } from './analysis.js';
import { LoudnessMeter } from './dsp/loudness.js';
import { limitTruePeak, truePeakDb } from './dsp/peaks.js';
import { warp } from './dsp/wsola.js';
import { ANALYSIS_RATE, analyzeTrack } from './features.js';
import { RENDER_RATE, renderTransition, type Decode } from './render.js';
import { drumLoop, resample } from './testing/synth.js';

function track(opts: Parameters<typeof drumLoop>[0]) {
  const pcm = drumLoop({ ...opts, sampleRate: RENDER_RATE });
  const small = resample(pcm[0], RENDER_RATE, ANALYSIS_RATE);
  const deep = analyzeTrack({ left: small, right: small });
  const tp = truePeakDb(pcm);
  const analysis: TrackAnalysis = {
    durationMs: deep.durationMs,
    lufs: deep.lufs,
    truePeak: tp,
    gainDb: computeGain(deep.lufs, tp, -14),
    cueInMs: deep.cueInMs,
    cueOutMs: deep.cueOutMs,
    crossfadeStartMs: deep.cueOutMs - 5000,
    crossfadeDurationMs: 5000,
    features: deep.features,
  };
  const decode: Decode = async (fromSec, durationSec) => {
    const a = Math.max(0, Math.round(fromSec * RENDER_RATE));
    const b = Math.min(pcm[0].length, a + Math.round(durationSec * RENDER_RATE));
    return { channels: [pcm[0].slice(a, b), pcm[1].slice(a, b)], sampleRate: RENDER_RATE };
  };
  return { analysis, decode, deep };
}

describe('track analysis', () => {
  const t = track({ bpm: 124, seconds: 60, sampleRate: RENDER_RATE, bassHz: 55 });

  it('finds the tempo and a tight beat grid', () => {
    expect(t.deep.features.bpm).toBeCloseTo(124, 1);
    const grid = t.deep.features.grid!;
    // Beats of the synthetic loop are at multiples of the beat length from 0.
    const beat = 60_000 / 124;
    const phase = ((grid.anchorMs % beat) + beat) % beat;
    expect(Math.min(phase, beat - phase)).toBeLessThan(6);
  });

  it('classifies a hard ending and a cold start', () => {
    expect(t.deep.features.outro.type).toBe('hard');
    expect(t.deep.features.intro.type).toBe('cold');
  });

  it('classifies a fade-out', () => {
    const faded = track({ bpm: 100, seconds: 50, sampleRate: RENDER_RATE, fadeSeconds: 9 });
    expect(faded.deep.features.outro.type).toBe('fade');
  });

  it('detects the key from the bass line', () => {
    expect(t.deep.features.key?.tonic).toBe(9); // A
  });
});

describe('dsp', () => {
  it('measures loudness like BS.1770 (a -20 dBFS 1 kHz stereo sine is about -20 LUFS)', () => {
    const n = RENDER_RATE * 5;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = 0.1 * Math.sin((2 * Math.PI * 997 * i) / RENDER_RATE);
    // Two channels at -23 LUFS each sum to -20 LUFS.
    expect(new LoudnessMeter([x, x], RENDER_RATE).integrated()).toBeCloseTo(-20, 0);
  });

  it('time-warp leaves unwarped audio bit-identical', () => {
    const [x] = drumLoop({ bpm: 120, seconds: 3, sampleRate: RENDER_RATE });
    const [y] = warp([x], (n) => n, x.length, RENDER_RATE);
    let worst = 0;
    for (let i = 2000; i < x.length - 2000; i++) worst = Math.max(worst, Math.abs(x[i]! - y![i]!));
    expect(worst).toBeLessThan(1e-6);
  });

  it('limiter keeps the true peak under the ceiling', () => {
    const pcm = drumLoop({ bpm: 120, seconds: 4, sampleRate: RENDER_RATE });
    for (const c of pcm) for (let i = 0; i < c.length; i++) c[i] = c[i]! * 2.5;
    expect(truePeakDb(pcm)).toBeGreaterThan(0);
    limitTruePeak(pcm, RENDER_RATE, -1);
    expect(truePeakDb(pcm)).toBeLessThanOrEqual(-0.9);
  });
});

describe('beat-matched transition', () => {
  it('mixes two tempos 4% apart with the beats locked together', async () => {
    const a = track({ bpm: 120, seconds: 70, sampleRate: RENDER_RATE, bassHz: 55 });
    const b = track({ bpm: 125, seconds: 70, sampleRate: RENDER_RATE, bassHz: 82.41 });
    const plan = planTransition(a.analysis, b.analysis);
    expect(plan.style).toBe('beatmatch');
    expect(plan.sync).not.toBeNull();
    const out = await renderTransition(a.decode, b.decode, a.analysis, b.analysis, plan);
    expect(out.metrics.beatErrorMs!.beats).toBeGreaterThan(8);
    expect(out.metrics.beatErrorMs!.median).toBeLessThan(8);
    expect(out.metrics.truePeakDb).toBeLessThanOrEqual(-0.9);
    expect(out.metrics.loudnessExcursionLu).toBeLessThan(1);
    expect(out.metrics.quietestDb).toBeGreaterThan(-45);
  }, 60_000);

  it('does not beat-match tempos 12% apart', () => {
    const a = track({ bpm: 120, seconds: 60, sampleRate: RENDER_RATE });
    const b = track({ bpm: 135, seconds: 60, sampleRate: RENDER_RATE });
    expect(planTransition(a.analysis, b.analysis).sync).toBeNull();
  });
});
