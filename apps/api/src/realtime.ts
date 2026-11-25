import { randomUUID } from 'node:crypto';
import { createAdapter } from '@socket.io/redis-adapter';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import { Server } from 'socket.io';
import { ROOMS } from '@radiot/shared';
import type { Auth } from './auth.js';
import type { Io } from './context.js';
import type { Env } from './env.js';
import { toWebHeaders } from './http.js';
import { getRole } from './services/users.js';
import type { Database } from '@radiot/db';

const LISTENERS_KEY = 'radio:listeners';
const LISTENER_TTL_MS = 20_000;

export function attachRealtime(
  app: FastifyInstance,
  env: Env,
  redis: Redis,
  auth: Auth,
  db: Database,
) {
  const io: Io = new Server(app.server, {
    cors: { origin: env.webOrigins, credentials: true },
    adapter: createAdapter(redis.duplicate(), redis.duplicate()),
  });

  // Listening is anonymous; userId is attached when a session cookie is present.
  io.use(async (socket, next) => {
    try {
      const session = socket.handshake.headers.cookie
        ? await auth.api.getSession({ headers: toWebHeaders(socket.handshake.headers) })
        : null;
      socket.data.userId = session?.user.id ?? null;
      next();
    } catch (err) {
      next(err instanceof Error ? err : new Error('auth failed'));
    }
  });

  io.on('connection', async (socket) => {
    const userId = socket.data.userId as string | null;
    if (userId) {
      await socket.join(ROOMS.user(userId));
      if ((await getRole(db, userId).catch(() => 'user')) === 'admin')
        await socket.join(ROOMS.admins);
    }
    socket.on('radio:listen', (listening) => {
      if (listening === true) void socket.join(ROOMS.listeners);
      else void socket.leave(ROOMS.listeners);
    });
  });

  // Listener count across every API node. fetchSockets() can't be used: it waits for every node
  // over Redis, and frozen serverless instances never answer. Each node publishes its own count
  // with a timestamp instead, and stale entries (frozen or gone nodes) are dropped.
  const nodeId = randomUUID();
  let listeners = 0;
  const timer = setInterval(async () => {
    try {
      const now = Date.now();
      const local = io.of('/').adapter.rooms.get(ROOMS.listeners)?.size ?? 0;
      await redis.hset(LISTENERS_KEY, nodeId, `${local}:${now}`);
      const entries = await redis.hgetall(LISTENERS_KEY);
      let n = 0;
      const stale: string[] = [];
      for (const [node, value] of Object.entries(entries)) {
        const [count, at] = value.split(':').map(Number);
        if (now - (at ?? 0) > LISTENER_TTL_MS) stale.push(node);
        else n += count ?? 0;
      }
      if (stale.length) await redis.hdel(LISTENERS_KEY, ...stale);
      if (n !== listeners) {
        listeners = n;
        io.emit('radio:listeners', n);
      }
    } catch (err) {
      app.log.warn({ err }, 'listener count failed');
    }
  }, 5000);

  app.addHook('onClose', async () => {
    clearInterval(timer);
    await redis.hdel(LISTENERS_KEY, nodeId).catch(() => undefined);
    await io.close();
  });

  return { io, listenerCount: () => listeners };
}
