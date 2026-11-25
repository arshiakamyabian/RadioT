import type { Redis } from 'ioredis';
import type { Server } from 'socket.io';
import type { Database } from '@radiot/db';
import {
  INTERNAL_SECRET_HEADER,
  type ClientToServerEvents,
  type MediaJob,
  type ServerToClientEvents,
} from '@radiot/shared';
import type { Auth } from './auth.js';
import type { Env } from './env.js';
import type { Mailer } from './mailer.js';
import type { ApiStorage } from './services/storage.js';

export type Io = Server<ClientToServerEvents, ServerToClientEvents>;
type Args<E extends keyof ServerToClientEvents> = Parameters<ServerToClientEvents[E]>;

export interface Broadcaster {
  toAll<E extends keyof ServerToClientEvents>(event: E, ...args: Args<E>): void;
  toRoom<E extends keyof ServerToClientEvents>(room: string, event: E, ...args: Args<E>): void;
}

/** Socket.IO is attached after Fastify boots; until then broadcasts are dropped. */
export function createBroadcaster() {
  let io: Io | null = null;
  const b: Broadcaster & { attach(server: Io): void } = {
    attach(server) {
      io = server;
    },
    toAll(event, ...args) {
      io?.emit(event, ...args);
    },
    toRoom(room, event, ...args) {
      io?.to(room).emit(event, ...args);
    },
  };
  return b;
}

export interface MediaDispatcher {
  dispatch(job: MediaJob): Promise<void>;
}

/** Hands a track to the worker deployment, which acknowledges at once and processes in the background. */
export function createMediaDispatcher(env: Env): MediaDispatcher {
  return {
    async dispatch(job) {
      const res = await fetch(`${env.WORKER_URL.replace(/\/$/, '')}/api/media`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [INTERNAL_SECRET_HEADER]: env.INTERNAL_SECRET,
        },
        body: JSON.stringify(job),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`worker rejected media job (${res.status})`);
    },
  };
}

export interface AppContext {
  env: Env;
  db: Database;
  redis: Redis;
  auth: Auth;
  mailer: Mailer;
  media: MediaDispatcher;
  broadcast: Broadcaster;
  storage: ApiStorage;
}
