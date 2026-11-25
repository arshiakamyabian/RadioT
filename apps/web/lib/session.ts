'use client';

import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { authClient } from './auth-client';
import { identify } from './analytics';

export interface Me {
  id: string;
  email: string;
  name: string;
  handle: string | null;
  avatarUrl: string | null;
  role: 'user' | 'admin';
}
export interface MeProfile {
  handle: string | null;
  displayName: string | null;
  bio: string | null;
  ageConfirmedAdult: boolean;
  locale: string;
}

/** Session from Better Auth plus our profile/role from the API. */
export function useMe() {
  const session = authClient.useSession();
  // Better Auth briefly reports no data while it refetches the session (focus, interval); keep the
  // last known user through that instead of flickering signed-out and remounting the page.
  const lastUserId = useRef<string | null>(null);
  if (!session.isPending) lastUserId.current = session.data?.user.id ?? null;
  const userId = session.isPending ? lastUserId.current : (session.data?.user.id ?? null);
  const [me, setMe] = useState<{ user: Me; profile: MeProfile | null } | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!userId) {
      setMe(null);
      return;
    }
    let live = true;
    api<{ user: Me; profile: MeProfile | null }>('/api/me')
      .then((r) => {
        if (!live) return;
        setMe(r);
        identify(r.user.id);
      })
      .catch(
        () =>
          live &&
          setMe({
            user: { id: userId, email: '', name: '', handle: null, avatarUrl: null, role: 'user' },
            profile: null,
          }),
      );
    return () => {
      live = false;
    };
  }, [userId, version]);

  return {
    me: me?.user ?? null,
    profile: me?.profile ?? null,
    // Still pending until the role has arrived: pages that redirect non-admins act on this.
    pending: session.isPending || (userId !== null && me?.user.id !== userId),
    refresh: () => setVersion((v) => v + 1),
  };
}
