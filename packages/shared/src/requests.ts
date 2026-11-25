import { z } from 'zod';
import { publicUserSchema } from './radio.js';

export const REQUEST_STATUSES = [
  'pending_upload',
  'ingesting',
  'ready',
  'queued',
  'playing',
  'played',
  'rejected',
  'expired',
] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

const rights = z.literal(true, { message: 'You must confirm you have the rights to this audio.' });
const turnstile = z.string().max(4096).optional();

export const createUploadRequestSchema = z.object({
  filename: z.string().min(1).max(255),
  contentType: z.string().min(1).max(100),
  size: z.number().int().positive(),
  rightsConfirmed: rights,
  turnstileToken: turnstile,
});
export type CreateUploadRequest = z.infer<typeof createUploadRequestSchema>;

export const createUrlRequestSchema = z.object({
  url: z.string().url().max(2048),
  rightsConfirmed: rights,
  turnstileToken: turnstile,
});
export type CreateUrlRequest = z.infer<typeof createUrlRequestSchema>;

export const requestPublicSchema = z.object({
  id: z.string(),
  status: z.enum(REQUEST_STATUSES),
  title: z.string(),
  artist: z.string(),
  artworkUrl: z.string().nullable(),
  durationMs: z.number().int().nullable(),
  rejectReason: z.string().nullable(),
  createdAt: z.string(),
  playedAt: z.string().nullable(),
  requester: publicUserSchema,
});
export type RequestPublic = z.infer<typeof requestPublicSchema>;

export const uploadTicketSchema = z.object({
  request: requestPublicSchema,
  /** Vercel Blob client upload: PUT the file to `pathname` with this short-lived token. */
  upload: z.object({ pathname: z.string(), token: z.string(), contentType: z.string() }),
});
export type UploadTicket = z.infer<typeof uploadTicketSchema>;
