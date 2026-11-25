import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { StageError, type Stage } from '../stage/service.js';
import { HttpError, body, ipHashOf } from './helpers.js';

export function stageRoutes(app: FastifyInstance, ctx: AppContext, stage: Stage) {
  app.addContentTypeParser(
    'application/webhook+json',
    { parseAs: 'string' },
    (_req, payload, done) => done(null, payload),
  );

  app.get('/api/stage', async () => ({ enabled: stage.enabled, state: await stage.state() }));

  app.post(
    '/api/stage/token',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req) => {
      const { role } = body(z.object({ role: z.enum(['performer', 'viewer']) }), req);
      try {
        return await stage.token(req.user?.id ?? null, role, ipHashOf(ctx, req));
      } catch (err) {
        if (err instanceof StageError) throw new HttpError(err.status, err.message);
        throw err;
      }
    },
  );

  app.post('/api/livekit/webhook', { config: { rateLimit: false } }, async (req) => {
    try {
      return { result: await stage.webhook(String(req.body ?? ''), req.headers.authorization) };
    } catch (err) {
      if (err instanceof StageError) throw new HttpError(err.status, err.message);
      throw err;
    }
  });
}
