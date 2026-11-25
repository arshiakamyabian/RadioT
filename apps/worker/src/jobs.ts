import { timingSafeEqual } from 'node:crypto';
import * as Sentry from '@sentry/node';
import { INTERNAL_SECRET_HEADER, mediaJobSchema, type MediaJob } from '@radiot/shared';
import type { Env } from './env.js';
import { RejectError, markFailed, processMedia, type PipelineDeps } from './pipeline.js';

const ATTEMPTS = 3;

/** Runs one media job to completion: retries transient failures, rejects bad audio for good. */
export async function runMediaJob(job: MediaJob, deps: PipelineDeps) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await processMedia(job, deps);
    } catch (err) {
      if (err instanceof RejectError) return markFailed(job, err.message, deps);
      // Clips and re-analysis are best effort: the station falls back to a plain crossfade.
      if (job.kind !== 'fallback' && job.kind !== 'request') {
        deps.log.info({ err: (err as Error).message, ...job }, 'job failed');
        return;
      }
      Sentry.captureException(err, { tags: { job: 'media' }, extra: { ...job, attempt } });
      if (attempt >= ATTEMPTS) {
        const message = (err as Error).message;
        const reason = message.startsWith('Could not download audio')
          ? `${message}. Try again, or download the file and upload it instead.`
          : 'We could not process this audio. Please try another file.';
        return markFailed(job, reason, deps);
      }
      await new Promise((r) => setTimeout(r, 5000 * 2 ** (attempt - 1)));
    }
  }
}

/**
 * POST /api/media. Acknowledges immediately and hands the work to `schedule`, which keeps the
 * function alive until it finishes (Vercel `waitUntil`; a plain promise locally).
 */
export async function handleMediaRequest(
  request: Request,
  env: Env,
  deps: PipelineDeps,
  schedule: (work: Promise<unknown>) => void,
): Promise<Response> {
  const given = Buffer.from(request.headers.get(INTERNAL_SECRET_HEADER) ?? '');
  const want = Buffer.from(env.INTERNAL_SECRET);
  if (given.length !== want.length || !timingSafeEqual(given, want))
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  const parsed = mediaJobSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'invalid job' }, { status: 400 });
  schedule(
    runMediaJob(parsed.data, deps).catch((err: Error) =>
      deps.log.info({ err: err.message, ...parsed.data }, 'media job crashed'),
    ),
  );
  return Response.json({ accepted: true }, { status: 202 });
}
