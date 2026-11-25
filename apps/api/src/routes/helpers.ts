import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import type { z } from 'zod';
import type { AppContext } from '../context.js';
import { hashIp, verifyTurnstile } from '../services/security.js';
import { activeSanction, getRole } from '../services/users.js';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function body<S extends z.ZodType>(schema: S, req: FastifyRequest): z.infer<S> {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success)
    throw new HttpError(400, parsed.error.issues[0]?.message ?? 'Invalid request');
  return parsed.data;
}

export function params<S extends z.ZodType>(schema: S, req: FastifyRequest): z.infer<S> {
  const parsed = schema.safeParse(req.params);
  if (!parsed.success) throw new HttpError(400, 'Invalid parameters');
  return parsed.data;
}

export const requireUser: preHandlerHookHandler = async (request, reply) => {
  if (!request.user) return reply.status(401).send({ error: 'Please sign in first.' });
};

export function requireAdmin(ctx: AppContext): preHandlerHookHandler {
  return async (request, reply) => {
    if (!request.user) return reply.status(401).send({ error: 'Please sign in first.' });
    if ((await getRole(ctx.db, request.user.id)) !== 'admin')
      return reply.status(403).send({ error: 'Admins only.' });
  };
}

export const ipHashOf = (ctx: AppContext, req: FastifyRequest) =>
  hashIp(req.ip, ctx.env.IP_HASH_SALT);

/** Shared gate for every community write: not banned, passes Turnstile. */
export async function guardWrite(
  ctx: AppContext,
  req: FastifyRequest,
  token: string | undefined,
  opts: { turnstile: boolean },
) {
  const ipHash = ipHashOf(ctx, req);
  if (await activeSanction(ctx.db, 'ban', req.user?.id ?? null, ipHash))
    throw new HttpError(403, 'Your account is banned.');
  if (opts.turnstile && !(await verifyTurnstile(ctx.env, token, req.ip)))
    throw new HttpError(403, 'Please complete the human check.');
  return ipHash;
}

/** Fixed-window per-key limiter in Redis, for limits narrower than the global HTTP limiter. */
export async function limit(ctx: AppContext, key: string, max: number, windowSeconds: number) {
  if (ctx.env.NODE_ENV === 'development') return;
  const k = `rl:${key}`;
  const n = await ctx.redis.incr(k);
  if (n === 1) await ctx.redis.expire(k, windowSeconds);
  if (n > max) throw new HttpError(429, 'Slow down a little.');
}

export async function audit(
  ctx: AppContext,
  adminId: string,
  action: string,
  target: string | null,
  metadata: Record<string, unknown> = {},
) {
  const { schema } = await import('@radiot/db');
  await ctx.db.insert(schema.adminActions).values({ adminId, action, target, metadata });
}

export const send = (reply: FastifyReply, status: number, payload: unknown) =>
  reply.status(status).send(payload);
