import * as Sentry from '@sentry/node';
import { Redis } from 'ioredis';
import pino from 'pino';
import { createDb, sql } from '@radiot/db';
import { buildApp } from './app.js';
import { createAuth, isGoogleEnabled } from './auth.js';
import { background, delay } from './background.js';
import { createBroadcaster, createMediaDispatcher, type AppContext } from './context.js';
import { loadEnv } from './env.js';
import { createMailer } from './mailer.js';
import { attachRealtime } from './realtime.js';
import { createMaintenance } from './services/maintenance.js';
import { createNotifier } from './services/notify.js';
import { createRequestService } from './services/requests.js';
import { createStation } from './services/station.js';
import { createApiStorage } from './services/storage.js';
import { createLiveKit } from './stage/livekit.js';
import { createStage } from './stage/service.js';

const env = loadEnv();
if (env.SENTRY_DSN)
  Sentry.init({ dsn: env.SENTRY_DSN, environment: env.NODE_ENV, tracesSampleRate: 0.1 });
const log = pino({ level: env.LOG_LEVEL });

const { db } = createDb(env.DATABASE_URL);
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const mailer = createMailer(env);
const auth = createAuth(env, db, mailer);
const broadcast = createBroadcaster();
const media = createMediaDispatcher(env);
const ctx: AppContext = {
  env,
  db,
  redis,
  auth,
  mailer,
  media,
  broadcast,
  storage: createApiStorage(env),
};
const notify = createNotifier({ env, db, mailer, broadcast, log });
const station = createStation({ env, db, redis, broadcast, notify, media, log });
const maintenance = createMaintenance({ db, redis, media, log });
const livekit =
  env.LIVEKIT_HOST && env.LIVEKIT_API_KEY && env.LIVEKIT_API_SECRET
    ? createLiveKit(env.LIVEKIT_HOST, env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET)
    : null;
const stage = createStage(ctx, station, livekit, log);
// Any performer still on stage from the previous track gets a short grace period.
station.onTrackStart(async (startedAt) =>
  background(
    delay(3000).then(() => stage.endSessionsBefore(startedAt)),
    log,
  ),
);
let listenerCount = () => 0;

const app = await buildApp({
  env,
  auth,
  services: {
    ctx,
    station,
    requests: createRequestService({
      db,
      storage: ctx.storage,
      media,
      broadcast,
      notify,
      relaxLimits: env.NODE_ENV === 'development',
    }),
    stage,
    notify,
    afterStationRead: () => background(maintenance.maybeRun(), log),
    listenerCount: () => listenerCount(),
    googleEnabled: isGoogleEnabled(env),
    pushKey: notify.pushEnabled ? env.VAPID_PUBLIC_KEY! : null,
  },
  checks: {
    postgres: async () => (await db.execute(sql`select 1`)).rowCount === 1,
    redis: async () => (await redis.ping()) === 'PONG',
  },
});

const realtime = attachRealtime(app, env, redis, auth, db);
broadcast.attach(realtime.io);
listenerCount = realtime.listenerCount;

// Locally this process also advances the timeline on time by itself. Not on Vercel: an instance
// with no request in flight is frozen, and a tick frozen inside a transaction stalled the station.
// There, listeners' polls (which await the tick before answering) advance it.
let tickTimer: ReturnType<typeof setTimeout> | undefined;
async function armTicker() {
  clearTimeout(tickTimer);
  const due = await station.tick().catch((err: Error) => {
    log.warn({ err: err.message }, 'tick failed');
    return Date.now() + 5000;
  });
  tickTimer = setTimeout(
    () => void armTicker(),
    Math.min(60_000, Math.max(250, due - Date.now() + 100)),
  );
  tickTimer.unref();
}
if (!process.env.VERCEL) void armTicker();

await app.ready();

if (!process.env.VERCEL) {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void app.close().then(() => process.exit(0));
    });
  }
  await app.listen({ port: env.PORT, host: env.HOST });
}
log.info(
  {
    livekit: Boolean(livekit),
    push: notify.pushEnabled,
    turnstile: Boolean(env.TURNSTILE_SECRET_KEY),
    blob: Boolean(env.BLOB_READ_WRITE_TOKEN),
  },
  'api ready',
);

// Vercel serves this module as one function: HTTP requests and Socket.IO upgrades both land here.
export default app.server;
