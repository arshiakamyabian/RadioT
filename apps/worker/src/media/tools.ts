import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { Env } from '../env.js';
import { parseEbur128, rmsEnvelope } from './analysis.js';
import { run, runOk } from './exec.js';
import { decodePcm } from './pcm.js';

const ENVELOPE_RATE = 8000;

export const probeSchema = z.object({
  format: z.object({
    duration: z.coerce.number().optional(),
    size: z.coerce.number().optional(),
    tags: z.record(z.string(), z.string()).optional(),
  }),
  streams: z.array(
    z.object({
      codec_type: z.string(),
      codec_name: z.string().optional(),
      disposition: z.record(z.string(), z.number()).optional(),
      tags: z.record(z.string(), z.string()).optional(),
    }),
  ),
});
export type Probe = z.infer<typeof probeSchema>;

/** Parses the "Input #0" summary ffmpeg prints for `ffmpeg -i file` into an ffprobe-shaped object. */
export function parseFfmpegInfo(stderr: string): Probe {
  const start = stderr.indexOf('Input #0');
  if (start < 0) throw new Error('not readable media');
  const end = stderr.indexOf('\nOutput #', start);
  const info = stderr.slice(start, end < 0 ? undefined : end);
  const dur = info.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const tags: Record<string, string> = {};
  for (const m of info.matchAll(/^\s{4,}([A-Za-z0-9_-]+)\s*:\s(.*)$/gm)) {
    const key = m[1]!.toLowerCase();
    if (!(key in tags)) tags[key] = m[2]!.trim();
  }
  const streams = [
    ...info.matchAll(/Stream #0:\d+\S*: (Audio|Video): ([A-Za-z0-9_]+)([^\n]*)/g),
  ].map((m) => ({
    codec_type: m[1]!.toLowerCase(),
    codec_name: m[2]!,
    disposition: /attached pic/.test(m[3]!) ? { attached_pic: 1 } : undefined,
  }));
  return probeSchema.parse({
    format: {
      duration: dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : undefined,
      tags,
    },
    streams,
  });
}

export function createTools(env: Env) {
  return {
    // ffprobe isn't shipped as a static npm binary, so read ffmpeg's own input summary instead.
    async probe(file: string): Promise<Probe> {
      const { stderr } = await run(env.FFMPEG_PATH, ['-hide_banner', '-nostdin', '-i', file]);
      return parseFfmpegInfo(stderr);
    },

    // The file every listener streams: constant bitrate so seeking to the shared position is exact.
    // Loudness is applied in the browser from gainDb.
    async transcode(input: string, output: string) {
      await runOk(env.FFMPEG_PATH, [
        '-nostdin',
        '-y',
        '-v',
        'error',
        '-i',
        input,
        '-map',
        '0:a:0',
        '-vn',
        '-ar',
        '44100',
        '-ac',
        '2',
        '-c:a',
        'libmp3lame',
        '-b:a',
        '192k',
        '-compression_level',
        '5',
        '-map_metadata',
        '-1',
        output,
      ]);
    },

    async extractArtwork(input: string, output: string): Promise<boolean> {
      const res = await run(env.FFMPEG_PATH, [
        '-nostdin',
        '-y',
        '-v',
        'error',
        '-i',
        input,
        '-map',
        '0:v:0',
        '-frames:v',
        '1',
        '-vf',
        "scale='min(800,iw)':-2",
        output,
      ]);
      return res.code === 0;
    },

    async loudness(file: string) {
      const { stderr } = await runOk(env.FFMPEG_PATH, [
        '-nostdin',
        '-hide_banner',
        '-nostats',
        '-i',
        file,
        '-map',
        '0:a:0',
        '-vn',
        '-af',
        'ebur128=peak=true',
        '-f',
        'null',
        '-',
      ]);
      return parseEbur128(stderr);
    },

    async envelope(file: string) {
      const { stdout } = await runOk(env.FFMPEG_PATH, [
        '-nostdin',
        '-v',
        'error',
        '-i',
        file,
        '-map',
        '0:a:0',
        '-vn',
        '-ac',
        '1',
        '-ar',
        String(ENVELOPE_RATE),
        '-f',
        'f32le',
        '-',
      ]);
      const samples = new Float32Array(
        stdout.buffer,
        stdout.byteOffset,
        Math.floor(stdout.byteLength / 4),
      );
      return {
        envelope: rmsEnvelope(samples, ENVELOPE_RATE),
        durationMs: Math.round((samples.length / ENVELOPE_RATE) * 1000),
      };
    },

    async fingerprint(file: string): Promise<number[]> {
      const { stdout } = await runOk(env.FPCALC_PATH, ['-raw', '-json', '-length', '120', file]);
      return z.object({ fingerprint: z.array(z.number()) }).parse(JSON.parse(stdout.toString()))
        .fingerprint;
    },

    /** Stereo float PCM of (part of) a file; see decodePcm. */
    pcm: (file: string, sampleRate: number, range?: { fromSec?: number; durationSec?: number }) =>
      decodePcm(env.FFMPEG_PATH, file, sampleRate, range),

    /** Encodes raw interleaved stereo float PCM (a .f32 file) to a 256 kbps MP3. */
    async encodeMp3(rawFile: string, sampleRate: number, output: string) {
      await runOk(env.FFMPEG_PATH, [
        '-nostdin',
        '-y',
        '-v',
        'error',
        '-f',
        'f32le',
        '-ar',
        String(sampleRate),
        '-ac',
        '2',
        '-i',
        rawFile,
        '-c:a',
        'libmp3lame',
        '-b:a',
        '256k',
        output,
      ]);
    },

    readFile,
  };
}
export type MediaTools = ReturnType<typeof createTools>;
