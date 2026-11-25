/** Radix-2 FFT with precomputed tables. Sizes must be powers of two. */
export class FFT {
  private readonly cos: Float64Array;
  private readonly sin: Float64Array;
  private readonly rev: Uint32Array;

  constructor(readonly n: number) {
    if (n < 2 || (n & (n - 1)) !== 0) throw new Error('FFT size must be a power of two');
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n);
      this.sin[i] = Math.sin((2 * Math.PI * i) / n);
    }
    this.rev = new Uint32Array(n);
    const bits = Math.log2(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
  }

  /** In-place forward transform. */
  transform(re: Float64Array, im: Float64Array) {
    const { n, rev, cos, sin } = this;
    for (let i = 0; i < n; i++) {
      const j = rev[i]!;
      if (j > i) {
        const tr = re[i]!;
        re[i] = re[j]!;
        re[j] = tr;
        const ti = im[i]!;
        im[i] = im[j]!;
        im[j] = ti;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0, t = 0; k < half; k++, t += step) {
          const wr = cos[t]!;
          const wi = -sin[t]!;
          const a = start + k;
          const b = a + half;
          const xr = re[b]! * wr - im[b]! * wi;
          const xi = re[b]! * wi + im[b]! * wr;
          re[b] = re[a]! - xr;
          im[b] = im[a]! - xi;
          re[a] = re[a]! + xr;
          im[a] = im[a]! + xi;
        }
      }
    }
  }
}

export function hann(n: number) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

/**
 * Magnitude spectra of `x`, one per hop. Frame `i` covers samples [i*hop, i*hop + nfft), so its
 * centre is at (i*hop + nfft/2) / sampleRate seconds. `mag` is reused between calls.
 */
export function stft(
  x: Float32Array,
  nfft: number,
  hop: number,
  onFrame: (mag: Float64Array, frame: number) => void,
) {
  const fft = new FFT(nfft);
  const win = hann(nfft);
  const re = new Float64Array(nfft);
  const im = new Float64Array(nfft);
  const mag = new Float64Array(nfft / 2 + 1);
  const frames = Math.max(0, Math.floor((x.length - nfft) / hop) + 1);
  for (let f = 0; f < frames; f++) {
    const off = f * hop;
    for (let i = 0; i < nfft; i++) {
      re[i] = x[off + i]! * win[i]!;
      im[i] = 0;
    }
    fft.transform(re, im);
    for (let k = 0; k <= nfft / 2; k++) mag[k] = Math.hypot(re[k]!, im[k]!);
    onFrame(mag, f);
  }
  return frames;
}
