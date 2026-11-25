import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const optional = z
  .string()
  .optional()
  .transform((v) => (v ? v : undefined));

// `pnpm build` on Linux (i.e. on Vercel) vendors static ffmpeg/fpcalc binaries next to dist/.
function vendored(name: string) {
  const path = fileURLToPath(new URL(`../vendor/${name}`, import.meta.url));
  return existsSync(path) ? path : name;
}

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  PORT: z.coerce.number().int().default(4100),
  DATABASE_URL: z.string().default('postgres://radiot:radiot@localhost:5432/radiot'),
  API_URL: z.string().url().default('http://localhost:4000'),
  INTERNAL_SECRET: z.string().min(16).default('dev-internal-secret-change-me'),
  BLOB_READ_WRITE_TOKEN: optional,
  MEDIA_BASE_URL: optional,
  // Local development without Blob: media is kept in this folder and served by the dev worker.
  LOCAL_MEDIA_DIR: optional,
  FFMPEG_PATH: optional.transform((v) => v ?? vendored('ffmpeg')),
  // SoundCloud links and Spotify songs (found on SoundCloud) are downloaded with yt-dlp.
  YTDLP_PATH: optional.transform((v) => v ?? vendored('yt-dlp')),
  FPCALC_PATH: optional.transform((v) => v ?? vendored('fpcalc')),
  SENTRY_DSN: optional,
  // Pretrained-model analysis (apps/worker/ml): the Python of its virtualenv. Unset = off (the
  // DSP analysis alone is used, as on Vercel, which has no Python ML runtime for this).
  ML_PYTHON: optional,
  ML_DEVICE: optional,
  ML_STEM_MODEL: optional,
});
export type Env = z.infer<typeof envSchema>;
