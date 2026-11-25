import { run } from './exec.js';

export interface Pcm {
  channels: [Float32Array, Float32Array];
  sampleRate: number;
}

/**
 * Decodes (part of) a media file to stereo float PCM with ffmpeg. `fromSec`/`durationSec` use
 * output seeking, which decodes from the start of the file: slower, but sample-exact.
 */
export async function decodePcm(
  ffmpeg: string,
  file: string,
  sampleRate: number,
  range: { fromSec?: number; durationSec?: number } = {},
): Promise<Pcm> {
  const args = ['-nostdin', '-v', 'error', '-i', file, '-map', '0:a:0', '-vn'];
  if (range.fromSec && range.fromSec > 0) args.push('-ss', range.fromSec.toFixed(6));
  if (range.durationSec !== undefined) args.push('-t', Math.max(0, range.durationSec).toFixed(6));
  args.push('-ac', '2', '-ar', String(sampleRate), '-f', 'f32le', '-');
  const res = await run(ffmpeg, args);
  if (res.code !== 0) throw new Error(`ffmpeg decode failed: ${res.stderr.slice(-300)}`);
  const buf = res.stdout;
  const frames = Math.floor(buf.byteLength / 8);
  const inter = new Float32Array(buf.buffer, buf.byteOffset, frames * 2);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    left[i] = inter[2 * i]!;
    right[i] = inter[2 * i + 1]!;
  }
  return { channels: [left, right], sampleRate };
}
