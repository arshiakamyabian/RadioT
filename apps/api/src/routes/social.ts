import type { FastifyInstance } from 'fastify';
import { desc, getSettings, isNull, schema } from '@radiot/db';
import {
  chatSendSchema,
  maskBlockedWords,
  reactionBodySchema,
  reportBodySchema,
  type ChatMessage,
} from '@radiot/shared';
import type { AppContext } from '../context.js';
import { UNKNOWN_USER, activeSanction, publicUsers } from '../services/users.js';
import { HttpError, body, guardWrite, limit, requireUser } from './helpers.js';

export function socialRoutes(app: FastifyInstance, ctx: AppContext) {
  app.post('/api/reactions', { preHandler: requireUser }, async (req) => {
    const { sticker } = body(reactionBodySchema, req);
    await guardWrite(ctx, req, undefined, { turnstile: false });
    await limit(ctx, `react:${req.user!.id}`, 8, 5);
    await ctx.db.insert(schema.reactions).values({ userId: req.user!.id, emoji: sticker });
    ctx.broadcast.toAll('reactions', {
      sticker,
      name: req.user!.name.slice(0, 80),
      userId: req.user!.id,
      at: Date.now(),
    });
    return { ok: true };
  });

  app.get('/api/chat', async () => {
    const rows = await ctx.db
      .select()
      .from(schema.chatMessages)
      .where(isNull(schema.chatMessages.deletedAt))
      .orderBy(desc(schema.chatMessages.createdAt))
      .limit(50);
    const users = await publicUsers(
      ctx.db,
      rows.map((r) => r.userId),
    );
    const messages: ChatMessage[] = rows.reverse().map((r) => ({
      id: r.id,
      body: r.body,
      createdAt: r.createdAt.toISOString(),
      user: users.get(r.userId) ?? UNKNOWN_USER(r.userId),
    }));
    return { messages };
  });

  app.post('/api/chat', { preHandler: requireUser }, async (req) => {
    const b = body(chatSendSchema, req);
    const ipHash = await guardWrite(ctx, req, b.turnstileToken, { turnstile: false });
    if (await activeSanction(ctx.db, 'mute', req.user!.id, ipHash))
      throw new HttpError(403, 'You are muted.');
    const settings = await getSettings(ctx.db);
    if (settings.chatSlowModeSeconds > 0 && ctx.env.NODE_ENV !== 'development') {
      const ok = await ctx.redis.set(
        `chat:slow:${req.user!.id}`,
        '1',
        'EX',
        settings.chatSlowModeSeconds,
        'NX',
      );
      if (!ok)
        throw new HttpError(429, `Slow mode: one message every ${settings.chatSlowModeSeconds}s.`);
    }
    const { text } = maskBlockedWords(b.body, settings.chatBlockedWords);
    const [row] = await ctx.db
      .insert(schema.chatMessages)
      .values({ userId: req.user!.id, body: text })
      .returning();
    const user =
      (await publicUsers(ctx.db, [req.user!.id])).get(req.user!.id) ?? UNKNOWN_USER(req.user!.id);
    const message: ChatMessage = {
      id: row!.id,
      body: row!.body,
      createdAt: row!.createdAt.toISOString(),
      user,
    };
    ctx.broadcast.toAll('chat:message', message);
    return { message };
  });

  app.post(
    '/api/reports',
    { preHandler: requireUser, config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } },
    async (req) => {
      const b = body(reportBodySchema, req);
      await ctx.db.insert(schema.reports).values({
        reporterId: req.user!.id,
        targetKind: b.targetKind,
        targetId: b.targetId,
        targetUserId: b.targetUserId ?? null,
        reason: b.reason,
      });
      return { ok: true };
    },
  );
}
