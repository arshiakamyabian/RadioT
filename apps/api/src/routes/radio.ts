import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  INTERNAL_SECRET_HEADER,
  STATION_NAME,
  workerEventSchema,
  type PublicStation,
  type RadioState,
} from '@radiot/shared';
import type { AppContext } from '../context.js';
import type { Notifier } from '../services/notify.js';
import { publicRequestById } from '../services/requests-view.js';
import type { RequestService } from '../services/requests.js';
import type { Station } from '../services/station.js';
import { HttpError } from './helpers.js';

export function requireInternal(ctx: AppContext, req: FastifyRequest) {
  const given = Buffer.from(String(req.headers[INTERNAL_SECRET_HEADER] ?? ''));
  const want = Buffer.from(ctx.env.INTERNAL_SECRET);
  if (given.length !== want.length || !timingSafeEqual(given, want))
    throw new HttpError(401, 'unauthorized');
}

export function radioRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  station: Station,
  requests: RequestService,
  notify: Notifier,
  listenerCount: () => number,
) {
  // Every listener polls this around transitions, which is also what advances the timeline.
  app.get('/api/now-playing', async (_req, reply): Promise<RadioState> => {
    void reply.header('cache-control', 'no-store');
    return station.state();
  });

  app.get('/api/public/station', async (_req, reply): Promise<PublicStation> => {
    const { now, next, serverTime } = await station.state();
    const nowMs = new Date(serverTime).getTime();
    const elapsed = now ? Math.max(0, (nowMs - new Date(now.startedAt).getTime()) / 1000) : 0;
    // Game servers poll this; a short shared cache keeps a busy server from hammering the API.
    void reply.header('cache-control', 'public, max-age=3, stale-while-revalidate=10');
    return {
      name: STATION_NAME,
      now,
      next,
      elapsedSeconds: Math.round(elapsed),
      listeners: listenerCount(),
      serverTime,
    };
  });
  app.get('/api/queue', async () => ({ queue: await requests.queue() }));

  app.post('/internal/worker-event', { config: { rateLimit: false } }, async (req) => {
    requireInternal(ctx, req);
    const evt = workerEventSchema.parse(req.body ?? {});
    if (evt.type === 'request.status') {
      const pub = await publicRequestById(ctx.db, evt.requestId);
      if (pub) {
        await notify.request(
          pub.status === 'ready' ? 'ready' : pub.status === 'rejected' ? 'rejected' : null,
          pub,
        );
        ctx.broadcast.toAll('queue:update');
      }
    }
    if (evt.type === 'transition.ready') await station.onTransitionReady(evt.transitionId);
    return { ok: true };
  });
}
