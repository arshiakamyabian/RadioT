/** Direct-form-I biquad, coefficients normalised so a0 = 1. */
export interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

export function lowpass(fc: number, q: number, sr: number): Biquad {
  const w = (2 * Math.PI * fc) / sr;
  const alpha = Math.sin(w) / (2 * q);
  const c = Math.cos(w);
  const a0 = 1 + alpha;
  return {
    b0: (1 - c) / 2 / a0,
    b1: (1 - c) / a0,
    b2: (1 - c) / 2 / a0,
    a1: (-2 * c) / a0,
    a2: (1 - alpha) / a0,
  };
}

export function highpass(fc: number, q: number, sr: number): Biquad {
  const w = (2 * Math.PI * fc) / sr;
  const alpha = Math.sin(w) / (2 * q);
  const c = Math.cos(w);
  const a0 = 1 + alpha;
  return {
    b0: (1 + c) / 2 / a0,
    b1: -(1 + c) / a0,
    b2: (1 + c) / 2 / a0,
    a1: (-2 * c) / a0,
    a2: (1 - alpha) / a0,
  };
}

export function highShelf(fc: number, gainDb: number, q: number, sr: number): Biquad {
  const A = 10 ** (gainDb / 40);
  const w = (2 * Math.PI * fc) / sr;
  const alpha = Math.sin(w) / (2 * q);
  const c = Math.cos(w);
  const s = 2 * Math.sqrt(A) * alpha;
  const a0 = A + 1 - (A - 1) * c + s;
  return {
    b0: (A * (A + 1 + (A - 1) * c + s)) / a0,
    b1: (-2 * A * (A - 1 + (A + 1) * c)) / a0,
    b2: (A * (A + 1 + (A - 1) * c - s)) / a0,
    a1: (2 * (A - 1 - (A + 1) * c)) / a0,
    a2: (A + 1 - (A - 1) * c - s) / a0,
  };
}

/** Filters `x` into a new array. `reverse` runs the filter backwards in time. */
export function biquad(x: Float32Array, f: Biquad, reverse = false): Float32Array {
  const y = new Float32Array(x.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  const n = x.length;
  for (let k = 0; k < n; k++) {
    const i = reverse ? n - 1 - k : k;
    const xi = x[i]!;
    const yi = f.b0 * xi + f.b1 * x1 + f.b2 * x2 - f.a1 * y1 - f.a2 * y2;
    x2 = x1;
    x1 = xi;
    y2 = y1;
    y1 = yi;
    y[i] = yi;
  }
  return y;
}

// Butterworth 4th order as two biquads.
const BW4_Q = [0.5411961, 1.306563];

/**
 * Zero-phase low-pass (4th-order Butterworth run forwards then backwards). Because it has no
 * phase shift, `x − lowpassZeroPhase(x)` is its exact complement: the two bands always sum back
 * to the original signal, so untouched audio stays bit-transparent.
 */
export function lowpassZeroPhase(x: Float32Array, fc: number, sr: number): Float32Array {
  let y = x;
  for (const q of BW4_Q) y = biquad(y, lowpass(fc, q, sr));
  for (const q of BW4_Q) y = biquad(y, lowpass(fc, q, sr), true);
  return y;
}

/** ITU-R BS.1770 K-weighting (shelf + RLB high-pass) for any sample rate. */
export function kWeight(x: Float32Array, sr: number): Float32Array {
  const shelf = highShelf(1681.974450955533, 3.999843853973347, 0.7071752369554196, sr);
  const hp = highpass(38.13547087602444, 0.5003270373238773, sr);
  return biquad(biquad(x, shelf), hp);
}
