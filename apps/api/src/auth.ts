import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { anonymous, magicLink } from 'better-auth/plugins';
import { STATION_NAME } from '@radiot/shared';
import { schema, type Database } from '@radiot/db';
import type { Env } from './env.js';
import type { Mailer } from './mailer.js';

export function createAuth(env: Env, db: Database, mailer: Mailer) {
  const google =
    env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
      ? { google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } }
      : {};

  return betterAuth({
    appName: STATION_NAME,
    baseURL: env.API_URL,
    basePath: '/api/auth',
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: env.webOrigins,
    database: drizzleAdapter(db, {
      provider: 'pg',
      usePlural: true,
      schema: {
        users: schema.users,
        sessions: schema.sessions,
        accounts: schema.accounts,
        verifications: schema.verifications,
      },
    }),
    socialProviders: google,
    advanced: env.COOKIE_DOMAIN
      ? { crossSubDomainCookies: { enabled: true, domain: env.COOKIE_DOMAIN } }
      : {},
    plugins: [
      // Guest mode: every visitor gets an invisible account so they can request, vote and chat
      // without email. Signing in later with a magic link upgrades the guest account.
      anonymous({
        emailDomainName: 'guest.radiot.local',
        generateName: () => `Listener ${Math.floor(1000 + Math.random() * 9000)}`,
      }),
      magicLink({
        expiresIn: 60 * 10,
        async sendMagicLink({ email, url }) {
          await mailer.send({
            to: email,
            subject: `Sign in to ${STATION_NAME}`,
            text: `Sign in to ${STATION_NAME}: ${url}\n\nThis link expires in 10 minutes.`,
            html: `<p><a href="${url}">Sign in to ${STATION_NAME}</a></p><p>This link expires in 10 minutes.</p>`,
          });
        },
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
export const isGoogleEnabled = (env: Env) =>
  Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
