import { describe, expect, it } from 'vitest';
import {
  planTransition,
  type Curve,
  type TrackAnalysis,
  type TransitionPlan,
} from '@radiot/shared';
import { computeGain } from './analysis.js';
import { truePeakDb } from './dsp/peaks.js';
import { ANALYSIS_RATE, analyzeTrack } from './features.js';
import {
  MIXED_STEMS,
  RENDER_RATE,
  renderTransition,
  type Decode,
  type DecodeStems,
} from './render.js';
import { drumLoop, resample } from './testing/synth.js';

/** A synthetic track plus fake "stems" (fixed fractions of it, plus noise that cancels out). */
function track(bpm: number, seconds: number) {
  const pcm = drumLoop({ bpm, seconds, sampleRate: RENDER_RATE, bassHz: 55 });
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
  const slice = (x: Float32Array, fromSec: number, durationSec: number) => {
    const a = Math.max(0, Math.round(fromSec * RENDER_RATE));
    return x.slice(a, Math.min(x.length, a + Math.round(durationSec * RENDER_RATE)));
  };
  const decode: Decode = async (f, d) => ({
    channels: [slice(pcm[0], f, d), slice(pcm[1], f, d)],
    sampleRate: RENDER_RATE,
  });
  const stems: DecodeStems = async (f, d) => {
    const out = {} as Awaited<ReturnType<DecodeStems>>;
    MIXED_STEMS.forEach((s, k) => {
      const ch = [slice(pcm[0], f, d), slice(pcm[1], f, d)].map((c) => {
        for (let i = 0; i < c.length; i++)
          c[i] = c[i]! * (0.2 + 0.1 * k) + Math.sin(i * (k + 1)) * 0.01;
        return c;
      });
      out[s] = { channels: ch as [Float32Array, Float32Array], sampleRate: RENDER_RATE };
    });
    return out;
  };
  return { analysis, decode, stems };
}

const maxDiff = (x: Float32Array[], y: Float32Array[]) => {
  let m = 0;
  for (let c = 0; c < 2; c++)
    for (let i = 0; i < Math.min(x[c]!.length, y[c]!.length); i++)
      m = Math.max(m, Math.abs(x[c]![i]! - y[c]![i]!));
  return m;
};

describe('stem-aware rendering', () => {
  const a = track(124, 50);
  const b = track(126, 50);
  const base = planTransition(a.analysis, b.analysis);
  const curve = base.a.mid;
  const bCurve = base.b.mid;
  const flatBands = (c: Curve) => ({ low: c, mid: c, high: c });

  it('equals the plain render when every stem follows the base curve (beat-matched too)', async () => {
    expect(base.sync).not.toBeNull();
    const plan: TransitionPlan = {
      ...base,
      a: flatBands(curve),
      b: flatBands(bCurve),
      stems: {
        a: { base: curve, drums: curve, bass: curve, vocals: curve },
        b: { base: bCurve, drums: bCurve, bass: bCurve, vocals: bCurve },
      },
    };
    const opts = { leveler: false, ceilingDb: null };
    const plain = await renderTransition(
      a.decode,
      b.decode,
      a.analysis,
      b.analysis,
      { ...plan, stems: null },
      opts,
    );
    const stemmed = await renderTransition(a.decode, b.decode, a.analysis, b.analysis, plan, opts, {
      a: a.stems,
      b: b.stems,
    });
    // Band splitting with identical band curves is exact up to float rounding.
    expect(maxDiff(plain.channels, stemmed.channels)).toBeLessThan(1e-4);
  });

  it('turns one stem down on its own and leaves the lead-in untouched', async () => {
    const silentVocals: Curve = [
      [0, 0],
      [1, 0],
    ];
    const plan: TransitionPlan = {
      ...base,
      a: flatBands(curve),
      b: flatBands(bCurve),
      stems: {
        a: { base: curve, drums: curve, bass: curve, vocals: silentVocals },
        b: { base: bCurve, drums: bCurve, bass: bCurve, vocals: bCurve },
      },
    };
    const opts = { leveler: false, ceilingDb: null };
    const plain = await renderTransition(
      a.decode,
      b.decode,
      a.analysis,
      b.analysis,
      { ...plan, stems: null },
      opts,
    );
    const stemmed = await renderTransition(a.decode, b.decode, a.analysis, b.analysis, plan, opts, {
      a: a.stems,
      b: b.stems,
    });
    const L = Math.round((stemmed.leadInMs / 1000) * RENDER_RATE);
    const lead = (x: Float32Array[]) => x.map((c) => c.subarray(0, L - 64));
    expect(maxDiff(lead(plain.channels), lead(stemmed.channels))).toBe(0);
    // Inside the overlap A's "vocals" (40% of A here) are gone, so the mix differs.
    expect(maxDiff(plain.channels, stemmed.channels)).toBeGreaterThan(0.01);
  });
});
