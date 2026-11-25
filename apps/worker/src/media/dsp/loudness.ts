import { kWeight } from './filters.js';

/**
 * BS.1770 loudness over arbitrary windows. Keeps a running sum of K-weighted power so any
 * window costs O(1); used for short-term/momentary curves and for the transition checks.
 */
export class LoudnessMeter {
  private readonly cum: Float64Array;
  readonly length: number;

  constructor(
    channels: Float32Array[],
    readonly sampleRate: number,
  ) {
    this.length = channels[0]?.length ?? 0;
    this.cum = new Float64Array(this.length + 1);
    const weighted = channels.map((c) => kWeight(c, sampleRate));
    let acc = 0;
    for (let i = 0; i < this.length; i++) {
      for (const w of weighted) acc += w[i]! * w[i]!;
      this.cum[i + 1] = acc;
    }
  }

  /** Loudness in LUFS of [fromSec, toSec); -Infinity-safe (returns -120 for silence). */
  lufs(fromSec: number, toSec: number): number {
    const a = Math.max(0, Math.min(this.length, Math.round(fromSec * this.sampleRate)));
    const b = Math.max(a, Math.min(this.length, Math.round(toSec * this.sampleRate)));
    if (b <= a) return -120;
    const ms = (this.cum[b]! - this.cum[a]!) / (b - a);
    return ms <= 1e-12 ? -120 : -0.691 + 10 * Math.log10(ms);
  }

  /** Loudness of trailing windows of `windowSec`, one value per `hopSec`, starting at t = hopSec. */
  curve(windowSec: number, hopSec: number, centered = false): number[] {
    const out: number[] = [];
    const dur = this.length / this.sampleRate;
    for (let t = 0; t <= dur + 1e-9; t += hopSec) {
      out.push(
        centered ? this.lufs(t - windowSec / 2, t + windowSec / 2) : this.lufs(t - windowSec, t),
      );
    }
    return out;
  }

  /** Gated integrated loudness (absolute −70, relative −10 LU), 400 ms blocks, 75% overlap. */
  integrated(): number {
    const blocks: number[] = [];
    const dur = this.length / this.sampleRate;
    for (let t = 0; t + 0.4 <= dur; t += 0.1) blocks.push(this.lufs(t, t + 0.4));
    const power = (l: number) => 10 ** ((l + 0.691) / 10);
    const mean = (xs: number[]) =>
      xs.length ? -0.691 + 10 * Math.log10(xs.reduce((s, l) => s + power(l), 0) / xs.length) : -120;
    const abs = blocks.filter((l) => l > -70);
    const rel = mean(abs) - 10;
    return mean(abs.filter((l) => l > rel));
  }
}
