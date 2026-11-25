import * as Sentry from '@sentry/node';
import pino from 'pino';
import { createDb } from '@radiot/db';
import { INTERNAL_SECRET_HEADER, type WorkerEvent } from '@radiot/shared';
import { envSchema, type Env } from './env.js';
import { createTools } from './media/tools.js';
import type { PipelineDeps } from './pipeline.js';
import { createStorage } from './storage.js';

export function createDeps(env: Env = envSchema.parse(process.env)) {
  if (env.SENTRY_DSN) Sentry.init({ dsn: env.SENTRY_DSN, environment: env.NODE_ENV });
  const log = pino({ level: env.LOG_LEVEL });
  const { db, pool } = createDb(env.DATABASE_URL);
  const deps: PipelineDeps = {
    db,
    storage: createStorage(env),
    tools: createTools(env),
    ytdlp: env.YTDLP_PATH,
    log,
    ml: {
      python: env.ML_PYTHON,
      device: env.ML_DEVICE,
      stemModel: env.ML_STEM_MODEL,
      ffmpeg: env.FFMPEG_PATH,
    },
    // Reports back to the API, which notifies the requester and refreshes everyone's queue.
    // A failed notification must not undo finished work: the DB row is already updated, and the
    // web app refreshes the queue on its next poll anyway.
    publish: async (event: WorkerEvent) => {
      try {
        const res = await fetch(`${env.API_URL.replace(/\/$/, '')}/internal/worker-event`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            [INTERNAL_SECRET_HEADER]: env.INTERNAL_SECRET,
          },
          body: JSON.stringify(event),
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) log.warn({ status: res.status, event }, 'api rejected worker event');
      } catch (err) {
        log.warn({ err: (err as Error).message, event }, 'could not reach api for worker event');
      }
    },
  };
  return { env, deps, log, pool };
}
