import { createHash } from 'node:crypto';
import type { Env } from '../env.js';

export const hashIp = (ip: string, salt: string) =>
  createHash('sha256').update(`${salt}:${ip}`).digest('hex').slice(0, 32);

/** Cloudflare Turnstile. Disabled (always passes) when no secret is configured, e.g. locally. */
export async function verifyTurnstile(
  env: Env,
  token: string | undefined,
  ip: string,
): Promise<boolean> {
  if (!env.TURNSTILE_SECRET_KEY) return true;
  if (!token) return false;
  const body = new URLSearchParams({
    secret: env.TURNSTILE_SECRET_KEY,
    response: token,
    remoteip: ip,
  });
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(5000),
    });
    const json = (await res.json()) as { success?: boolean };
    return json.success === true;
  } catch {
    return false;
  }
}
