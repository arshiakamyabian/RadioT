export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000';
const CONFIGURED_API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
// When the API sits behind the web's own /api rewrite, browsers call whichever host name they opened
// (the site answers on more than one, and the auth cookie must stay first-party to that host).
export const API_URL =
  typeof window !== 'undefined' && CONFIGURED_API_URL === SITE_URL
    ? window.location.origin
    : CONFIGURED_API_URL;
// Socket.IO can't ride the web's /api rewrite (no WebSocket upgrades), so it can point at the API's own origin.
export const SOCKET_URL = process.env.NEXT_PUBLIC_SOCKET_URL || API_URL;
// Server-side fetches skip the proxy hop when the API sits behind the web's /api rewrite.
export const SERVER_API_URL = process.env.API_PROXY_TARGET || API_URL;
export const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? '';
export const POSTHOG_KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY ?? '';
export const POSTHOG_HOST = process.env.NEXT_PUBLIC_POSTHOG_HOST ?? 'https://eu.i.posthog.com';
/** The stream engine (HLS, MP3 fallback, now-playing). Not on Vercel: it needs an always-on box. */
export const ENGINE_URL = (process.env.NEXT_PUBLIC_ENGINE_URL ?? 'http://localhost:4200').replace(
  /\/$/,
  '',
);
/** The engine as reached through the site's /stream rewrite (same origin, never blocked separately). */
export const STREAM_BASE = process.env.NEXT_PUBLIC_ENGINE_URL ? '/stream' : ENGINE_URL;
