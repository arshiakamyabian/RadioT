import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  and,
  count,
  desc,
  eq,
  getSettings,
  inArray,
  isNotNull,
  isNull,
  schema,
  upsertSettings,
} from '@radiot/db';
import {
  keyName,
  pairCompatibility,
  planOptionsFromSettings,
  planTransition,
  stationSettingsPatchSchema,
  stationSettingsSchema,
} from '@radiot/shared';
import type { AppContext } from '../context.js';
import type { Station } from '../services/station.js';
import { publicUsers } from '../services/users.js';
import type { Stage } from '../stage/service.js';
import { audit, body, params, requireAdmin } from './helpers.js';

const uuid = z.object({ id: z.string().uuid() });

export function adminRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  station: Station,
  stage: Stage,
  listenerCount: () => number,
) {
  const pre = { preHandler: requireAdmin(ctx) };
  const admin = (req: { user: { id: string } | null }) => req.user!.id;

  app.get('/api/admin/stats', pre, async () => {
    const byStatus = await ctx.db
      .select({ status: schema.requests.status, n: count() })
      .from(schema.requests)
      .groupBy(schema.requests.status);
    const [openReports] = await ctx.db
      .select({ n: count() })
      .from(schema.reports)
      .where(isNull(schema.reports.resolvedAt));
    const [flags] = await ctx.db
      .select({ n: count() })
      .from(schema.voteFlags)
      .where(isNull(schema.voteFlags.reviewedAt));
    const [fallback] = await ctx.db
      .select({ n: count() })
      .from(schema.fallbackTracks)
      .where(eq(schema.fallbackTracks.status, 'ready'));
    return {
      listeners: listenerCount(),
      now: await station.nowPlaying(),
      stage: await stage.state(),
      next: await station.upNext(),
      requests: Object.fromEntries(byStatus.map((r) => [r.status, Number(r.n)])),
      openReports: Number(openReports?.n ?? 0),
      openVoteFlags: Number(flags?.n ?? 0),
      fallbackReady: Number(fallback?.n ?? 0),
    };
  });

  app.post('/api/admin/skip', pre, async (req) => {
    await station.skip();
    await audit(ctx, admin(req), 'skip', null);
    return { ok: true };
  });

  app.post('/api/admin/stage/kill', pre, async (req) => {
    const ended = await stage.killAll();
    await audit(ctx, admin(req), 'stage.kill', null, { ended });
    return { ended };
  });

  app.post('/api/admin/sanctions', pre, async (req) => {
    const b = body(
      z
        .object({
          kind: z.enum(['ban', 'mute']),
          userId: z.string().max(64).optional(),
          ipHash: z.string().max(64).optional(),
          reason: z.string().max(500).default(''),
          minutes: z.number().int().positive().max(525_600).optional(),
        })
        .refine((v) => v.userId || v.ipHash, 'userId or ipHash required'),
      req,
    );
    const [row] = await ctx.db
      .insert(schema.sanctions)
      .values({
        kind: b.kind,
        userId: b.userId ?? null,
        ipHash: b.ipHash ?? null,
        reason: b.reason,
        createdBy: admin(req),
        expiresAt: b.minutes ? new Date(Date.now() + b.minutes * 60_000) : null,
      })
      .returning();
    if (b.kind === 'ban' && b.userId) {
      // A ban also takes the user off stage and out of the vote.
      await stage.killAll('banned').catch(() => 0);
      await ctx.db
        .update(schema.requests)
        .set({ status: 'rejected', rejectReason: 'Account banned' })
        .where(
          and(
            eq(schema.requests.userId, b.userId),
            inArray(schema.requests.status, ['pending_upload', 'ingesting', 'ready']),
          ),
        );
      ctx.broadcast.toAll('queue:update');
    }
    await audit(ctx, admin(req), `sanction.${b.kind}`, b.userId ?? b.ipHash ?? null, {
      reason: b.reason,
      minutes: b.minutes ?? null,
    });
    return { sanction: row };
  });

  app.get('/api/admin/sanctions', pre, async () => {
    const rows = await ctx.db
      .select()
      .from(schema.sanctions)
      .where(isNull(schema.sanctions.liftedAt))
      .orderBy(desc(schema.sanctions.createdAt))
      .limit(200);
    const users = await publicUsers(
      ctx.db,
      rows.flatMap((r) => (r.userId ? [r.userId] : [])),
    );
    return {
      sanctions: rows.map((r) => ({ ...r, user: r.userId ? (users.get(r.userId) ?? null) : null })),
    };
  });

  app.delete('/api/admin/sanctions/:id', pre, async (req) => {
    const { id } = params(uuid, req);
    await ctx.db
      .update(schema.sanctions)
      .set({ liftedAt: new Date() })
      .where(eq(schema.sanctions.id, id));
    await audit(ctx, admin(req), 'sanction.lift', id);
    return { ok: true };
  });

  app.delete('/api/admin/chat/:id', pre, async (req) => {
    const { id } = params(uuid, req);
    await ctx.db
      .update(schema.chatMessages)
      .set({ deletedAt: new Date(), deletedBy: admin(req) })
      .where(eq(schema.chatMessages.id, id));
    ctx.broadcast.toAll('chat:deleted', { id });
    await audit(ctx, admin(req), 'chat.delete', id);
    return { ok: true };
  });

  app.post('/api/admin/requests/:id/reject', pre, async (req) => {
    const { id } = params(uuid, req);
    const { reason } = body(
      z.object({ reason: z.string().max(300).default('Removed by moderator') }),
      req,
    );
    await ctx.db
      .update(schema.requests)
      .set({ status: 'rejected', rejectReason: reason, updatedAt: new Date() })
      .where(eq(schema.requests.id, id));
    ctx.broadcast.toAll('queue:update');
    await audit(ctx, admin(req), 'request.reject', id, { reason });
    return { ok: true };
  });

  app.get('/api/admin/fallback', pre, async () => ({
    tracks: await ctx.db
      .select()
      .from(schema.fallbackTracks)
      .orderBy(desc(schema.fallbackTracks.createdAt)),
  }));

  app.patch('/api/admin/fallback/:id', pre, async (req) => {
    const { id } = params(uuid, req);
    const b = body(
      z.object({
        enabled: z.boolean().optional(),
        title: z.string().max(200).optional(),
        artist: z.string().max(200).optional(),
      }),
      req,
    );
    const [track] = await ctx.db
      .update(schema.fallbackTracks)
      .set(b)
      .where(eq(schema.fallbackTracks.id, id))
      .returning();
    await audit(ctx, admin(req), 'fallback.update', id, b);
    return { track };
  });

  // ---- transition preview -------------------------------------------------------------------
  const playable = async (id: string) =>
    (await ctx.db.query.requests.findFirst({ where: eq(schema.requests.id, id) })) ??
    (await ctx.db.query.fallbackTracks.findFirst({ where: eq(schema.fallbackTracks.id, id) })) ??
    null;
  const mediaUrl = (key: string) => `${ctx.env.MEDIA_BASE_URL.replace(/\/$/, '')}/${key}`;

  /** Every track that can air, with the analysis the planner works from. */
  app.get('/api/admin/transitions/tracks', pre, async () => {
    const uploads = await ctx.db
      .select()
      .from(schema.requests)
      .where(
        and(
          isNotNull(schema.requests.storageKey),
          inArray(schema.requests.status, ['ready', 'queued', 'playing', 'played', 'expired']),
        ),
      )
      .orderBy(desc(schema.requests.createdAt))
      .limit(300);
    const fallback = await ctx.db
      .select()
      .from(schema.fallbackTracks)
      .where(
        and(eq(schema.fallbackTracks.status, 'ready'), isNotNull(schema.fallbackTracks.storageKey)),
      );
    const row = (t: (typeof uploads)[number] | (typeof fallback)[number], kind: string) => ({
      id: t.id,
      kind,
      title: t.title || 'Untitled',
      artist: t.artist,
      durationMs: t.durationMs,
      analyzed: !!t.features,
      bpm: t.features?.bpm ?? null,
      key: t.features?.key ? keyName(t.features.key.tonic, t.features.key.mode) : null,
      camelot: t.features?.key?.camelot ?? null,
      energy: t.features?.energy ?? null,
      intro: t.features?.intro.type ?? null,
      outro: t.features?.outro.type ?? null,
    });
    return {
      tracks: [...uploads.map((t) => row(t, 'upload')), ...fallback.map((t) => row(t, 'fallback'))],
    };
  });

  /**
   * Plans (and renders, if needed) the transition between any two tracks. Poll until
   * `status` is "ready". `options` overrides the saved settings for this preview only.
   */
  app.post('/api/admin/transitions/preview', pre, async (req) => {
    const input = body(
      z.object({
        fromId: z.string().uuid(),
        toId: z.string().uuid(),
        options: stationSettingsPatchSchema.optional(),
      }),
      req,
    );
    const [a, b] = await Promise.all([playable(input.fromId), playable(input.toId)]);
    if (!a?.storageKey || !b?.storageKey || a.id === b.id) {
      return {
        status: 'unavailable' as const,
        reason: 'Pick two different tracks that are ready.',
      };
    }
    const settings = stationSettingsSchema.parse({
      ...(await getSettings(ctx.db)),
      ...input.options,
    });
    const options = planOptionsFromSettings(settings);
    const pa = station.planTrackOf(a);
    const pb = station.planTrackOf(b);
    const plan = planTransition(pa, pb, options);
    const compat = pairCompatibility(pa, pb, options.tempoTolerancePct);
    const base = {
      plan: {
        style: plan.style,
        reasons: plan.reasons,
        overlapMs: Math.round(plan.overlapMs),
        beats: plan.sync?.beats ?? null,
      },
      compat,
      fromUrl: mediaUrl(a.storageKey),
      toUrl: mediaUrl(b.storageKey),
    };
    if (!a.features || !b.features) {
      return {
        ...base,
        status: 'unavailable' as const,
        reason: 'One of the tracks is still being analysed.',
      };
    }
    const row = await station.ensureTransition(a, b, plan);
    if (!row) return { ...base, status: 'failed' as const, reason: 'Could not start the render.' };
    return {
      ...base,
      status: row.status,
      reason: row.error,
      clipUrl: row.status === 'ready' && row.clipKey ? mediaUrl(row.clipKey) : null,
      clip: row.clip,
      metrics: row.metrics,
    };
  });

  app.get('/api/admin/settings', pre, async () => ({ settings: await getSettings(ctx.db) }));

  app.patch('/api/admin/settings', pre, async (req) => {
    const patch = body(stationSettingsPatchSchema, req);
    const settings = await upsertSettings(ctx.db, patch);
    await audit(ctx, admin(req), 'settings.update', null, patch);
    return { settings };
  });

  app.get('/api/admin/reports', pre, async () => {
    const rows = await ctx.db
      .select()
      .from(schema.reports)
      .where(isNull(schema.reports.resolvedAt))
      .orderBy(desc(schema.reports.createdAt))
      .limit(200);
    const users = await publicUsers(
      ctx.db,
      rows.flatMap((r) => [r.reporterId, ...(r.targetUserId ? [r.targetUserId] : [])]),
    );
    return {
      reports: rows.map((r) => ({
        ...r,
        reporter: users.get(r.reporterId) ?? null,
        targetUser: r.targetUserId ? (users.get(r.targetUserId) ?? null) : null,
      })),
    };
  });

  app.post('/api/admin/reports/:id/resolve', pre, async (req) => {
    const { id } = params(uuid, req);
    await ctx.db
      .update(schema.reports)
      .set({ resolvedAt: new Date(), resolvedBy: admin(req) })
      .where(eq(schema.reports.id, id));
    await audit(ctx, admin(req), 'report.resolve', id);
    return { ok: true };
  });

  app.get('/api/admin/vote-flags', pre, async () => {
    const rows = await ctx.db
      .select()
      .from(schema.voteFlags)
      .where(isNull(schema.voteFlags.reviewedAt))
      .orderBy(desc(schema.voteFlags.createdAt))
      .limit(200);
    const users = await publicUsers(
      ctx.db,
      rows.flatMap((r) => r.userIds),
    );
    return {
      flags: rows.map((r) => ({
        ...r,
        users: r.userIds.map(
          (u) => users.get(u) ?? { id: u, name: 'Unknown', handle: null, avatarUrl: null },
        ),
      })),
    };
  });

  app.post('/api/admin/vote-flags/:id/review', pre, async (req) => {
    const { id } = params(uuid, req);
    await ctx.db
      .update(schema.voteFlags)
      .set({ reviewedAt: new Date() })
      .where(eq(schema.voteFlags.id, id));
    await audit(ctx, admin(req), 'vote_flag.review', id);
    return { ok: true };
  });

  app.get('/api/admin/mic-violations', pre, async () => ({
    violations: await ctx.db
      .select()
      .from(schema.micViolations)
      .orderBy(desc(schema.micViolations.createdAt))
      .limit(100),
  }));

  app.get('/api/admin/audit', pre, async () => {
    const rows = await ctx.db
      .select()
      .from(schema.adminActions)
      .orderBy(desc(schema.adminActions.createdAt))
      .limit(300);
    const users = await publicUsers(
      ctx.db,
      rows.flatMap((r) => (r.adminId ? [r.adminId] : [])),
    );
    return {
      actions: rows.map((r) => ({
        ...r,
        admin: r.adminId ? (users.get(r.adminId) ?? null) : null,
      })),
    };
  });

  app.post('/api/admin/dmca', pre, async (req) => {
    const { requestId, reason } = body(
      z.object({ requestId: z.string().uuid(), reason: z.string().min(3).max(500) }),
      req,
    );
    const r = await ctx.db.query.requests.findFirst({ where: eq(schema.requests.id, requestId) });
    if (!r?.fingerprint) return { ok: false, error: 'Request has no fingerprint' };
    await ctx.db
      .insert(schema.dmcaBlocklist)
      .values({ fingerprint: r.fingerprint, title: `${r.artist} – ${r.title}`, reason });
    await ctx.db
      .update(schema.requests)
      .set({ status: 'rejected', rejectReason: 'Blocked following a copyright notice.' })
      .where(eq(schema.requests.id, requestId));
    await audit(ctx, admin(req), 'dmca.block', requestId, { reason });
    ctx.broadcast.toAll('queue:update');
    return { ok: true };
  });
}
