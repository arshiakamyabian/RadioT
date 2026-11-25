import { z } from 'zod';
import { transitionModeSchema, type PlanOptions } from './transitions.js';

export const stationSettingsSchema = z.object({
  lockLeadSeconds: z.number().int().min(5).max(120).default(10),
  /**
   * With the AI analysis the exit point of the song on air is known in advance, so voting stays
   * open until this many seconds before the mix (plus the clip's lead-in) begins.
   */
  aiLockLeadSeconds: z.number().int().min(2).max(60).default(20),
  roundExpiryCount: z.number().int().min(1).max(50).default(5),
  maxUploadMb: z.number().int().min(1).max(500).default(150),
  maxDurationMinutes: z.number().int().min(1).max(30).default(10),
  crossfadeDefaultMs: z.number().int().min(0).max(15000).default(5000),
  fallbackShuffle: z.boolean().default(true),
  requestsPerUserPerHour: z.number().int().min(1).max(100).default(10),
  maxActiveRequestsPerUser: z.number().int().min(1).max(20).default(3),
  requestCooldownSeconds: z.number().int().min(0).max(3600).default(15),
  lufsTarget: z.number().min(-30).max(-8).default(-14),
  chatSlowModeSeconds: z.number().int().min(0).max(300).default(3),
  chatBlockedWords: z.array(z.string().min(1).max(50)).max(500).default([]),
  stageEnabled: z.boolean().default(true),
  /** auto = planner picks per pair; smooth / quick force a style; simple = plain crossfade. */
  transitionMode: transitionModeSchema.default('auto'),
  /** Longest overlap between two tracks, seconds. */
  transitionMaxSeconds: z.number().int().min(4).max(32).default(20),
  /** Scales the lengths the planner picks (0.5 = half as long, 1.5 = longer). */
  transitionLengthScale: z.number().min(0.5).max(1.5).default(1),
  beatmatchEnabled: z.boolean().default(true),
  /** Largest tempo difference (percent) that is still beat-matched. */
  tempoTolerancePct: z.number().min(0).max(10).default(6),
  bassSwapEnabled: z.boolean().default(true),
});
export type StationSettings = z.infer<typeof stationSettingsSchema>;
export const DEFAULT_SETTINGS: StationSettings = stationSettingsSchema.parse({});
export const stationSettingsPatchSchema = stationSettingsSchema.partial();

export function planOptionsFromSettings(s: StationSettings): PlanOptions {
  return {
    mode: s.transitionMode,
    maxSeconds: s.transitionMaxSeconds,
    lengthScale: s.transitionLengthScale,
    beatmatch: s.beatmatchEnabled,
    tempoTolerancePct: s.tempoTolerancePct,
    bassSwap: s.bassSwapEnabled,
    defaultCrossfadeMs: s.crossfadeDefaultMs,
  };
}
