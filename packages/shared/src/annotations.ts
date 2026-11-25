import type { TrackMedia } from './radio.js';

export interface PlayableTrack {
  id: string;
  storageKey: string | null;
  durationMs: number | null;
  gainDb: number | null;
  cueInMs: number | null;
  cueOutMs: number | null;
  crossfadeDurationMs: number | null;
}

/**
 * Everything a listener's browser needs to play a track in sync: where the file is, where the
 * audible part starts and ends, the loudness correction, and how long it fades into the next.
 */
export function trackMedia(
  t: PlayableTrack,
  mediaBaseUrl: string,
  defaultCrossMs: number,
  mixFromMs: number | null = null,
): TrackMedia {
  if (!t.storageKey) throw new Error(`track ${t.id} has no cooked media`);
  const duration = t.durationMs ?? 0;
  return {
    url: `${mediaBaseUrl.replace(/\/$/, '')}/${t.storageKey}`,
    cueInMs: t.cueInMs ?? 0,
    cueOutMs: t.cueOutMs ?? duration,
    gainDb: t.gainDb ?? 0,
    crossfadeMs: t.crossfadeDurationMs ?? defaultCrossMs,
    mixFromMs,
    fileMs: duration || null,
  };
}

/** Milliseconds of a track that actually air before the next track starts fading in. */
export function airtimeMs(t: {
  durationMs: number | null;
  cueInMs: number | null;
  cueOutMs: number | null;
  crossfadeDurationMs: number | null;
}) {
  const duration = t.durationMs ?? 0;
  const cueOut = t.cueOutMs ?? duration;
  return Math.max(0, cueOut - (t.cueInMs ?? 0) - (t.crossfadeDurationMs ?? 0));
}

/** Seconds into the media file a listener should be at, `elapsedMs` after the track went on air. */
export function filePositionSeconds(media: Pick<TrackMedia, 'cueInMs'>, elapsedMs: number) {
  return (media.cueInMs + Math.max(0, elapsedMs)) / 1000;
}

/** Equal-power crossfade gains at progress `p` (0 → 1) of a fade. */
export function equalPowerGains(p: number) {
  const x = Math.min(1, Math.max(0, p));
  return { out: Math.cos((x * Math.PI) / 2), in: Math.sin((x * Math.PI) / 2) };
}

export const dbToGain = (db: number) => 10 ** (db / 20);
