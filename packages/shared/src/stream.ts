import { z } from 'zod';
import { nowPlayingSchema, upNextSchema } from './radio.js';

/**
 * GET {engine}/now and the engine's SSE feed: what the stream is playing, as listeners hear it.
 * The stream reaches a listener a few seconds after the engine puts a piece on air, so players
 * show `now`/`next` against `serverTime - streamDelayMs`, not against the plain server clock.
 */
export const streamStateSchema = z.object({
  now: nowPlayingSchema.nullable(),
  next: upNextSchema.nullable(),
  /** Tracks that went on air before `now`, newest first (so a delayed client can still find its track). */
  history: z.array(nowPlayingSchema),
  serverTime: z.string().datetime(),
  /** Typical delay between the engine's clock and what a listener hears (encode + segments + buffer). */
  streamDelayMs: z.number().int().nonnegative(),
  /** True while the engine is feeding the stream; false when the timeline is empty or the API is unreachable. */
  live: z.boolean(),
  /** Absolute or engine-relative URLs of the outputs. */
  hlsUrl: z.string(),
  mp3Url: z.string(),
});
export type StreamState = z.infer<typeof streamStateSchema>;

/** The track a listener hears at `heardAtMs` (server clock): newest entry that had already started. */
export function trackHeardAt(state: StreamState, heardAtMs: number) {
  const all = [state.now, ...state.history].filter((n): n is NonNullable<typeof n> => !!n);
  return all.find((n) => Date.parse(n.startedAt) <= heardAtMs) ?? state.now;
}
