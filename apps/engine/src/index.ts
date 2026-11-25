import { mkdir } from 'node:fs/promises';
import pino from 'pino';
import { Engine } from './engine.js';
import { envSchema } from './env.js';
import { LiquidsoapClient } from './liquidsoap.js';
import { MediaCache } from './media-cache.js';
import { createEngineServer } from './server.js';
import { Supervisor, runPaths } from './supervisor.js';

const env = envSchema.parse(process.env);
const log = pino({ level: env.LOG_LEVEL });
const dirs = runPaths(env);
await mkdir(dirs.cache, { recursive: true });

const supervisor = new Supervisor(env, log);
if (env.SPAWN) await supervisor.start();

const cache = new MediaCache(dirs.cache, env.FFMPEG_PATH, env.CACHE_MAX_MB * 1024 * 1024, log);
const lq = new LiquidsoapClient(env.LIQ_TELNET_PORT);
const engine = new Engine(env, lq, cache, {
  ...log,
  debug: log.debug.bind(log),
  error: log.error.bind(log),
  info: log.info.bind(log),
  warn: log.warn.bind(log),
});
const server = createEngineServer(env, engine, dirs.hls, log);
server.listen(env.PORT, env.HOST, () => {
  log.info({ port: env.PORT, host: env.HOST, api: env.API_URL }, 'engine ready');
  engine.start();
});

const shutdown = () => {
  engine.stop();
  supervisor.stop();
  server.close();
  setTimeout(() => process.exit(0), 500).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
