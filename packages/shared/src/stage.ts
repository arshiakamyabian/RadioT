import { z } from 'zod';
import { publicUserSchema } from './radio.js';

export const STAGE_ROOM = 'radiot-stage';
export const STAGE_END_GRACE_MS = 3000;

export const stageStateSchema = z.object({
  live: z.boolean(),
  performer: publicUserSchema.nullable(),
  roundId: z.string().nullable(),
});
export type StageState = z.infer<typeof stageStateSchema>;

export const stageTokenSchema = z.object({
  token: z.string(),
  url: z.string(),
  room: z.string(),
  role: z.enum(['performer', 'viewer']),
});
export type StageToken = z.infer<typeof stageTokenSchema>;
