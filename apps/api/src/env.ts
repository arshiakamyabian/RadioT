import { z } from 'zod';

const optional = z
  .string()
  .optional()
  .transform((v) => (v ? v : undefined));

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(4000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  API_URL: z.string().url().default('http://localhost:4000'),
  WEB_ORIGIN: z.string().url().default('http://localhost:3000'),
  // Comma-separated extra hosts of the web app (e.g. the *.vercel.app name next to a custom domain).
  EXTRA_WEB_ORIGINS: z
    .string()
    .optional()
    .transform((v) =>
      (v ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.string().url())),
  DATABASE_URL: z.string().default('postgres://radiot:radiot@localhost:5432/radiot'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  BETTER_AUTH_SECRET: z.string().min(32),
  COOKIE_DOMAIN: optional,
  GOOGLE_CLIENT_ID: optional,
  GOOGLE_CLIENT_SECRET: optional,
  // Magic links are logged to the console when SMTP is not configured.
  SMTP_URL: optional,
  MAIL_FROM: z.string().default('RadioT <no-reply@radiot.local>'),
  IP_HASH_SALT: z.string().default('dev-ip-salt'),

  // Shared secret on API <-> worker calls (x-radiot-secret).
  INTERNAL_SECRET: z.string().min(16).default('dev-internal-secret-change-me'),
  WORKER_URL: z.string().url().default('http://localhost:4100'),

  // Vercel Blob. The token is injected automatically once a Blob store is connected to the project.
  BLOB_READ_WRITE_TOKEN: optional,
  // Public base URL of the Blob store; derived from the token when left empty.
  MEDIA_BASE_URL: optional,

  TURNSTILE_SECRET_KEY: optional,
  LIVEKIT_HOST: optional,
  LIVEKIT_API_KEY: optional,
  LIVEKIT_API_SECRET: optional,
  VAPID_PUBLIC_KEY: optional,
  VAPID_PRIVATE_KEY: optional,
  VAPID_SUBJECT: z.string().default('mailto:ops@radiot.app'),
  SENTRY_DSN: optional,
});

export type Env = z.infer<typeof envSchema> & { MEDIA_BASE_URL: string; webOrigins: string[] };

/** Blob tokens look like `vercel_blob_rw_<storeId>_<secret>`; public files live on the store's host. */
export function blobBaseUrl(token: string | undefined) {
  const storeId = token?.match(/^vercel_blob_rw_([a-z0-9]+)_/i)?.[1];
  return storeId ? `https://${storeId.toLowerCase()}.public.blob.vercel-storage.com` : null;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`Invalid environment:\n${z.prettifyError(parsed.error)}`);
  }
  const media =
    parsed.data.MEDIA_BASE_URL ??
    blobBaseUrl(parsed.data.BLOB_READ_WRITE_TOKEN) ??
    'http://localhost/media';
  return {
    ...parsed.data,
    MEDIA_BASE_URL: media,
    webOrigins: [parsed.data.WEB_ORIGIN, ...parsed.data.EXTRA_WEB_ORIGINS],
  };
}
