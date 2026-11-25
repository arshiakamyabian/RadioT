import { z } from 'zod';

export const idSchema = z.string().min(1).max(64);
export const isoDateSchema = z.string().datetime();
export const emailSchema = z.string().trim().toLowerCase().email().max(254);
export const handleSchema = z
  .string()
  .min(3)
  .max(24)
  .regex(/^[a-z0-9_]+$/, 'lowercase letters, digits and underscores only');
export const localeSchema = z.enum(['en', 'tr']);

export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.string(),
  uptimeSeconds: z.number().nonnegative(),
  checks: z.record(z.string(), z.enum(['ok', 'down'])),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;
