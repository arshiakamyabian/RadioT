import { z } from 'zod';
import { trackFeaturesSchema } from './features.js';

export const ALLOWED_AUDIO_MIME = [
  'audio/mpeg',
  'audio/mp3',
  'audio/aac',
  'audio/mp4',
  'audio/x-m4a',
  'audio/flac',
  'audio/x-flac',
  'audio/ogg',
  'audio/opus',
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
  'audio/webm',
  'audio/aiff',
  'audio/x-aiff',
  // Music videos: only the audio track is kept (ffmpeg maps 0:a:0).
  'video/mp4',
  'video/webm',
  'video/quicktime',
] as const;

/** Browsers often report an empty or odd MIME type; fall back to the file extension. */
const MIME_BY_EXT: Record<string, (typeof ALLOWED_AUDIO_MIME)[number]> = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/opus',
  wav: 'audio/wav',
  aif: 'audio/aiff',
  aiff: 'audio/aiff',
  weba: 'audio/webm',
  webm: 'video/webm',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
};

export function audioMimeFor(filename: string, reported: string) {
  const r = reported.toLowerCase().split(';')[0]!.trim();
  if ((ALLOWED_AUDIO_MIME as readonly string[]).includes(r)) return r;
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  return MIME_BY_EXT[ext] ?? null;
}

/**
 * Shortest track the station plays: it needs room for an intro and an outro to mix (AI
 * transitions use up to ~45 s of each). Uploads below it are rejected; older ones stay off air.
 */
export const MIN_TRACK_SECONDS = 60;

export const ALLOWED_CODECS = [
  'mp3',
  'aac',
  'flac',
  'vorbis',
  'opus',
  'alac',
  'pcm_s16le',
  'pcm_s24le',
  'pcm_s32le',
  'pcm_f32le',
  'pcm_s16be',
  'pcm_s24be',
] as const;

export const trackAnalysisSchema = z.object({
  durationMs: z.number().int().positive(),
  lufs: z.number(),
  truePeak: z.number(),
  gainDb: z.number(),
  cueInMs: z.number().int().nonnegative(),
  cueOutMs: z.number().int().positive(),
  crossfadeStartMs: z.number().int().nonnegative(),
  crossfadeDurationMs: z.number().int().min(0),
  /** Deep analysis for the transition planner; absent on tracks analysed before it existed. */
  features: trackFeaturesSchema.nullish(),
});
export type TrackAnalysis = z.infer<typeof trackAnalysisSchema>;
