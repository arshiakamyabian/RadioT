'use client';

import { useEffect, type ReactNode } from 'react';
import { Toaster } from 'sonner';
import type { NowPlaying } from '@radiot/shared';
import { initAnalytics } from '@/lib/analytics';
import { RadioProvider } from '@/lib/radio';
import { RealtimeProvider } from '@/lib/realtime';
import { Ambient } from './ambient';
import { GuestSession } from './guest-session';

export function Providers({
  children,
  initialNow,
}: {
  children: ReactNode;
  initialNow: NowPlaying | null;
}) {
  useEffect(() => {
    initAnalytics();
    if ('serviceWorker' in navigator && process.env.NODE_ENV === 'production') {
      void navigator.serviceWorker.register('/sw.js');
    }
  }, []);
  return (
    <RealtimeProvider>
      <GuestSession />
      <RadioProvider initialNow={initialNow}>
        <Ambient />
        {children}
        <Toaster theme="dark" position="top-center" richColors closeButton />
      </RadioProvider>
    </RealtimeProvider>
  );
}
