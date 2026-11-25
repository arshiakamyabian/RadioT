import { and, eq, gte, inArray, isNotNull, isNull, or, schema, type Database } from '@radiot/db';
import { MIN_TRACK_SECONDS, type RequestPublic } from '@radiot/shared';
import { UNKNOWN_USER, publicUsers } from './users.js';

type Row = typeof schema.requests.$inferSelect;

/**
 * Uploads that loop on the station: aired ones, plus ones that left the vote unpicked.
 * A withdrawn request is also 'expired' but carries a rejectReason, so it stays off air.
 * Uploads accepted before the minimum length existed stay out too: a clip that short can't be
 * mixed in and out, and the hand-overs around it broke the stream.
 */
export const inRotation = () =>
  and(
    isNotNull(schema.requests.storageKey),
    gte(schema.requests.durationMs, MIN_TRACK_SECONDS * 1000),
    or(
      eq(schema.requests.status, 'played'),
      and(eq(schema.requests.status, 'expired'), isNull(schema.requests.rejectReason)),
    ),
  );

export async function toPublicRequests(db: Database, rows: Row[]): Promise<RequestPublic[]> {
  const users = await publicUsers(
    db,
    rows.map((r) => r.userId),
  );
  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    title: r.title || 'Untitled',
    artist: r.artist,
    artworkUrl: r.artworkUrl,
    durationMs: r.durationMs,
    rejectReason: r.rejectReason,
    createdAt: r.createdAt.toISOString(),
    playedAt: r.playedAt?.toISOString() ?? null,
    requester: users.get(r.userId) ?? UNKNOWN_USER(r.userId),
  }));
}

export async function publicRequestById(db: Database, id: string) {
  const rows = await db
    .select()
    .from(schema.requests)
    .where(inArray(schema.requests.id, [id]));
  return rows[0] ? (await toPublicRequests(db, rows))[0]! : null;
}
