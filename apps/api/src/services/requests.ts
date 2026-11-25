import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { and, count, desc, eq, getSettings, gt, inArray, schema, type Database } from '@radiot/db';
import {
  ResolveError,
  audioMimeFor,
  defaultResolvers,
  resolveLink,
  type CreateUploadRequest,
  type CreateUrlRequest,
  type StationSettings,
} from '@radiot/shared';
import type { Broadcaster, MediaDispatcher } from '../context.js';
import type { Notifier } from './notify.js';
import { toPublicRequests } from './requests-view.js';
import type { ApiStorage } from './storage.js';

export class RequestError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const ACTIVE = ['pending_upload', 'ingesting', 'ready', 'queued'] as const;

function isPrivate(ip: string) {
  if (isIP(ip) === 6)
    return (
      ip === '::1' ||
      /^(fc|fd|fe80)/i.test(ip) ||
      ip.startsWith('::ffff:127.') ||
      ip.startsWith('::ffff:10.')
    );
  const [a, b] = ip.split('.').map(Number) as [number, number];
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

// Guarded fetch for the HEAD probe: refuses hosts that resolve to private addresses (SSRF).
async function guardedFetch(url: string, init?: RequestInit) {
  const host = new URL(url).hostname;
  const addrs = await lookup(host, { all: true });
  if (addrs.some((a) => isPrivate(a.address))) throw new Error('private address');
  return fetch(url, init);
}

export function createRequestService(deps: {
  db: Database;
  storage: ApiStorage;
  media: MediaDispatcher;
  broadcast: Broadcaster;
  notify: Notifier;
  relaxLimits?: boolean;
}) {
  const { db } = deps;

  async function enforceLimits(userId: string, s: StationSettings) {
    if (deps.relaxLimits) return;
    const [active] = await db
      .select({ n: count() })
      .from(schema.requests)
      .where(and(eq(schema.requests.userId, userId), inArray(schema.requests.status, [...ACTIVE])));
    if (Number(active?.n ?? 0) >= s.maxActiveRequestsPerUser) {
      throw new RequestError(
        `You can have at most ${s.maxActiveRequestsPerUser} songs waiting at once.`,
        429,
      );
    }
    const hourAgo = new Date(Date.now() - 3600_000);
    const recent = await db
      .select({ createdAt: schema.requests.createdAt })
      .from(schema.requests)
      .where(and(eq(schema.requests.userId, userId), gt(schema.requests.createdAt, hourAgo)))
      .orderBy(desc(schema.requests.createdAt));
    if (recent.length >= s.requestsPerUserPerHour) {
      throw new RequestError(
        `You can request ${s.requestsPerUserPerHour} songs per hour. Try again later.`,
        429,
      );
    }
    const last = recent[0]?.createdAt;
    if (last && Date.now() - last.getTime() < s.requestCooldownSeconds * 1000) {
      throw new RequestError('Please wait a moment before requesting another song.', 429);
    }
  }

  async function enqueue(id: string) {
    // A failed hand-off is not the user's problem: the station's stuck-request sweep re-dispatches it.
    await deps.media.dispatch({ kind: 'request', id }).catch(() => {});
  }

  return {
    async createUpload(userId: string, ipHash: string, body: CreateUploadRequest) {
      const s = await getSettings(db);
      const contentType = audioMimeFor(body.filename, body.contentType);
      if (!contentType)
        throw new RequestError('Unsupported file type. Use MP3, M4A, AAC, FLAC, OGG, WAV or MP4.');
      if (body.size > s.maxUploadMb * 1024 * 1024)
        throw new RequestError(`Files must be under ${s.maxUploadMb} MB`);
      await enforceLimits(userId, s);
      const title = body.filename
        .replace(/\.[a-z0-9]+$/i, '')
        .replace(/[-_]+/g, ' ')
        .trim()
        .slice(0, 200);
      const [row] = await db
        .insert(schema.requests)
        .values({
          userId,
          source: 'upload',
          title,
          status: 'pending_upload',
          termsAcceptedAt: new Date(),
          ipHash,
        })
        .returning();
      const rawKey = `raw/request/${row!.id}`;
      await db.update(schema.requests).set({ rawKey }).where(eq(schema.requests.id, row!.id));
      const upload = await deps.storage.clientUpload(rawKey, contentType, body.size);
      const [pub] = await toPublicRequests(db, [{ ...row!, rawKey }]);
      return { request: pub!, upload };
    },

    async confirmUpload(userId: string, id: string) {
      const req = await db.query.requests.findFirst({
        where: and(eq(schema.requests.id, id), eq(schema.requests.userId, userId)),
      });
      if (!req) throw new RequestError('Request not found', 404);
      if (req.status !== 'pending_upload' || !req.rawKey)
        throw new RequestError('Upload already confirmed', 409);
      const s = await getSettings(db);
      const head = await deps.storage.head(req.rawKey);
      if (!head) throw new RequestError('Upload not found. Please try again.', 400);
      if (head.size > s.maxUploadMb * 1024 * 1024)
        throw new RequestError(`Files must be under ${s.maxUploadMb} MB`);
      const [row] = await db
        .update(schema.requests)
        .set({ status: 'ingesting', updatedAt: new Date() })
        .where(eq(schema.requests.id, id))
        .returning();
      await enqueue(id);
      const [pub] = await toPublicRequests(db, [row!]);
      await deps.notify.request(null, pub!);
      return pub!;
    },

    async createFromUrl(userId: string, ipHash: string, body: CreateUrlRequest) {
      const s = await getSettings(db);
      await enforceLimits(userId, s);
      let resolved;
      try {
        resolved = await resolveLink(
          body.url,
          defaultResolvers(s.maxUploadMb * 1024 * 1024, guardedFetch),
        );
      } catch (err) {
        throw new RequestError(
          err instanceof ResolveError ? err.message : 'Could not use that link',
        );
      }
      const title = (
        resolved.title ??
        resolved.filename
          .replace(/\.[a-z0-9]+$/i, '')
          .replace(/[-_]+/g, ' ')
          .trim()
      ).slice(0, 200);
      const [row] = await db
        .insert(schema.requests)
        .values({
          userId,
          source: 'url',
          rawUrl: resolved.url,
          title,
          artist: (resolved.artist ?? '').slice(0, 200),
          artworkUrl: resolved.artworkUrl ?? null,
          status: 'ingesting',
          termsAcceptedAt: new Date(),
          ipHash,
        })
        .returning();
      await enqueue(row!.id);
      const [pub] = await toPublicRequests(db, [row!]);
      return pub!;
    },

    async withdraw(userId: string, id: string) {
      const [row] = await db
        .update(schema.requests)
        .set({ status: 'expired', rejectReason: 'Withdrawn', updatedAt: new Date() })
        .where(
          and(
            eq(schema.requests.id, id),
            eq(schema.requests.userId, userId),
            inArray(schema.requests.status, ['pending_upload', 'ready']),
          ),
        )
        .returning();
      if (!row) throw new RequestError('That request can no longer be withdrawn', 409);
      deps.broadcast.toAll('queue:update');
      return (await toPublicRequests(db, [row]))[0]!;
    },

    async mine(userId: string) {
      const rows = await db
        .select()
        .from(schema.requests)
        .where(eq(schema.requests.userId, userId))
        .orderBy(desc(schema.requests.createdAt))
        .limit(30);
      return toPublicRequests(db, rows);
    },

    async queue() {
      const rows = await db
        .select()
        .from(schema.requests)
        .where(inArray(schema.requests.status, ['queued', 'playing']))
        .orderBy(desc(schema.requests.updatedAt));
      return toPublicRequests(db, rows);
    },
  };
}
export type RequestService = ReturnType<typeof createRequestService>;
