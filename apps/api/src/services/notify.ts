// Static import (not createRequire) so Vercel's file tracer bundles web-push.
import * as webpush from 'web-push';
import { eq, schema, type Database } from '@radiot/db';
import { STATION_NAME, ROOMS, type RequestPublic } from '@radiot/shared';
import type { Broadcaster } from '../context.js';
import type { Env } from '../env.js';
import type { Mailer } from '../mailer.js';

export type NotifyKind = 'won' | 'live' | 'expired' | 'ready' | 'rejected';

const COPY: Record<NotifyKind, (title: string) => { title: string; body: string }> = {
  won: (t) => ({ title: 'Your song won the vote', body: `"${t}" plays next on ${STATION_NAME}.` }),
  live: (t) => ({ title: "You're on air", body: `"${t}" is playing now. Go live on camera!` }),
  expired: (t) => ({
    title: 'Moved to rotation',
    body: `"${t}" didn't win the vote, but it stays on ${STATION_NAME} and plays in the rotation.`,
  }),
  ready: (t) => ({ title: 'Request ready', body: `"${t}" is in the vote. Share it to get votes!` }),
  rejected: (t) => ({ title: 'Request rejected', body: `"${t}" could not be added.` }),
};

const EMAIL_KINDS = new Set<NotifyKind>(['won', 'expired']);

export function createNotifier(deps: {
  env: Env;
  db: Database;
  mailer: Mailer;
  broadcast: Broadcaster;
  log: { warn: (o: object, m: string) => void };
}) {
  const { env, db } = deps;
  const pushEnabled = Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
  if (pushEnabled)
    webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY!, env.VAPID_PRIVATE_KEY!);

  return {
    pushEnabled,
    /** Realtime status to the owner's sockets, plus web push / email for the moments that matter. */
    async request(kind: NotifyKind | null, req: RequestPublic) {
      deps.broadcast.toRoom(ROOMS.user(req.requester.id), 'request:status', req);
      if (!kind) return;
      const copy = COPY[kind](req.title || 'Your request');
      const url = `${env.WEB_ORIGIN}/history/${req.id}`;
      if (pushEnabled) {
        const subs = await db
          .select()
          .from(schema.pushSubscriptions)
          .where(eq(schema.pushSubscriptions.userId, req.requester.id));
        await Promise.all(
          subs.map((s) =>
            webpush
              .sendNotification(
                { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
                JSON.stringify({ ...copy, url }),
              )
              .catch(async (err: { statusCode?: number }) => {
                if (err.statusCode === 404 || err.statusCode === 410) {
                  await db
                    .delete(schema.pushSubscriptions)
                    .where(eq(schema.pushSubscriptions.id, s.id));
                }
              }),
          ),
        );
      }
      if (EMAIL_KINDS.has(kind)) {
        const user = await db.query.users.findFirst({
          where: eq(schema.users.id, req.requester.id),
          columns: { email: true },
        });
        if (user) {
          await deps.mailer
            .send({
              to: user.email,
              subject: copy.title,
              text: `${copy.body}\n\n${url}`,
              html: `<p>${copy.body}</p><p><a href="${url}">Open ${STATION_NAME}</a></p>`,
            })
            .catch((err: Error) => deps.log.warn({ err: err.message }, 'notify email failed'));
        }
      }
    },
  };
}
export type Notifier = ReturnType<typeof createNotifier>;
