import { waitUntil } from '@vercel/functions';
import { createDeps } from './deps.js';
import { handleMediaRequest } from './jobs.js';

const { env, deps } = createDeps();

export function POST(request: Request): Promise<Response> {
  return handleMediaRequest(request, env, deps, waitUntil);
}
