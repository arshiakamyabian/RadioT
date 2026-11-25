import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, desc, eq, inArray, isNotNull, schema, sql } from '@radiot/db';
import { handleSchema, profileUpdateSchema } from '@radiot/shared';
import type { AppContext } from '../context.js';
import { toPublicRequests } from '../services/requests-view.js';
import { getRole, publicUsers } from '../services/users.js';
import { HttpError, body, params, requireUser } from './helpers.js';

export function profileRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  opts: { googleEnabled: boolean; pushKey: string | null; turnstileSiteKeyRequired: boolean },
) {
  app.get('/api/auth-config', async () => ({ google: opts.googleEnabled }));

  app.get('/api/me', { preHandler: requireUser }, async (req) => {
    const profile = await ctx.db.query.profiles.findFirst({
      where: eq(schema.profiles.userId, req.user!.id),
    });
    const pub = (await publicUsers(ctx.db, [req.user!.id])).get(req.user!.id);
    return {
      user: { ...req.user!, ...pub, role: await getRole(ctx.db, req.user!.id) },
      profile: profile ?? null,
    };
  });

  app.patch('/api/me/profile', { preHandler: requireUser }, async (req) => {
    const b = body(profileUpdateSchema, req);
    if (b.handle) {
      const taken = await ctx.db.query.profiles.findFirst({
        where: eq(schema.profiles.handle, b.handle),
      });
      if (taken && taken.userId !== req.user!.id) throw new HttpError(409, 'That handle is taken.');
    }
    const [profile] = await ctx.db
      .insert(schema.profiles)
      .values({ userId: req.user!.id, ...b })
      .onConflictDoUpdate({ target: schema.profiles.userId, set: { ...b, updatedAt: new Date() } })
      .returning();
    return { profile };
  });

  app.get('/api/profiles/:handle', async (req, reply) => {
    const { handle } = params(z.object({ handle: handleSchema }), req);
    const profile = await ctx.db.query.profiles.findFirst({
      where: eq(schema.profiles.handle, handle),
    });
    if (!profile) return reply.status(404).send({ error: 'Not found' });
    const user = (await publicUsers(ctx.db, [profile.userId])).get(profile.userId)!;
    const rows = await ctx.db
      .select()
      .from(schema.requests)
      .where(
        and(
          eq(schema.requests.userId, profile.userId),
          inArray(schema.requests.status, ['ready', 'queued', 'playing', 'played']),
        ),
      )
      .orderBy(desc(schema.requests.createdAt))
      .limit(30);
    const [stats] = await ctx.db
      .select({
        played: sql<number>`count(*) filter (where ${schema.requests.status} = 'played')::int`,
      })
      .from(schema.requests)
      .where(eq(schema.requests.userId, profile.userId));
    return {
      user,
      profile: {
        bio: profile.bio,
        badges: profile.badges,
        createdAt: profile.createdAt.toISOString(),
      },
      requests: await toPublicRequests(ctx.db, rows),
      stats: { played: stats?.played ?? 0 },
    };
  });

  app.get('/api/history', async () => {
    const rows = await ctx.db
      .select()
      .from(schema.requests)
      .where(
        and(
          isNotNull(schema.requests.playedAt),
          inArray(schema.requests.status, ['playing', 'played']),
        ),
      )
      .orderBy(desc(schema.requests.playedAt))
      .limit(50);
    return { requests: await toPublicRequests(ctx.db, rows) };
  });

  app.get('/api/charts/weekly', async () => {
    const rows = await ctx.db.execute<{ request_id: string; votes: number }>(
      sql`select request_id, votes from weekly_chart order by votes desc, played_at desc limit 50`,
    );
    const ids = rows.rows.map((r) => r.request_id);
    const reqs = ids.length
      ? await ctx.db.select().from(schema.requests).where(inArray(schema.requests.id, ids))
      : [];
    const pub = new Map((await toPublicRequests(ctx.db, reqs)).map((r) => [r.id, r]));
    return {
      entries: rows.rows.flatMap((r, i) =>
        pub.get(r.request_id)
          ? [{ rank: i + 1, votes: r.votes, request: pub.get(r.request_id)! }]
          : [],
      ),
    };
  });

  app.get('/api/push/key', async () => ({ publicKey: opts.pushKey }));

  app.post('/api/push/subscribe', { preHandler: requireUser }, async (req) => {
    const b = body(
      z.object({
        endpoint: z.string().url().max(1000),
        keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }),
      }),
      req,
    );
    await ctx.db
      .insert(schema.pushSubscriptions)
      .values({
        userId: req.user!.id,
        endpoint: b.endpoint,
        p256dh: b.keys.p256dh,
        auth: b.keys.auth,
      })
      .onConflictDoUpdate({
        target: schema.pushSubscriptions.endpoint,
        set: { userId: req.user!.id, p256dh: b.keys.p256dh, auth: b.keys.auth },
      });
    return { ok: true };
  });

  app.delete('/api/push/subscribe', { preHandler: requireUser }, async (req) => {
    const b = body(z.object({ endpoint: z.string().url() }), req);
    await ctx.db
      .delete(schema.pushSubscriptions)
      .where(
        and(
          eq(schema.pushSubscriptions.endpoint, b.endpoint),
          eq(schema.pushSubscriptions.userId, req.user!.id),
        ),
      );
    return { ok: true };
  });
}
