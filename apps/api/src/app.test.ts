import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { healthResponseSchema } from '@radiot/shared';
import { buildApp } from './app.js';
import { loadEnv } from './env.js';

const env = loadEnv({ NODE_ENV: 'test', BETTER_AUTH_SECRET: 'x'.repeat(32) });
let app: FastifyInstance;

afterEach(async () => {
  await app.close();
});

describe('api', () => {
  it('reports healthy when every check passes', async () => {
    app = await buildApp({ env, checks: { postgres: async () => true } });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = healthResponseSchema.parse(res.json());
    expect(body.checks.postgres).toBe('ok');
  });

  it('returns 503 when a dependency is down', async () => {
    app = await buildApp({ env, checks: { redis: async () => false } });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(503);
    expect(res.json().checks.redis).toBe('down');
  });

  it('rejects /api/me without a session', async () => {
    app = await buildApp({ env });
    const res = await app.inject({ method: 'GET', url: '/api/me' });
    expect(res.statusCode).toBe(401);
  });

  it('allows CORS from the web origin with credentials', async () => {
    app = await buildApp({ env });
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/me',
      headers: { origin: env.WEB_ORIGIN, 'access-control-request-method': 'GET' },
    });
    expect(res.headers['access-control-allow-origin']).toBe(env.WEB_ORIGIN);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('opens station data to any origin, but answers the web app with credentials', async () => {
    app = await buildApp({ env });
    const get = (origin: string) =>
      app.inject({ method: 'GET', url: '/api/now-playing', headers: { origin } });
    const embed = await get('https://example.org');
    expect(embed.headers['access-control-allow-origin']).toBe('*');
    const web = await get(env.WEB_ORIGIN);
    expect(web.headers['access-control-allow-origin']).toBe(env.WEB_ORIGIN);
    expect(web.headers['access-control-allow-credentials']).toBe('true');
  });
});

describe('auth rate limits', () => {
  it('limits magic-link sends strictly but not session checks', async () => {
    const fakeAuth = {
      handler: async () => new Response('{}', { status: 200 }),
      api: { getSession: async () => null },
    };
    // reason: a minimal stand-in for Better Auth's handler surface.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    app = await buildApp({ env, auth: fakeAuth as any });
    const send = () =>
      app.inject({ method: 'POST', url: '/api/auth/sign-in/magic-link', payload: {} });
    for (let i = 0; i < 10; i++) expect((await send()).statusCode).toBe(200);
    expect((await send()).statusCode).toBe(429);
    for (let i = 0; i < 40; i++) {
      expect((await app.inject({ method: 'GET', url: '/api/auth/get-session' })).statusCode).toBe(
        200,
      );
    }
  });
});
