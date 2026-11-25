import { waitUntil } from '@vercel/functions';

/**
 * Work that should finish after the response is sent. On Vercel `waitUntil` keeps the function
 * alive until it settles; locally the process is long-lived anyway.
 */
export function background(work: Promise<unknown>, log?: { warn: (o: object, m: string) => void }) {
  waitUntil(
    work.catch((err: unknown) =>
      log?.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'background task failed',
      ),
    ),
  );
}

export const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
