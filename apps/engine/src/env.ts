import { resolve } from 'node:path';
import { z } from 'zod';

const flag = z
  .string()
  .optional()
  .transform((v) => v !== '0' && v !== 'false');

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().default(4200),
  API_URL: z.string().url().default('http://localhost:4000'),
  PUBLIC_URL: z
    .string()
    .optional()
    .transform((v) => (v ? v.replace(/\/$/, '') : '')),
  CORS_ORIGINS: z.string().default('*'),
  RUN_DIR: z
    .string()
    .default('./run')
    .transform((p) => resolve(p)),
  CACHE_MAX_MB: z.coerce.number().int().positive().default(4096),
  SPAWN: flag,
  FFMPEG_PATH: z.string().default('ffmpeg'),
  LIQUIDSOAP_PATH: z.string().default('liquidsoap'),
  ICECAST_PATH: z.string().default('icecast'),
  LIQ_TELNET_PORT: z.coerce.number().int().default(1234),
  ICECAST_PORT: z.coerce.number().int().default(8000),
  ICECAST_SOURCE_PASSWORD: z.string().default('radiot-source'),
  ICECAST_ADMIN_PASSWORD: z.string().default('radiot-admin'),
  ICECAST_SHARE: z.string().default('/opt/homebrew/share/icecast'),
  HLS_SEGMENT_SECONDS: z.coerce.number().positive().default(2),
  HLS_SEGMENTS: z.coerce.number().int().positive().default(10),
  STREAM_DELAY_MS: z.coerce.number().int().nonnegative().default(9000),
});
export type Env = z.infer<typeof envSchema>;
