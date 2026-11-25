import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { STATION_NAME, type HealthResponse } from '@radiot/shared';
import type { Auth } from './auth.js';
import type { AppContext } from './context.js';
import type { Env } from './env.js';
import { sendWebResponse, toWebHeaders, toWebRequest } from './http.js';
import { adminRoutes } from './routes/admin.js';
import { HttpError, requireUser } from './routes/helpers.js';
import { profileRoutes } from './routes/profiles.js';
import { radioRoutes } from './routes/radio.js';
import { requestRoutes } from './routes/requests.js';
import { roundRoutes } from './routes/rounds.js';
import { socialRoutes } from './routes/social.js';
import { stageRoutes } from './routes/stage.js';
import type { Notifier } from './services/notify.js';
import type { RequestService } from './services/requests.js';
import type { Station } from './services/station.js';
import type { Stage } from './stage/service.js';

const PUBLIC_CORS_PATHS = /^\/api\/(public\/|now-playing$|queue$)/;

export interface SessionUser {
  id: string;
  email: string;
  name: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null;
  }
}

export interface AppServices {
  ctx: AppContext;
  station: Station;
  requests: RequestService;
  stage: Stage;
  notify: Notifier;
  /** Runs throttled upkeep after station reads (there is no cron or always-on worker). */
  afterStationRead?: () => void;
  listenerCount: () => number;
  googleEnabled: boolean;
  pushKey: string | null;
}

export interface AppDeps {
  env: Env;
  auth?: Auth;
  services?: AppServices;
  checks?: Record<string, () => Promise<boolean>>;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { env, auth, services } = deps;
  const app = Fastify({
    logger: env.NODE_ENV === 'test' ? false : { level: env.LOG_LEVEL },
    trustProxy: true,
    bodyLimit: 256 * 1024,
  });

  await app.register(helmet, { global: true });
  // Read-only station data is open to any origin (embeds, FiveM NUI pages); everything else
  // is credentialed and limited to the web app. The web app sends cookies on every call, and a
  // credentialed request may not be answered with a wildcard, so it never gets the open form.
  await app.register(cors, {
    delegator: (req, cb) => {
      const path = (req.url ?? '').split('?')[0] ?? '';
      cb(
        null,
        PUBLIC_CORS_PATHS.test(path) && !env.webOrigins.includes(req.headers.origin ?? '')
          ? { origin: '*', credentials: false, methods: ['GET'] }
          : {
              origin: env.webOrigins,
              credentials: true,
              methods: ['GET', 'POST', 'PATCH', 'DELETE'],
            },
      );
    },
  });
  // In development we skip the HTTP rate limiter entirely, which also neutralises every
  // route-level `config: { rateLimit: ... }` because the plugin is not present.
  if (env.NODE_ENV !== 'development') {
    await app.register(rateLimit, {
      global: true,
      max: 300,
      timeWindow: '1 minute',
      // The engine and every listener poll these all day; limiting them cost Redis calls on each.
      allowList: (req) => /^\/(api\/now-playing|api\/public\/station|health)(\?|$)/.test(req.url),
      ...(services ? { redis: services.ctx.redis, nameSpace: 'rl:http:' } : {}),
    });
  }

  app.decorateRequest('user', null);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
    if (err instanceof ZodError)
      return reply.status(400).send({ error: err.issues[0]?.message ?? 'Invalid request' });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.status(status).send({ error: (err as Error).message });
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ error: 'Something went wrong.' });
  });

  const startedAt = Date.now();
  app.get(
    '/health',
    { config: { rateLimit: false } },
    async (_req, reply): Promise<HealthResponse> => {
      const entries = await Promise.all(
        Object.entries(deps.checks ?? {}).map(async ([name, check]) => {
          const ok = await check().catch(() => false);
          return [name, ok ? 'ok' : 'down'] as const;
        }),
      );
      const checks = Object.fromEntries(entries);
      if (entries.some(([, s]) => s === 'down')) reply.status(503);
      return {
        status: 'ok',
        service: `${STATION_NAME.toLowerCase()}-api`,
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
        checks,
      };
    },
  );

  if (auth) {
    app.addHook('onRequest', async (request) => {
      if (
        request.url.startsWith('/api/auth/') ||
        request.url.startsWith('/internal/') ||
        request.url === '/health'
      )
        return;
      if (!request.headers.cookie) return;
      const session = await auth.api.getSession({ headers: toWebHeaders(request.headers) });
      request.user = session
        ? { id: session.user.id, email: session.user.email, name: session.user.name }
        : null;
    });

    const authHandler = async (request: FastifyRequest, reply: FastifyReply) => {
      const response = await auth.handler(toWebRequest(request, env.API_URL));
      return sendWebResponse(reply, response);
    };
    // Strict limits only where a request sends email or starts OAuth. Session checks
    // (get-session runs on every page load) stay under the generous global limit.
    for (const url of ['/api/auth/sign-in/*', '/api/auth/magic-link/*']) {
      app.route({
        method: ['GET', 'POST'],
        url,
        config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
        handler: authHandler,
      });
    }
    app.route({ method: ['GET', 'POST'], url: '/api/auth/*', handler: authHandler });
  }

  if (services) {
    const { ctx, station, requests, stage } = services;
    radioRoutes(app, ctx, station, requests, services.notify, services.listenerCount);
    if (services.afterStationRead) {
      const run = services.afterStationRead;
      app.addHook('onResponse', async (req) => {
        if (req.url.startsWith('/api/now-playing')) run();
      });
    }
    requestRoutes(app, ctx, requests);
    roundRoutes(app, ctx, station);
    stageRoutes(app, ctx, stage);
    socialRoutes(app, ctx);
    profileRoutes(app, ctx, {
      googleEnabled: services.googleEnabled,
      pushKey: services.pushKey,
      turnstileSiteKeyRequired: Boolean(env.TURNSTILE_SECRET_KEY),
    });
    adminRoutes(app, ctx, station, stage, services.listenerCount);
  } else {
    app.get('/api/me', { preHandler: requireUser }, async (request) => ({ user: request.user }));
  }

  return app;
}
