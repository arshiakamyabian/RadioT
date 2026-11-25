import { z } from 'zod';
import { requestPublicSchema } from './requests.js';

export const voteBodySchema = z.object({
  requestId: z.string().uuid(),
  turnstileToken: z.string().max(4096).optional(),
});
export type VoteBody = z.infer<typeof voteBodySchema>;

export const candidateSchema = requestPublicSchema.extend({
  votes: z.number().int().nonnegative(),
});
export type Candidate = z.infer<typeof candidateSchema>;

export const roundStateSchema = z.object({
  roundId: z.string().nullable(),
  status: z.enum(['open', 'locked', 'closed']).nullable(),
  lockAt: z.string().nullable(),
  candidates: z.array(candidateSchema),
  /** Looping uploads, also votable; in the order they come back around. */
  rotation: z.array(candidateSchema),
  myVote: z.string().nullable(),
  winnerRequestId: z.string().nullable(),
});
export type RoundState = z.infer<typeof roundStateSchema>;

export const roundCountsSchema = z.object({
  roundId: z.string(),
  counts: z.record(z.string(), z.number().int().nonnegative()),
});
export type RoundCounts = z.infer<typeof roundCountsSchema>;
