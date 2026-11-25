import { z } from 'zod';
import { transitionClipSchema, transitionStyleSchema } from './transitions.js';

export const publicUserSchema = z.object({
  id: z.string(),
  name: z.string(),
  handle: z.string().nullable(),
  avatarUrl: z.string().nullable(),
});
export type PublicUser = z.infer<typeof publicUserSchema>;

/** Cooked media plus the worker's precomputed transition data; browsers play from this. */
export const trackMediaSchema = z.object({
  url: z.string().url(),
  cueInMs: z.number().nonnegative(),
  cueOutMs: z.number().nonnegative(),
  gainDb: z.number(),
  /** Length of the equal-power fade into whatever plays after this track. */
  crossfadeMs: z.number().nonnegative(),
  /**
   * File position (ms) before which no transition out of this track can begin, lead-in of the
   * transition clip included. The stream engine cuts the track here so the rest can be chosen
   * once voting has locked.
   */
  mixFromMs: z.number().nonnegative().nullish(),
  /** Length of the cooked file, ms. */
  fileMs: z.number().nonnegative().nullish(),
});
export type TrackMedia = z.infer<typeof trackMediaSchema>;

// 'replay' = a previously played request coming back around in the rotation.
export const trackKindSchema = z.enum(['fallback', 'request', 'replay', 'unknown']);
export type TrackKind = z.infer<typeof trackKindSchema>;

export const nowPlayingSchema = z.object({
  kind: trackKindSchema,
  trackId: z.string().nullable(),
  roundId: z.string().nullable(),
  title: z.string(),
  artist: z.string(),
  artworkUrl: z.string().nullable(),
  /** Airtime: from going on air until the next track starts fading in. */
  durationMs: z.number().int().nonnegative(),
  /** When the track's cue-in point went on air (server clock). */
  startedAt: z.string().datetime(),
  requester: publicUserSchema.nullable(),
  media: trackMediaSchema.nullable(),
});
export type NowPlaying = z.infer<typeof nowPlayingSchema>;

/**
 * A pre-rendered transition into the next track. Players that can, splice from the current
 * file into this clip during its lead-in and back out to the next file after `handoffClipMs`;
 * everyone else crossfades at `startsAt` as before.
 */
export const upNextTransitionSchema = transitionClipSchema.extend({
  style: transitionStyleSchema,
  clipUrl: z.string().url(),
  /** Server time at which the clip's first sample is on air. */
  clipStartsAt: z.string().datetime(),
});
export type UpNextTransition = z.infer<typeof upNextTransitionSchema>;

/** Announced at round lock so every listener can prebuffer the next track and crossfade on time. */
export const upNextSchema = z.object({
  kind: trackKindSchema,
  trackId: z.string(),
  title: z.string(),
  artist: z.string(),
  artworkUrl: z.string().nullable(),
  startsAt: z.string().datetime(),
  media: trackMediaSchema,
  /** Length of the plain crossfade into this track (replaces the current track's crossfadeMs). */
  fadeMs: z.number().nonnegative().optional(),
  transition: upNextTransitionSchema.nullish(),
});
export type UpNext = z.infer<typeof upNextSchema>;

/** GET /api/now-playing — the shared timeline. `serverTime` lets clients correct their clock. */
export const radioStateSchema = z.object({
  now: nowPlayingSchema.nullable(),
  next: upNextSchema.nullable(),
  serverTime: z.string().datetime(),
  /** When the timeline next changes (vote lock or transition); clients check back then. */
  dueAt: z.string().datetime(),
});
export type RadioState = z.infer<typeof radioStateSchema>;

/** GET /api/public/station — everything an embed or game client needs, CORS-open, no auth. */
export const publicStationSchema = z.object({
  name: z.string(),
  now: nowPlayingSchema.nullable(),
  next: upNextSchema.nullable(),
  /** Seconds into the current track at `serverTime` (0 when unknown). */
  elapsedSeconds: z.number().nonnegative(),
  listeners: z.number().int().nonnegative(),
  serverTime: z.string().datetime(),
});
export type PublicStation = z.infer<typeof publicStationSchema>;
