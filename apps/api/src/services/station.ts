import {
  and,
  asc,
  count,
  desc,
  eq,
  getSettings,
  inArray,
  isNotNull,
  ne,
  schema,
  sql,
  type Database,
} from '@radiot/db';
import {
  ROOMS,
  aiExitPoint,
  airtimeMs,
  earliestMixMs,
  nowPlayingSchema,
  orderForFlow,
  planAirtimeMs,
  planOptionsFromSettings,
  planTransition,
  trackMedia,
  upNextSchema,
  type NowPlaying,
  type RadioState,
  type RequestPublic,
  type PlanTrack,
  type RoundState,
  type StationSettings,
  type TransitionPlan,
  type UpNext,
  type UpNextTransition,
} from '@radiot/shared';
import { z } from 'zod';
import type { Broadcaster, MediaDispatcher } from '../context.js';
import type { Env } from '../env.js';
import type { Notifier } from './notify.js';
import { inRotation, publicRequestById, toPublicRequests } from './requests-view.js';
import {
  computeLockAt,
  detectVoteFlags,
  expiringAfterRound,
  pickRoundWinner,
} from './rounds-logic.js';
import { publicUsers } from './users.js';
import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';

const NOW_KEY = 'radio:now';
const NEXT_KEY = 'radio:next';
const READY_KEY = 'radio:fallback:served';
const TICK_LOCK = 'radio:tick';
const EMPTY_KEY = 'radio:empty';
const DUE_KEY = 'radio:due';
// A transition that runs within this window of its scheduled time keeps the scheduled start, so
// listeners who already crossfaded locally stay on the shared timeline.
const SEAMLESS_GRACE_MS = 120_000;
const LOCAL_DUE_MAX_MS = 3000;

/**
 * Bounds for the station's transactions. On Vercel an instance can be frozen mid-transaction (no
 * request in flight); its open transaction then held the round's row lock and every later tick
 * waited on it, freezing the station. With these, Postgres ends such a transaction after a short
 * idle spell and waiters give up instead of hanging. SET LOCAL also works through a pooler.
 */
async function boundTransaction(tx: { execute: Database['execute'] }) {
  await tx.execute(sql`select set_config('lock_timeout', '5s', true),
    set_config('statement_timeout', '15s', true),
    set_config('idle_in_transaction_session_timeout', '20s', true)`);
}

type Choice = { kind: 'fallback' | 'request' | 'replay'; id: string };
const pendingSchema = z.object({
  kind: z.enum(['fallback', 'request', 'replay']),
  id: z.string(),
  upNext: upNextSchema,
  // The clip being rendered for this hand-over, and what is needed to announce it when ready.
  transitionId: z.string().optional(),
  clipOriginMs: z.number().optional(),
});

// The clip opens with a few seconds of the current track alone (the renderer's lead-in);
// voting has to be closed before that, plus the lock lead.
const CLIP_LEAD_IN_MS = 4000;
// Bump to re-render every cached clip after a change to the renderer.
const RENDER_VERSION = 1;

type TrackRow = typeof schema.fallbackTracks.$inferSelect | typeof schema.requests.$inferSelect;

const planTrackOf = (t: TrackRow): PlanTrack => ({
  cueInMs: t.cueInMs ?? 0,
  cueOutMs: t.cueOutMs ?? t.durationMs ?? 0,
  crossfadeDurationMs: t.crossfadeDurationMs,
  features: t.features,
  ai: t.ai,
});

export class VoteError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface StationDeps {
  env: Env;
  db: Database;
  redis: Redis;
  broadcast: Broadcaster;
  notify: Notifier;
  media: MediaDispatcher;
  log: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };
}

