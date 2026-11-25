import { z } from 'zod';
import { publicUserSchema } from './radio.js';

/** Sticker ids; the artwork lives in the web app. Order = order of the reaction bar. */
export const REACTION_STICKERS = ['fire', 'airhorn', 'rewind'] as const;
export type ReactionSticker = (typeof REACTION_STICKERS)[number];
export const reactionBodySchema = z.object({ sticker: z.enum(REACTION_STICKERS) });
export const reactionEventSchema = z.object({
  sticker: z.enum(REACTION_STICKERS),
  /** Display name of the sender, so the sticker can be credited on screen. */
  name: z.string().max(80),
  userId: z.string(),
  at: z.number(),
});
export type ReactionEvent = z.infer<typeof reactionEventSchema>;

export const CHAT_MAX_LENGTH = 280;
export const chatSendSchema = z.object({
  body: z.string().trim().min(1).max(CHAT_MAX_LENGTH),
  turnstileToken: z.string().max(4096).optional(),
});
export const chatMessageSchema = z.object({
  id: z.string(),
  body: z.string(),
  createdAt: z.string(),
  user: publicUserSchema,
});
export type ChatMessage = z.infer<typeof chatMessageSchema>;

export const reportBodySchema = z.object({
  targetKind: z.enum(['chat', 'stage', 'request', 'profile']),
  targetId: z.string().min(1).max(64),
  targetUserId: z.string().max(64).optional(),
  reason: z.string().trim().min(3).max(500),
});
export type ReportBody = z.infer<typeof reportBodySchema>;

export const profileUpdateSchema = z.object({
  handle: z
    .string()
    .min(3)
    .max(24)
    .regex(/^[a-z0-9_]+$/)
    .optional(),
  displayName: z.string().trim().min(1).max(40).optional(),
  bio: z.string().trim().max(280).optional(),
  locale: z.enum(['en', 'tr']).optional(),
  ageConfirmedAdult: z.literal(true).optional(),
});
export type ProfileUpdate = z.infer<typeof profileUpdateSchema>;
