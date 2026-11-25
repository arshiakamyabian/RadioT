import { randomUUID } from 'node:crypto';
import { and, eq, isNull, lt, schema } from '@radiot/db';
import { STAGE_ROOM, stageStateSchema, type StageState, type StageToken } from '@radiot/shared';
import type { AppContext } from '../context.js';
import type { Station } from '../services/station.js';
import { activeSanction } from '../services/users.js';
import { publicUsers } from '../services/users.js';
import {
  handleStageEvent,
  mintToken,
  performerGrant,
  viewerGrant,
  type LiveKit,
  type StageEventDeps,
} from './livekit.js';
import type { WebhookEvent } from 'livekit-server-sdk';

const STATE_KEY = 'stage:state';

export class StageError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export function createStage(
  ctx: AppContext,
  station: Station,
  livekit: LiveKit | null,
  log: { warn: (o: object, m: string) => void },
) {
  const { db, redis, broadcast } = ctx;

  async function setState(state: StageState) {
    await redis.set(STATE_KEY, JSON.stringify(state), 'EX', 3600);
    broadcast.toAll('stage:state', state);
  }

  async function state(): Promise<StageState> {
    const raw = await redis.get(STATE_KEY);
    const parsed = raw ? stageStateSchema.safeParse(JSON.parse(raw)) : null;
    return parsed?.success ? parsed.data : { live: false, performer: null, roundId: null };
  }

  async function endSession(sessionId: string, reason: string) {
    const [s] = await db
      .update(schema.liveSessions)
      .set({ endedAt: new Date(), endReason: reason })
      .where(and(eq(schema.liveSessions.id, sessionId), isNull(schema.liveSessions.endedAt)))
      .returning();
    if (s && livekit) await livekit.rooms.removeParticipant(STAGE_ROOM, s.identity).catch(() => {});
    const cur = await state();
    if (s && cur.performer?.id === s.userId)
      await setState({ live: false, performer: null, roundId: cur.roundId });
  }

  const eventDeps: StageEventDeps = {
    async isPerformer(identity) {
      const s = await db.query.liveSessions.findFirst({
        where: and(eq(schema.liveSessions.identity, identity), isNull(schema.liveSessions.endedAt)),
      });
      return s ? { sessionId: s.id, userId: s.userId, requestId: s.requestId } : null;
    },
    async removeParticipant(room, identity) {
      await livekit?.rooms
        .removeParticipant(room, identity)
        .catch((err: Error) => log.warn({ err: err.message }, 'removeParticipant failed'));
    },
    async recordViolation(v) {
      await db.insert(schema.micViolations).values({
        userId: v.userId,
        liveSessionId: v.sessionId,
        requestId: v.requestId,
        detail: v.detail,
      });
    },
    endSession,
    async goLive(sessionId) {
      const s = await db.query.liveSessions.findFirst({
        where: eq(schema.liveSessions.id, sessionId),
      });
      if (!s) return;
      const performer = (await publicUsers(db, [s.userId])).get(s.userId) ?? null;
      await setState({ live: true, performer, roundId: s.roundId });
    },
  };

  return {
    enabled: Boolean(livekit),
    state,

    async token(
      userId: string | null,
      role: 'performer' | 'viewer',
      ipHash: string,
    ): Promise<StageToken> {
      if (!livekit) throw new StageError('Live video is not configured', 503);
      if (role === 'viewer') {
        const identity = userId
          ? `viewer-${userId}-${randomUUID().slice(0, 8)}`
          : `anon-${randomUUID()}`;
        return {
          token: await mintToken(
            livekit.apiKey,
            livekit.apiSecret,
            identity,
            'Listener',
            viewerGrant(),
            6 * 3600,
          ),
          url: livekit.url,
          room: STAGE_ROOM,
          role,
        };
      }
      if (!userId) throw new StageError('Please sign in first.', 401);
      const profile = await db.query.profiles.findFirst({
        where: eq(schema.profiles.userId, userId),
      });
      if (!profile?.ageConfirmedAdult)
        throw new StageError('You must confirm you are 18 or older to go live.', 403);
      if (await activeSanction(db, 'ban', userId, ipHash))
        throw new StageError('Your account is banned.', 403);
      const now = await station.nowPlaying();
      const round = await station.currentRound();
      const request =
        now?.kind === 'request' && now.trackId
          ? await db.query.requests.findFirst({ where: eq(schema.requests.id, now.trackId) })
          : null;
      if (!request || request.userId !== userId || request.status !== 'playing') {
        throw new StageError('You can go live only while your song is playing.', 403);
      }
      // One live session per performer; a new token replaces any stale one.
      await db
        .update(schema.liveSessions)
        .set({ endedAt: new Date(), endReason: 'replaced' })
        .where(and(eq(schema.liveSessions.userId, userId), isNull(schema.liveSessions.endedAt)));
      const identity = `performer-${userId}`;
      await db.insert(schema.liveSessions).values({
        userId,
        requestId: request.id,
        roundId: round?.id ?? null,
        livekitRoom: STAGE_ROOM,
        identity,
      });
      const name = (await publicUsers(db, [userId])).get(userId)?.name ?? 'Performer';
      const ttl = Math.max(
        60,
        Math.ceil(
          ((now?.durationMs ?? 0) - (Date.now() - new Date(now!.startedAt).getTime())) / 1000,
        ) + 30,
      );
      return {
        token: await mintToken(
          livekit.apiKey,
          livekit.apiSecret,
          identity,
          name,
          performerGrant(),
          ttl,
        ),
        url: livekit.url,
        room: STAGE_ROOM,
        role,
      };
    },

    async webhook(rawBody: string, authorization: string | undefined) {
      if (!livekit) throw new StageError('Live video is not configured', 503);
      let event: WebhookEvent;
      try {
        event = await livekit.receiver.receive(rawBody, authorization);
      } catch {
        throw new StageError('invalid webhook signature', 401);
      }
      return handleStageEvent(event, eventDeps);
    },

    /** Ends every performer session that started before the given moment (track changed). */
    async endSessionsBefore(before: Date, reason = 'track_ended') {
      // Spare the performer whose request is still on air (e.g. they queued two songs in a row).
      const now = await station.nowPlaying();
      const onAir = now?.kind === 'request' ? (now.requester?.id ?? null) : null;
      const sessions = await db
        .select()
        .from(schema.liveSessions)
        .where(and(isNull(schema.liveSessions.endedAt), lt(schema.liveSessions.startedAt, before)));
      const ending = sessions.filter((s) => s.userId !== onAir);
      for (const s of ending) await endSession(s.id, reason);
      return ending.length;
    },

    async killAll(reason = 'admin_kill') {
      const sessions = await db
        .select()
        .from(schema.liveSessions)
        .where(isNull(schema.liveSessions.endedAt));
      for (const s of sessions) await endSession(s.id, reason);
      await setState({ live: false, performer: null, roundId: (await state()).roundId });
      return sessions.length;
    },
  };
}
export type Stage = ReturnType<typeof createStage>;
