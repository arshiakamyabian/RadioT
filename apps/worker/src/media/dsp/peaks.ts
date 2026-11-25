const OVERSAMPLE = 4;
const TAPS_PER_PHASE = 12;

// Windowed-sinc polyphase interpolator (4×), used to estimate inter-sample ("true") peaks.
const PHASES: Float64Array[] = (() => {
  const total = OVERSAMPLE * TAPS_PER_PHASE;
  const centre = (total - 1) / 2;
  const proto = new Float64Array(total);
  for (let i = 0; i < total; i++) {
    const x = (i - centre) / OVERSAMPLE;
    const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / total);
    proto[i] = sinc * w;
  }
  return Array.from({ length: OVERSAMPLE }, (_, p) => {
    const taps = new Float64Array(TAPS_PER_PHASE);
    let sum = 0;
    for (let t = 0; t < TAPS_PER_PHASE; t++) {
      taps[t] = proto[t * OVERSAMPLE + p]!;
      sum += taps[t]!;
    }
    for (let t = 0; t < TAPS_PER_PHASE; t++) taps[t] = taps[t]! / sum;
    return taps;
  });
})();

/** Per-sample true-peak magnitude: the largest of the 4× interpolated values around each sample. */
export function truePeakEnvelope(channels: Float32Array[]): Float32Array {
  const n = channels[0]?.length ?? 0;
  const env = new Float32Array(n);
  const half = TAPS_PER_PHASE / 2;
  for (const x of channels) {
    for (let i = 0; i < n; i++) {
      let peak = Math.abs(x[i]!);
      // Cheap skip: interpolation overshoot is bounded, so quiet samples cannot become peaks.
      if (peak > 0.25) {
        for (let p = 0; p < OVERSAMPLE; p++) {
          const taps = PHASES[p]!;
          let acc = 0;
          for (let t = 0; t < TAPS_PER_PHASE; t++) {
            const j = i + half - t;
            if (j >= 0 && j < n) acc += taps[t]! * x[j]!;
          }
          const a = Math.abs(acc);
          if (a > peak) peak = a;
        }
      }
      if (peak > env[i]!) env[i] = peak;
    }
  }
  return env;
}

export function truePeakDb(channels: Float32Array[]): number {
  const env = truePeakEnvelope(channels);
  let peak = 0;
  for (let i = 0; i < env.length; i++) if (env[i]! > peak) peak = env[i]!;
  return peak <= 0 ? -120 : 20 * Math.log10(peak);
}

/**
 * Look-ahead true-peak limiter (offline, zero latency). The gain dips just before each peak and
 * recovers smoothly after it, so nothing exceeds `ceilingDb` dBTP and the level stays untouched
 * wherever the signal is already below the ceiling. Returns the largest reduction applied (dB).
 */
export function limitTruePeak(
  channels: Float32Array[],
  sampleRate: number,
  ceilingDb: number,
  opts: { lookaheadMs?: number; releaseMs?: number } = {},
): number {
  const n = channels[0]?.length ?? 0;
  const ceiling = 10 ** (ceilingDb / 20);
  const look = Math.max(1, Math.round(((opts.lookaheadMs ?? 4) / 1000) * sampleRate));
  const releaseCoef = Math.exp(-1 / (((opts.releaseMs ?? 120) / 1000) * sampleRate));
  let worst = 1;

  for (let pass = 0; pass < 3; pass++) {
    const env = truePeakEnvelope(channels);
    let over = false;
    const gain = new Float32Array(n);
    // Required gain, with an exponential release back towards unity.
    let g = 1;
    for (let i = 0; i < n; i++) {
      const need = env[i]! > ceiling ? ceiling / env[i]! : 1;
      g = Math.min(need, 1 - (1 - g) * releaseCoef);
      gain[i] = g;
      if (need < 1) over = true;
    }
    if (!over) break;
    // Hold the minimum over a centred window (the look-ahead), then smooth it: the smoothed
    // curve never rises above what any sample inside the window needs.
    const held = slidingMin(gain, look);
    const smooth = movingAverage(held, look);
    for (let i = 0; i < n; i++) {
      const s = smooth[i]!;
      if (s < worst) worst = s;
      if (s < 1) for (const c of channels) c[i] = c[i]! * s;
    }
  }
  return worst >= 1 ? 0 : -20 * Math.log10(worst);
}

/** Minimum over the centred window [i − w, i + w]. */
function slidingMin(x: Float32Array, w: number): Float32Array {
  const n = x.length;
  const out = new Float32Array(n);
  const dq = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < n + w; i++) {
    if (i < n) {
      while (tail > head && x[dq[tail - 1]!]! >= x[i]!) tail--;
      dq[tail++] = i;
    }
    const centre = i - w;
    if (centre < 0) continue;
    while (dq[head]! < centre - w) head++;
    out[centre] = x[dq[head]!]!;
  }
  return out;
}

/** Mean over the centred window [i − w, i + w] (edges use the samples that exist). */
function movingAverage(x: Float32Array, w: number): Float32Array {
  const n = x.length;
  const out = new Float32Array(n);
  let acc = 0;
  let count = 0;
  for (let i = 0; i < n + w; i++) {
    if (i < n) {
      acc += x[i]!;
      count++;
    }
    const drop = i - 2 * w - 1;
    if (drop >= 0 && drop < n) {
      acc -= x[drop]!;
      count--;
    }
    const centre = i - w;
    if (centre >= 0) out[centre] = acc / count;
  }
  return out;
}
