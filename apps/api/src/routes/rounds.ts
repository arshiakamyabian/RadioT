import type { FastifyInstance } from 'fastify';
import { voteBodySchema } from '@radiot/shared';
import type { AppContext } from '../context.js';
import { VoteError, type Station } from '../services/station.js';
import { verifyTurnstile } from '../services/security.js';
import { HttpError, body, guardWrite, limit, requireUser } from './helpers.js';

export function roundRoutes(app: FastifyInstance, ctx: AppContext, station: Station) {
  app.get('/api/rounds/current', async (req) => ({
    round: await station.roundState(req.user?.id ?? null),
  }));

  app.post(
    '/api/rounds/current/vote',
    { preHandler: requireUser, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req) => {
      const b = body(voteBodySchema, req);
      const ipHash = await guardWrite(ctx, req, undefined, { turnstile: false });
      await limit(ctx, `vote:${req.user!.id}`, 10, 10);
      const round = await station.currentRound();
      // Turnstile only on the first vote per round, so changing your mind stays frictionless.
      const voted = round ? await ctx.redis.sismember(`round:${round.id}:voters`, req.user!.id) : 0;
      if (!voted && !(await verifyTurnstile(ctx.env, b.turnstileToken, req.ip)))
        throw new HttpError(403, 'Please complete the human check.');
      try {
        const res = await station.vote(req.user!.id, b.requestId, ipHash);
        await ctx.redis.sadd(`round:${res.roundId}:voters`, req.user!.id);
        await ctx.redis.expire(`round:${res.roundId}:voters`, 3600);
        return { ok: true, roundId: res.roundId, counts: Object.fromEntries(res.counts) };
      } catch (err) {
        if (err instanceof VoteError) throw new HttpError(err.status, err.message);
        throw err;
      }
    },
  );
}
