'use client';

import { useEffect, useRef } from 'react';
import { TURNSTILE_SITE_KEY } from '@/lib/env';

declare global {
  interface Window {
    turnstile?: {
      render: (
        el: HTMLElement,
        opts: {
          sitekey: string;
          callback: (t: string) => void;
          'expired-callback': () => void;
          size?: string;
        },
      ) => string;
      remove: (id: string) => void;
    };
  }
}

let scriptPromise: Promise<void> | null = null;
function loadScript() {
  scriptPromise ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = reject;
    document.head.appendChild(s);
  });
  return scriptPromise;
}

export const turnstileEnabled = Boolean(TURNSTILE_SITE_KEY);

/** Cloudflare Turnstile widget. Renders nothing (and needs no token) when not configured. */
export function Turnstile({ onToken }: { onToken: (token: string | undefined) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!turnstileEnabled || !ref.current) return;
    let id: string | undefined;
    void loadScript().then(() => {
      if (!ref.current || !window.turnstile) return;
      id = window.turnstile.render(ref.current, {
        sitekey: TURNSTILE_SITE_KEY,
        callback: onToken,
        'expired-callback': () => onToken(undefined),
        size: 'flexible',
      });
    });
    return () => {
      if (id) window.turnstile?.remove(id);
    };
  }, [onToken]);
  return turnstileEnabled ? <div ref={ref} className="min-h-16" /> : null;
}
