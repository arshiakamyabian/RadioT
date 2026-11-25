import { and, eq, isNotNull, isNull, lt, schema, sql, type Database } from '@radiot/db';
import type { Redis } from 'ioredis';
import type { MediaDispatcher } from '../context.js';

const REANALYZE_BATCH = 6;
const REANALYZE_CANDIDATES = 30;
const REANALYZE_RETRY_SECONDS = 6 * 60 * 60;

/**
 * Periodic upkeep without a cron or an always-on worker: station reads call `maybeRun`, and a
 * Redis key makes sure each task runs at most once per interval across every API instance.
 */
export function createMaintenance(deps: {
  db: Database;
  redis: Redis;
  media: MediaDispatcher;
  log: { warn: (o: object, m: string) => void };
}) {
  const { db, redis } = deps;

  // Checked locally first: this runs after every station read and would otherwise cost a Redis
  // call per task per poll.
  const nextCheck = new Map<string, number>();
  async function due(task: string, everySeconds: number) {
    if (Date.now() < (nextCheck.get(task) ?? 0)) return false;
    nextCheck.set(task, Date.now() + everySeconds * 1000);
    return (await redis.set(`maint:${task}`, '1', 'EX', everySeconds, 'NX')) === 'OK';
  }

  // A request whose hand-off or processing died would sit in "Processing" forever. Re-dispatch it.
  async function recoverStuckRequests() {
    const stuck = await db
      .update(schema.requests)
      .set({ updatedAt: new Date() })
      .where(
        and(
          eq(schema.requests.status, 'ingesting'),
          lt(schema.requests.updatedAt, new Date(Date.now() - 15 * 60_000)),
        ),
      )
      .returning({ id: schema.requests.id });
    for (const { id } of stuck) {
      await deps.media.dispatch({ kind: 'request', id });
      deps.log.warn({ id }, 're-dispatched stuck request');
    }
  }

  // The weekly chart is a materialized view (see packages/db/drizzle).
  async function refreshCharts() {
    await db.execute(sql`refresh materialized view concurrently weekly_chart`);
  }

  // Tracks cooked before the deep analysis existed get it a few at a time, so the planner
  // gradually covers the whole library without anyone running a backfill. A track is tried at
  // most once per REANALYZE_RETRY_SECONDS, so one that keeps failing can't block the rest.
  async function reanalyzeOldTracks() {
    const fallback = await db
      .select({ id: schema.fallbackTracks.id })
      .from(schema.fallbackTracks)
      .where(
        and(isNotNull(schema.fallbackTracks.storageKey), isNull(schema.fallbackTracks.features)),
      )
      .limit(REANALYZE_CANDIDATES);
    const uploads = await db
      .select({ id: schema.requests.id })
      .from(schema.requests)
      .where(and(isNotNull(schema.requests.storageKey), isNull(schema.requests.features)))
      .limit(REANALYZE_CANDIDATES);
    const jobs = [
      ...fallback.map(({ id }) => ({ kind: 'reanalyze-fallback' as const, id })),
      ...uploads.map(({ id }) => ({ kind: 'reanalyze-request' as const, id })),
    ];
    let sent = 0;
    for (const job of jobs) {
      if (sent >= REANALYZE_BATCH) break;
      const fresh = await redis.set(
        `maint:reanalyze:${job.id}`,
        '1',
        'EX',
        REANALYZE_RETRY_SECONDS,
        'NX',
      );
      if (fresh !== 'OK') continue;
      sent++;
      await deps.media.dispatch(job).catch(() => {});
    }
  }

  return {
    async maybeRun() {
      if (await due('reanalyze', 30)) await reanalyzeOldTracks();
      if (await due('recover', 10 * 60)) await recoverStuckRequests();
      if (await due('charts', 60 * 60)) await refreshCharts();
    },
  };
}
