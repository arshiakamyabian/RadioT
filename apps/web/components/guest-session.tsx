'use client';

import { useEffect, useRef } from 'react';
import { authClient } from '@/lib/auth-client';

/**
 * Guest mode: anyone who arrives without a session gets an invisible guest account, so they can
 * request songs, vote and chat with no email or sign-in screen.
 */
export function GuestSession() {
  const { data, isPending } = authClient.useSession();
  const started = useRef(false);
  useEffect(() => {
    if (isPending || data || started.current) return;
    started.current = true;
    void authClient.signIn.anonymous().then(({ error }) => {
      if (error) started.current = false;
    });
  }, [isPending, data]);
  return null;
}
