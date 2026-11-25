/**
 * Synthetic drum loops for tests: a kick on every beat, a snare on 2 and 4, hats on the eighths
 * and a bass note per bar. Deterministic, perfectly quantised, with a hard ending.
 */
export function drumLoop(opts: {
  bpm: number;
  seconds: number;
  sampleRate: number;
  /** Bass note frequency (sets the "key"). */
  bassHz?: number;
  /** Seconds of quiet pad before the drums come in. */
  introSeconds?: number;
  /** Seconds of linear fade-out at the end (0 = hard ending). */
  fadeSeconds?: number;
}): [Float32Array, Float32Array] {
  const { bpm, seconds, sampleRate: sr } = opts;
  const n = Math.round(seconds * sr);
  const out = new Float32Array(n);
  const beat = (60 / bpm) * sr;
  const intro = Math.round((opts.introSeconds ?? 0) * sr);
  let seed = 12345;
  const noise = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2147483648 - 1;
  };
  const bass = opts.bassHz ?? 55;
  for (let k = 0; k * beat < n; k++) {
    const start = Math.round(k * beat);
    if (start < intro) continue;
    // Kick: a thump dropping from ~130 Hz to 50 Hz.
    for (let i = 0; i < 0.18 * sr && start + i < n; i++) {
      const t = i / sr;
      out[start + i]! +=
        0.8 * Math.sin(2 * Math.PI * (50 * t + 2 * (1 - Math.exp(-t * 40)))) * Math.exp(-t * 18);
    }
    if (k % 2 === 1) {
      for (let i = 0; i < 0.12 * sr && start + i < n; i++)
        out[start + i]! += 0.35 * noise() * Math.exp(-i / (0.03 * sr));
    }
    for (const frac of [0, 0.5]) {
      const h = Math.round(start + frac * beat);
      for (let i = 0; i < 0.03 * sr && h + i < n; i++)
        out[h + i]! += 0.12 * noise() * Math.exp(-i / (0.006 * sr));
    }
  }
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const bar = Math.floor(i / (4 * beat));
    const f = bass * [1, 1, 1.5, 1.335][bar % 4]!;
    const level = i < intro ? 0.06 : 0.22;
    out[i]! +=
      level * Math.sin(2 * Math.PI * f * t) + (level / 2) * Math.sin(2 * Math.PI * f * 4 * t);
  }
  const fade = Math.round((opts.fadeSeconds ?? 0) * sr);
  for (let i = 0; i < fade; i++) out[n - 1 - i]! *= i / fade;
  return [out, Float32Array.from(out)];
}

/** Linear-interpolating resample, good enough for feeding the analysis in tests. */
export function resample(x: Float32Array, from: number, to: number): Float32Array {
  const n = Math.floor((x.length * to) / from);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = (i * from) / to;
    const k = Math.floor(p);
    out[i] = x[k]! + ((x[k + 1] ?? x[k]!) - x[k]!) * (p - k);
  }
  return out;
}
