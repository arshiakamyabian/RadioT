import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createUploadRequestSchema, createUrlRequestSchema } from '@radiot/shared';
import type { AppContext } from '../context.js';
import { publicRequestById } from '../services/requests-view.js';
import { RequestError, type RequestService } from '../services/requests.js';
import { HttpError, body, guardWrite, limit, params, requireUser } from './helpers.js';

const idParams = z.object({ id: z.string().uuid() });
const strictLimit = { rateLimit: { max: 10, timeWindow: '1 minute' } };

export function requestRoutes(app: FastifyInstance, ctx: AppContext, svc: RequestService) {
  const wrap = async <T>(fn: () => Promise<T>) => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof RequestError) throw new HttpError(err.status, err.message);
      throw err;
    }
  };

  app.post(
    '/api/requests/upload',
    { preHandler: requireUser, config: strictLimit },
    async (req) => {
      const b = body(createUploadRequestSchema, req);
      const ipHash = await guardWrite(ctx, req, b.turnstileToken, { turnstile: true });
      // Guests can mint new accounts by clearing cookies, so requests are also capped per IP.
      await limit(ctx, `req-ip:${ipHash}`, 6, 3600);
      return wrap(() => svc.createUpload(req.user!.id, ipHash, b));
    },
  );

  app.post(
    '/api/requests/:id/confirm',
    { preHandler: requireUser, config: strictLimit },
    async (req) => {
      const { id } = params(idParams, req);
      return { request: await wrap(() => svc.confirmUpload(req.user!.id, id)) };
    },
  );

  app.post('/api/requests/url', { preHandler: requireUser, config: strictLimit }, async (req) => {
    const b = body(createUrlRequestSchema, req);
    const ipHash = await guardWrite(ctx, req, b.turnstileToken, { turnstile: true });
    await limit(ctx, `req-ip:${ipHash}`, 6, 3600);
    return { request: await wrap(() => svc.createFromUrl(req.user!.id, ipHash, b)) };
  });

  app.delete('/api/requests/:id', { preHandler: requireUser }, async (req) => {
    const { id } = params(idParams, req);
    return { request: await wrap(() => svc.withdraw(req.user!.id, id)) };
  });

  app.get('/api/requests/mine', { preHandler: requireUser }, async (req) => ({
    requests: await svc.mine(req.user!.id),
  }));

  app.get('/api/requests/:id', async (req, reply) => {
    const { id } = params(idParams, req);
    const request = await publicRequestById(ctx.db, id);
    if (!request || request.status === 'pending_upload')
      return reply.status(404).send({ error: 'Not found' });
    return { request };
  });
}
