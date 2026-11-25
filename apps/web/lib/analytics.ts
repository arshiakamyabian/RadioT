'use client';

import { POSTHOG_HOST, POSTHOG_KEY } from './env';

type Props = Record<string, string | number | boolean | null>;
type PostHog = { capture: (e: string, p?: Props) => void; identify: (id: string) => void };

let client: PostHog | null = null;
let loading: Promise<void> | null = null;

/** PostHog, loaded lazily and only when a key is configured. */
export function initAnalytics() {
  if (!POSTHOG_KEY || loading || typeof window === 'undefined') return;
  loading = import('posthog-js').then(({ default: posthog }) => {
    posthog.init(POSTHOG_KEY, {
      api_host: POSTHOG_HOST,
      capture_pageview: true,
      persistence: 'localStorage+cookie',
    });
    client = posthog;
  });
}

export function track(
  event:
    | 'listen_start'
    | 'sign_in_requested'
    | 'request_submitted'
    | 'vote_cast'
    | 'share_clicked'
    | 'go_live'
    | 'reaction_sent',
  props?: Props,
) {
  client?.capture(event, props);
}

export function identify(userId: string) {
  client?.identify(userId);
}