export function createStation(deps: StationDeps) {
  const { db, redis, broadcast, env } = deps;

  async function nowPlaying(): Promise<NowPlaying | null> {
    const raw = await redis.get(NOW_KEY);
    if (!raw) return null;
    const parsed = nowPlayingSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  }

  async function currentRound() {
    return (await db.query.rounds.findFirst({ orderBy: desc(schema.rounds.startedAt) })) ?? null;
  }

  async function trackFor(c: Choice) {
    return c.kind === 'fallback'
      ? ((await db.query.fallbackTracks.findFirst({ where: eq(schema.fallbackTracks.id, c.id) })) ??
          null)
      : ((await db.query.requests.findFirst({ where: eq(schema.requests.id, c.id) })) ?? null);
  }

  /** The row of the track that is on air (or null between tracks). */
  async function currentTrack(): Promise<TrackRow | null> {
    const now = await nowPlaying();
    if (!now?.trackId) return null;
    return trackFor({ kind: now.kind === 'fallback' ? 'fallback' : 'request', id: now.trackId });
  }

  const withPlan = <T extends TrackRow>(row: T) => {
    const last = 'lastPlayedAt' in row ? row.lastPlayedAt : row.playedAt;
    return {
      ...planTrackOf(row),
      row,
      waitedMs: last ? Date.now() - last.getTime() : Infinity,
    };
  };

  /** Looping uploads, least recently played first, optionally without the track on air. */
  async function rotationRows(exec: Pick<Database, 'select'>, exceptId: string | null) {
    return exec
      .select()
      .from(schema.requests)
      .where(and(inRotation(), exceptId ? ne(schema.requests.id, exceptId) : undefined))
      .orderBy(sql`${schema.requests.playedAt} asc nulls first`)
      .limit(200);
  }

  /**
   * What airs after the current track: a stranded vote winner, then (only when nothing is on air)
   * the oldest ready request, then the least-recently-played track of the rotation.
   */
  async function chooseNext(idle: boolean): Promise<Choice | null> {
    const settings = await getSettings(db);
    const [queued] = await db
      .select({ id: schema.requests.id })
      .from(schema.requests)
      .where(and(eq(schema.requests.status, 'queued'), isNotNull(schema.requests.storageKey)))
      .orderBy(asc(schema.requests.updatedAt))
      .limit(1);
    if (queued) return { kind: 'request', id: queued.id };

    // Nothing on air (empty rotation, or just started): a ready request plays straight away
    // instead of waiting for a vote that has no round to happen in.
    if (idle) {
      const [next] = await db
        .select()
        .from(schema.requests)
        .where(and(eq(schema.requests.status, 'ready'), isNotNull(schema.requests.storageKey)))
        .orderBy(asc(schema.requests.createdAt))
        .limit(1);
      if (next) {
        await db
          .update(schema.requests)
          .set({ status: 'queued', updatedAt: new Date() })
          .where(eq(schema.requests.id, next.id));
        broadcast.toAll('queue:update');
        return { kind: 'request', id: next.id };
      }
    }

    // Rotation = uploads; fallback tracks only fill in while nobody has uploaded. Within the
    // few longest-waiting tracks the best follow-up to what is on air (tempo, key, energy) goes
    // first, so the station flows without anyone waiting noticeably longer.
    const lastServed = await redis.get(READY_KEY);
    const current = await currentTrack();
    const uploads = await rotationRows(db, null);
    // A single upload repeats rather than handing airtime back to the fallback.
    const rp =
      orderForFlow(
        current && planTrackOf(current),
        uploads.filter((u) => u.id !== lastServed).map(withPlan),
      )[0]?.row ?? uploads[0];
    let fb: typeof schema.fallbackTracks.$inferSelect | undefined;
    if (!rp) {
      const shuffle = settings.fallbackShuffle ? sql`random()` : sql`1`;
      const rows = await db
        .select()
        .from(schema.fallbackTracks)
        .where(
          and(
            eq(schema.fallbackTracks.status, 'ready'),
            eq(schema.fallbackTracks.enabled, true),
            isNotNull(schema.fallbackTracks.storageKey),
            lastServed ? ne(schema.fallbackTracks.id, lastServed) : undefined,
          ),
        )
        .orderBy(sql`${schema.fallbackTracks.lastPlayedAt} asc nulls first`, shuffle)
        .limit(50);
      fb = orderForFlow(current && planTrackOf(current), rows.map(withPlan))[0]?.row;
    }

    if (rp) {
      // Marked as served at selection (not when it airs) so consecutive picks never repeat.
      await db
        .update(schema.requests)
        .set({ playedAt: new Date() })
        .where(eq(schema.requests.id, rp.id));
      await redis.set(READY_KEY, rp.id, 'EX', 3600);
      return { kind: 'replay', id: rp.id };
    }
    if (fb) {
      await db
        .update(schema.fallbackTracks)
        .set({ lastPlayedAt: new Date() })
        .where(eq(schema.fallbackTracks.id, fb.id));
      await redis.set(READY_KEY, fb.id, 'EX', 3600);
      return { kind: 'fallback', id: fb.id };
    }
    // Only one track in rotation: repeat it rather than go silent.
    if (lastServed) {
      await redis.del(READY_KEY);
      return chooseNext(idle);
    }
    return null;
  }

  /** What players and the stream engine need to play `track`, including where its mix may begin. */
  function mediaOf(track: TrackRow, settings: StationSettings) {
    const planned = earliestMixMs(planTrackOf(track), planOptionsFromSettings(settings));
    return trackMedia(
      track,
      env.MEDIA_BASE_URL,
      settings.crossfadeDefaultMs,
      Math.max(track.cueInMs ?? 0, Math.round(planned - CLIP_LEAD_IN_MS)),
    );
  }

  async function upNext(): Promise<UpNext | null> {
    const raw = await redis.get(NEXT_KEY);
    if (!raw) return null;
    const parsed = pendingSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data.upNext : null;
  }

  function clipInfo(
    row: typeof schema.transitions.$inferSelect,
    clipOriginMs: number,
  ): UpNextTransition | null {
    if (row.status !== 'ready' || !row.clip || !row.clipKey) return null;
    return {
      ...row.clip,
      style: row.plan.style,
      clipUrl: `${env.MEDIA_BASE_URL.replace(/\/$/, '')}/${row.clipKey}`,
      clipStartsAt: new Date(clipOriginMs + row.clip.aFileStartMs).toISOString(),
    };
  }

  /**
   * The cached clip for this pair under this plan, rendering it if it does not exist yet.
   * Clips are best effort: until one is ready, players use the plain crossfade.
   */
  async function ensureTransition(a: TrackRow, b: TrackRow, plan: TransitionPlan) {
    const planHash = createHash('sha1')
      .update(JSON.stringify([RENDER_VERSION, plan, a.gainDb, b.gainDb]))
      .digest('hex')
      .slice(0, 20);
    const where = and(
      eq(schema.transitions.fromId, a.id),
      eq(schema.transitions.toId, b.id),
      eq(schema.transitions.planHash, planHash),
    );
    let row = await db.query.transitions.findFirst({ where });
    const stale =
      row && row.status !== 'ready' && Date.now() - row.updatedAt.getTime() > 3 * 60_000;
    if (!row || stale) {
      if (!row) {
        [row] = await db
          .insert(schema.transitions)
          .values({ fromId: a.id, toId: b.id, planHash, plan })
          .onConflictDoNothing()
          .returning();
        row ??= await db.query.transitions.findFirst({ where });
      } else {
        await db
          .update(schema.transitions)
          .set({ status: 'rendering', error: null, updatedAt: new Date() })
          .where(eq(schema.transitions.id, row.id));
      }
      if (row) {
        await deps.media
          .dispatch({ kind: 'transition', id: row.id })
          .catch((err: Error) => deps.log.warn({ err: err.message }, 'transition dispatch failed'));
      }
    }
    return row ?? null;
  }

  /**
   * Plans the hand-over from the track on air to `choice`, fixes when the next track starts
   * (which depends on the pair) and announces it so listeners can prebuffer.
   */
  async function scheduleNext(round: typeof schema.rounds.$inferSelect, choice: Choice) {
    const settings = await getSettings(db);
    const track = await trackFor(choice);
    if (!track?.storageKey) return null;
    const currentId = round.requestId ?? round.fallbackTrackId;
    const current = currentId
      ? await trackFor({ kind: round.fallbackTrackId ? 'fallback' : 'request', id: currentId })
      : null;

    let durationMs = round.durationMs;
    let fadeMs: number | undefined;
    let transition: UpNextTransition | null = null;
    let transitionId: string | undefined;
    const clipOriginMs = round.startedAt.getTime() - (current?.cueInMs ?? 0);
    if (current?.storageKey && current.id !== track.id) {
      const a = planTrackOf(current);
      const b = planTrackOf(track);
      const plan = planTransition(a, b, planOptionsFromSettings(settings));
      durationMs = Math.round(planAirtimeMs(a, b, plan));
      fadeMs = Math.round(plan.fallbackCrossfadeMs);
      if (settings.transitionMode !== 'simple' && current.features && track.features) {
        const row = await ensureTransition(current, track, plan);
        if (row) {
          transitionId = row.id;
          transition = clipInfo(row, clipOriginMs);
        }
      }
      await db.update(schema.rounds).set({ durationMs }).where(eq(schema.rounds.id, round.id));
      deps.log.info(
        {
          roundId: round.id,
          style: plan.style,
          overlapMs: Math.round(plan.overlapMs),
          clip: !!transition,
          why: plan.reasons,
        },
        'transition planned',
      );
    }

    const upNextValue: UpNext = {
      kind: choice.kind,
      trackId: track.id,
      title: track.title,
      artist: track.artist,
      artworkUrl: 'artworkUrl' in track ? track.artworkUrl : null,
      startsAt: new Date(round.startedAt.getTime() + durationMs).toISOString(),
      media: mediaOf(track, settings),
      fadeMs,
      transition,
    };
    await redis.set(
      NEXT_KEY,
      JSON.stringify({ ...choice, upNext: upNextValue, transitionId, clipOriginMs }),
      'EX',
      6 * 3600,
    );
    broadcast.toAll('radio:next', upNextValue);
    return upNextValue;
  }

  /** The worker finished a clip: if it is for the announced hand-over, tell the players. */
  async function onTransitionReady(transitionId: string) {
    const raw = await redis.get(NEXT_KEY);
    const pending = raw ? pendingSchema.safeParse(JSON.parse(raw)) : null;
    if (!pending?.success || pending.data.transitionId !== transitionId) return;
    const row = await db.query.transitions.findFirst({
      where: eq(schema.transitions.id, transitionId),
    });
    const transition = row && clipInfo(row, pending.data.clipOriginMs ?? 0);
    if (!transition) return;
    const upNextValue: UpNext = { ...pending.data.upNext, transition };
    await redis.set(NEXT_KEY, JSON.stringify({ ...pending.data, upNext: upNextValue }), 'KEEPTTL');
    broadcast.toAll('radio:next', upNextValue);
  }

  /**
   * Renders the clip for the most likely next track ahead of time (the vote can still change
   * it; clips are cached per pair, so nothing is wasted when the same pair comes around again).
   */
  async function prewarm() {
    try {
      const settings = await getSettings(db);
      if (settings.transitionMode === 'simple') return;
      const round = await currentRound();
      const current = await currentTrack();
      if (!round || round.status !== 'open' || !current?.features) return;
      const fresh = await db
        .select()
        .from(schema.requests)
        .where(eq(schema.requests.status, 'ready'));
      const rotation = await rotationCandidates();
      const picked = pickRoundWinner(fresh, rotation, await voteCounts(round.id));
      let next: TrackRow | undefined = picked?.winner ?? rotation[0];
      if (!next) {
        // No uploads: the fallback playlist is next (same order chooseNext will use, minus shuffle).
        const rows = await db
          .select()
          .from(schema.fallbackTracks)
          .where(
            and(
              eq(schema.fallbackTracks.status, 'ready'),
              eq(schema.fallbackTracks.enabled, true),
              isNotNull(schema.fallbackTracks.storageKey),
              ne(schema.fallbackTracks.id, current.id),
            ),
          )
          .orderBy(sql`${schema.fallbackTracks.lastPlayedAt} asc nulls first`)
          .limit(50);
        next = orderForFlow(planTrackOf(current), rows.map(withPlan))[0]?.row;
      }
      if (!next?.features || !next.storageKey || next.id === current.id) return;
      const plan = planTransition(
        planTrackOf(current),
        planTrackOf(next),
        planOptionsFromSettings(settings),
      );
      await ensureTransition(current, next, plan);
    } catch (err) {
      deps.log.warn({ err: (err as Error).message }, 'transition prewarm failed');
    }
  }

  /** The announced next track, if it is still allowed to air. */
  async function takeScheduled(): Promise<Choice | null> {
    const raw = await redis.get(NEXT_KEY);
    await redis.del(NEXT_KEY);
    if (!raw) return null;
    const parsed = pendingSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    const { kind, id } = parsed.data;
    const track = await trackFor({ kind, id });
    if (!track?.storageKey) return null;
    if (kind === 'fallback') {
      const fb = track as typeof schema.fallbackTracks.$inferSelect;
      return fb.enabled && fb.status === 'ready' ? { kind, id } : null;
    }
    const status = (track as typeof schema.requests.$inferSelect).status;
    if (kind === 'request' && status !== 'queued') return null;
    if (kind === 'replay') {
      const [ok] = await db
        .select({ id: schema.requests.id })
        .from(schema.requests)
        .where(and(eq(schema.requests.id, id), inRotation()));
      if (!ok) return null;
    }
    return { kind, id };
  }

  async function publishRoundState() {
    broadcast.toAll('queue:update');
  }

  const trackStartHooks: ((startedAt: Date) => Promise<unknown>)[] = [];

  /** Puts `choice` (or silence, when null) on air at `startedAt` and opens its voting round. */
  async function startTrack(choice: Choice | null, startedAt: Date) {
    const settings = await getSettings(db);
    const evt = { kind: choice?.kind ?? ('unknown' as const), title: '', artist: '' };
    const trackId = choice?.id ?? null;
    let now: NowPlaying;
    let roundId: string | null = null;
    let liveRequest: Awaited<ReturnType<typeof publicRequestById>> = null;

    await db.transaction(async (tx) => {
      await boundTransaction(tx);
      await tx
        .update(schema.rounds)
        .set({ status: 'closed', endedAt: startedAt })
        .where(ne(schema.rounds.status, 'closed'));
      await tx
        .update(schema.requests)
        .set({ status: 'played', updatedAt: startedAt })
        .where(eq(schema.requests.status, 'playing'));

      const fallback =
        evt.kind === 'fallback' && trackId
          ? await tx.query.fallbackTracks.findFirst({
              where: eq(schema.fallbackTracks.id, trackId),
            })
          : null;
      const request =
        evt.kind === 'request' && trackId
          ? await tx.query.requests.findFirst({ where: eq(schema.requests.id, trackId) })
          : null;
      // A replay is an upload that already aired coming back around in the rotation: credit the
      // requester, but leave its status as 'played'.
      const replay =
        evt.kind === 'replay' && trackId
          ? await tx.query.requests.findFirst({ where: eq(schema.requests.id, trackId) })
          : null;
      const credited = request ?? replay;
      const track = fallback ?? credited;

      if (request) {
        await tx
          .update(schema.requests)
          .set({ status: 'playing', playedAt: startedAt, updatedAt: startedAt })
          .where(eq(schema.requests.id, request.id));
      }
      if (fallback) {
        await tx
          .update(schema.fallbackTracks)
          .set({ playCount: sql`${schema.fallbackTracks.playCount} + 1` })
          .where(eq(schema.fallbackTracks.id, fallback.id));
      }

      if (track) {
        const airtime = airtimeMs(track);
        // Voting closes before the earliest moment the next track could start mixing in. With
        // the AI analysis that moment is the song's own exit point (independent of what wins),
        // so the lead can be a few seconds; the heavy work (stems, beats, structure) was done at
        // import and the likely winner's clip is pre-rendered, leaving only a quick mix.
        const planOpts = planOptionsFromSettings(settings);
        const aiExit =
          planOpts.mode === 'auto' ? aiExitPoint(planTrackOf(track), planOpts.maxSeconds) : null;
        const mixFrom =
          earliestMixMs(planTrackOf(track), planOpts) - (track.cueInMs ?? 0) - CLIP_LEAD_IN_MS;
        const lockLead = aiExit ? settings.aiLockLeadSeconds : settings.lockLeadSeconds;
        const [round] = await tx
          .insert(schema.rounds)
          .values({
            requestId: credited?.id ?? null,
            fallbackTrackId: fallback?.id ?? null,
            title: track.title,
            artist: track.artist,
            durationMs: airtime,
            startedAt,
            lockAt: computeLockAt(startedAt, Math.max(0, mixFrom), lockLead),
          })
          .returning();
        roundId = round!.id;
      }

      const requester = credited
        ? ((await publicUsers(tx as unknown as Database, [credited.userId])).get(credited.userId) ??
          null)
        : null;
      now = {
        kind: track ? evt.kind : 'unknown',
        trackId: track?.id ?? null,
        roundId,
        title: track?.title || evt.title || 'RadioT',
        artist: track?.artist || evt.artist || '',
        artworkUrl: credited?.artworkUrl ?? null,
        durationMs: track ? airtimeMs(track) : 0,
        startedAt: startedAt.toISOString(),
        requester,
        media: track ? mediaOf(track, settings) : null,
      };
    });

    if (evt.kind === 'request' && trackId) liveRequest = await publicRequestById(db, trackId);
    await redis.set(NOW_KEY, JSON.stringify(now!));
    broadcast.toAll('radio:now', now!);
    broadcast.toAll('stage:state', { live: false, performer: null, roundId });
    await publishRoundState();
    if (liveRequest) await deps.notify.request('live', liveRequest);
    for (const hook of trackStartHooks) await hook(startedAt);
    void prewarm();
    deps.log.info({ kind: now!.kind, title: now!.title, roundId }, 'track started');
    return now!;
  }

  async function voteCounts(roundId: string) {
    const rows = await db
      .select({ requestId: schema.votes.requestId, n: count() })
      .from(schema.votes)
      .where(eq(schema.votes.roundId, roundId))
      .groupBy(schema.votes.requestId);
    return new Map(rows.map((r) => [r.requestId, Number(r.n)]));
  }

  /**
   * Rotation songs open to the vote, in the order they would come back: everything looping
   * except the track on air right now.
   */
  async function rotationCandidates(exec: Pick<Database, 'select'> = db) {
    const current = await currentTrack();
    const rows = await rotationRows(exec, current?.id ?? null);
    return orderForFlow(current && planTrackOf(current), rows.map(withPlan)).map((r) => r.row);
  }

  async function roundState(userId: string | null): Promise<RoundState> {
    const round = await currentRound();
    const candidatesRows = await db
      .select()
      .from(schema.requests)
      .where(eq(schema.requests.status, 'ready'))
      .orderBy(asc(schema.requests.createdAt));
    const counts = round ? await voteCounts(round.id) : new Map<string, number>();
    const withVotes = (rows: RequestPublic[]) =>
      rows.map((c) => ({ ...c, votes: counts.get(c.id) ?? 0 }));
    const candidates = withVotes(await toPublicRequests(db, candidatesRows));
    const rotation = withVotes(await toPublicRequests(db, await rotationCandidates()));
    let myVote: string | null = null;
    if (round && userId) {
      const v = await db.query.votes.findFirst({
        where: and(eq(schema.votes.roundId, round.id), eq(schema.votes.userId, userId)),
      });
      myVote = v?.requestId ?? null;
    }
    return {
      roundId: round?.id ?? null,
      status: round?.status ?? null,
      lockAt: round?.lockAt.toISOString() ?? null,
      candidates,
      rotation,
      myVote,
      winnerRequestId: round?.winnerRequestId ?? null,
    };
  }

  async function vote(userId: string, requestId: string, ipHash: string) {
    const round = await currentRound();
    if (!round || round.status !== 'open' || round.lockAt.getTime() <= Date.now()) {
      throw new VoteError('Voting for this round is closed', 409);
    }
    const req = await db.query.requests.findFirst({
      where: eq(schema.requests.id, requestId),
      columns: { status: true },
    });
    const votable =
      req?.status === 'ready' || (await rotationCandidates()).some((r) => r.id === requestId);
    if (!votable) throw new VoteError('That song is not in this vote', 400);
    const existing = await db.query.votes.findFirst({
      where: and(eq(schema.votes.roundId, round.id), eq(schema.votes.userId, userId)),
    });
    await db
      .insert(schema.votes)
      .values({ roundId: round.id, userId, requestId, ipHash })
      .onConflictDoUpdate({
        target: [schema.votes.roundId, schema.votes.userId],
        set: { requestId, ipHash, updatedAt: new Date() },
      });
    const counts = await voteCounts(round.id);
    broadcast.toAll('round:update', { roundId: round.id, counts: Object.fromEntries(counts) });
    if (await redis.set('radio:prewarm', '1', 'EX', 10, 'NX')) void prewarm();
    return { roundId: round.id, firstVote: !existing, counts };
  }

  /** Runs once per round (guarded by the status flip). Snapshots votes and announces what plays next. */
  async function lockRound(roundId: string) {
    const settings = await getSettings(db);
    const result = await db.transaction(async (tx) => {
      await boundTransaction(tx);
      const [round] = await tx
        .update(schema.rounds)
        .set({ status: 'locked', lockedAt: new Date() })
        .where(and(eq(schema.rounds.id, roundId), eq(schema.rounds.status, 'open')))
        .returning();
      if (!round) return null;
      const candidates = await tx
        .select()
        .from(schema.requests)
        .where(eq(schema.requests.status, 'ready'))
        .for('update');
      const rotation = await rotationCandidates(tx);
      const votes = await tx.select().from(schema.votes).where(eq(schema.votes.roundId, roundId));
      const counts = new Map<string, number>();
      for (const v of votes) counts.set(v.requestId, (counts.get(v.requestId) ?? 0) + 1);
      const picked = pickRoundWinner(candidates, rotation, counts);
      const winner = picked?.winner ?? null;
      const fromRotation = picked?.fromRotation ?? false;
      const losers = candidates.filter((c) => c.id !== winner?.id);
      const expiring = expiringAfterRound(losers, settings.roundExpiryCount);

      if (winner) {
        // A rotation winner keeps its 'played' status and airs as a replay; stamping playedAt
        // sends it to the back of the loop, as if the rotation had picked it.
        await tx
          .update(schema.requests)
          .set(
            fromRotation ? { playedAt: new Date() } : { status: 'queued', updatedAt: new Date() },
          )
          .where(eq(schema.requests.id, winner.id));
        await tx
          .update(schema.rounds)
          .set({ winnerRequestId: winner.id })
          .where(eq(schema.rounds.id, roundId));
      }
      if (losers.length) {
        await tx
          .update(schema.requests)
          .set({ roundsWaited: sql`${schema.requests.roundsWaited} + 1`, updatedAt: new Date() })
          .where(
            inArray(
              schema.requests.id,
              losers.map((l) => l.id),
            ),
          );
      }
      if (expiring.length) {
        await tx
          .update(schema.requests)
          .set({ status: 'expired', updatedAt: new Date() })
          .where(
            inArray(
              schema.requests.id,
              expiring.map((e) => e.id),
            ),
          );
      }
      const flags = detectVoteFlags(votes);
      if (flags.length)
        await tx.insert(schema.voteFlags).values(flags.map((f) => ({ ...f, roundId })));
      return { winner, fromRotation, expiring, flags: flags.length };
    });
    if (!result) return null;

    const round = (await db.query.rounds.findFirst({ where: eq(schema.rounds.id, roundId) }))!;
    if (result.winner && result.fromRotation)
      await redis.set(READY_KEY, result.winner.id, 'EX', 3600);
    const choice: Choice | null = result.winner
      ? { kind: result.fromRotation ? 'replay' : 'request', id: result.winner.id }
      : await chooseNext(false);
    if (choice) await scheduleNext(round, choice);

    broadcast.toAll('round:locked', { roundId, winnerRequestId: result.winner?.id ?? null });
    await publishRoundState();
    if (result.winner) {
      const pub = await publicRequestById(db, result.winner.id);
      if (pub) await deps.notify.request('won', pub);
    }
    for (const e of result.expiring) {
      const pub = await publicRequestById(db, e.id);
      if (pub) await deps.notify.request('expired', pub);
    }
    deps.log.info(
      {
        roundId,
        winner: result.winner?.id ?? null,
        expired: result.expiring.length,
        flags: result.flags,
      },
      'round locked',
    );
    return result;
  }

  async function startNext(at: Date, idle: boolean) {
    const choice = (await takeScheduled()) ?? (await chooseNext(idle));
    if (!choice) {
      const current = await nowPlaying();
      if (current?.trackId || !current) await startTrack(null, at);
      await redis.set(EMPTY_KEY, '1', 'EX', 15);
      return null;
    }
    return startTrack(choice, at);
  }

  async function withTickLock<T>(fn: () => Promise<T>, waitMs = 0): Promise<T | null> {
    const deadline = Date.now() + waitMs;
    while (!(await redis.set(TICK_LOCK, '1', 'PX', 30_000, 'NX'))) {
      if (Date.now() >= deadline) return null;
      await new Promise((r) => setTimeout(r, 200));
    }
    try {
      return await fn();
    } finally {
      await redis.del(TICK_LOCK);
    }
  }

  /**
   * Advances the shared timeline: locks the round when voting closes and starts the next track
   * when the current one ends. There is no always-on player, so every read of the station calls
   * this; it is cheap when nothing is due and only one caller does the work.
   */
  async function computeDue() {
    const r = await currentRound();
    if (!r || r.status === 'closed') return Date.now() + 15_000;
    return r.status === 'open' ? r.lockAt.getTime() : r.startedAt.getTime() + r.durationMs;
  }

  // Remembered per instance too, so polls between transitions cost no Redis calls. Capped so a
  // skip or a newly added request on another instance is seen within a few seconds.
  let localDue = 0;
  let localDueUntil = 0;

  async function tick(): Promise<number> {
    if (Date.now() < Math.min(localDue, localDueUntil)) return localDue;
    const cached = Number(await redis.get(DUE_KEY));
    if (cached && Date.now() < cached) {
      localDue = cached;
      localDueUntil = Date.now() + LOCAL_DUE_MAX_MS;
      return cached;
    }
    await withTickLock(async () => {
      for (let i = 0; i < 4; i++) {
        const r = await currentRound();
        const nowMs = Date.now();
        if (!r || r.status === 'closed') {
          if (await redis.get(EMPTY_KEY)) return;
          if (!(await startNext(new Date(nowMs), true))) return;
          continue;
        }
        if (r.status === 'open' && nowMs >= r.lockAt.getTime()) {
          await lockRound(r.id);
          continue;
        }
        const endAt = r.startedAt.getTime() + r.durationMs;
        if (nowMs < endAt) return;
        const late = nowMs - endAt > SEAMLESS_GRACE_MS;
        if (!(await startNext(new Date(late ? nowMs : endAt), late))) return;
      }
    });
    const due = await computeDue();
    await redis.set(DUE_KEY, String(due), 'PX', Math.max(1000, due - Date.now()));
    localDue = due;
    localDueUntil = Date.now() + LOCAL_DUE_MAX_MS;
    return due;
  }

  async function state(): Promise<RadioState> {
    // A failed tick (e.g. a lock timeout) must not take the station endpoint down with it.
    const due = await tick().catch((err: Error) => {
      deps.log.warn({ err: err.message }, 'tick failed');
      return Date.now() + 5000;
    });
    const [now, next] = await Promise.all([nowPlaying(), upNext()]);
    return {
      now,
      next,
      serverTime: new Date().toISOString(),
      dueAt: new Date(due).toISOString(),
    };
  }

  /** Admin skip: close voting if it is still open, then start the next track right now. */
  async function skip() {
    localDue = 0;
    await redis.del(DUE_KEY);
    return withTickLock(async () => {
      const r = await currentRound();
      if (r?.status === 'open') await lockRound(r.id);
      return startNext(new Date(), !r || r.status === 'closed');
    }, 5000);
  }

  return {
    nowPlaying,
    upNext,
    state,
    tick,
    skip,
    onTrackStart: (hook: (startedAt: Date) => Promise<unknown>) => void trackStartHooks.push(hook),
    currentRound,
    roundState,
    vote,
    lockRound,
    voteCounts,
    onTransitionReady,
    ensureTransition,
    planTrackOf,
    notifyOwner: deps.notify.request,
  };
}
export type Station = ReturnType<typeof createStation>;
export { ROOMS };
