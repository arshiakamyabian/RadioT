const WINDOW = 1536; // ~35 ms at 44.1 kHz
const HOP = WINDOW / 2;
const COARSE = 4; // decimation for the first search pass

export interface WarpOptions {
  /** How far (seconds) a grain may sit from its ideal position to keep waveforms continuous. */
  toleranceSec?: number;
  /**
   * Only the first N channels steer the grain search; the rest follow the same grains. Used to
   * warp a track and its stems identically, so stem corrections line up with the full mix.
   */
  refChannels?: number;
}

/**
 * Pitch-preserving time warp (WSOLA). Output sample `n` plays input position `phi(n)` (in
 * samples, monotonic). Where `phi` advances at exactly one sample per sample the output is a
 * bit-exact copy of the input, so unwarped lead-ins and lead-outs stay untouched; elsewhere
 * grains are overlap-added at the best-matching nearby position, which changes tempo without
 * changing pitch. Timing error is bounded by the tolerance.
 */
export function warp(
  channels: Float32Array[],
  phi: (n: number) => number,
  outLength: number,
  sampleRate: number,
  opts: WarpOptions = {},
): Float32Array[] {
  const inLength = channels[0]?.length ?? 0;
  const tol = Math.max(COARSE, Math.round((opts.toleranceSec ?? 0.006) * sampleRate));
  const out = channels.map(() => new Float32Array(outLength));
  if (!inLength || !outLength) return out;

  // Mono reference for the similarity search, plus a decimated copy for the coarse pass.
  const ref = new Float32Array(inLength);
  for (const c of channels.slice(0, opts.refChannels ?? channels.length))
    for (let i = 0; i < inLength; i++) ref[i] = ref[i]! + c[i]!;
  const coarseLen = Math.floor(inLength / COARSE);
  const refCoarse = new Float32Array(coarseLen);
  for (let i = 0; i < coarseLen; i++) {
    let s = 0;
    for (let k = 0; k < COARSE; k++) s += ref[i * COARSE + k]!;
    refCoarse[i] = s;
  }

  const win = new Float32Array(WINDOW);
  for (let i = 0; i < WINDOW; i++)
    win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / WINDOW);

  const at = (buf: Float32Array, i: number) => (i >= 0 && i < buf.length ? buf[i]! : 0);

  /** Normalised correlation between input at `a` and at `b` over one window. */
  const similarity = (buf: Float32Array, a: number, b: number, len: number) => {
    let dot = 0;
    let eb = 0;
    for (let i = 0; i < len; i++) {
      const y = at(buf, b + i);
      dot += at(buf, a + i) * y;
      eb += y * y;
    }
    return dot / Math.sqrt(eb + 1e-9);
  };

  let prev = Number.NaN; // input position of the previous grain
  for (let start = -HOP; start < outLength; start += HOP) {
    const ideal = Math.round(phi(start));
    let pos = ideal;
    if (!Number.isNaN(prev)) {
      const natural = prev + HOP;
      if (Math.abs(natural - ideal) <= 1) {
        pos = natural; // unwarped: plain copy
      } else if (Math.abs(natural - ideal) <= tol) {
        pos = natural; // still inside the tolerance: keep the waveform continuous
      } else {
        // Search around the ideal position for the grain that best continues the last one.
        const cLen = Math.floor(WINDOW / COARSE);
        const cNat = Math.round(natural / COARSE);
        let best = -Infinity;
        let bestC = Math.round(ideal / COARSE);
        const span = Math.floor(tol / COARSE);
        for (let d = -span; d <= span; d++) {
          const cand = Math.round(ideal / COARSE) + d;
          const s = similarity(refCoarse, cNat, cand, cLen);
          if (s > best) {
            best = s;
            bestC = cand;
          }
        }
        best = -Infinity;
        for (let d = -COARSE; d <= COARSE; d++) {
          const cand = bestC * COARSE + d;
          if (Math.abs(cand - ideal) > tol) continue;
          const s = similarity(ref, natural, cand, WINDOW);
          if (s > best) {
            best = s;
            pos = cand;
          }
        }
      }
    }
    for (let c = 0; c < channels.length; c++) {
      const src = channels[c]!;
      const dst = out[c]!;
      for (let i = 0; i < WINDOW; i++) {
        const o = start + i;
        if (o < 0 || o >= outLength) continue;
        const s = pos + i;
        if (s >= 0 && s < inLength) dst[o] = dst[o]! + src[s]! * win[i]!;
      }
    }
    prev = pos;
  }
  return out;
}
