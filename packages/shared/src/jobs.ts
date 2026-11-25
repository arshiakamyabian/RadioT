import { z } from 'zod';

/** POST WORKER_URL/api/media — the API hands a track to the worker for ingest and analysis. */
export const mediaJobSchema = z.object({
  /**
   * fallback / request: ingest and analyse that track. reanalyze-*: recompute the analysis of an
   * already cooked track. transition: render the clip for that `transitions` row.
   */
  kind: z.enum(['fallback', 'request', 'reanalyze-fallback', 'reanalyze-request', 'transition']),
  id: z.string().uuid(),
});
export type MediaJob = z.infer<typeof mediaJobSchema>;

/** Shared-secret header on API ↔ worker calls. */
export const INTERNAL_SECRET_HEADER = 'x-radiot-secret';

/** POST API_URL/internal/worker-event — the worker reports back when a job finishes. */
export const workerEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('request.status'), requestId: z.string().uuid(), userId: z.string() }),
  z.object({ type: z.literal('fallback.ready'), trackId: z.string().uuid() }),
  z.object({ type: z.literal('transition.ready'), transitionId: z.string().uuid() }),
]);
export type WorkerEvent = z.infer<typeof workerEventSchema>;
