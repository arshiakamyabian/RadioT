'use client';

import { createAuthClient } from 'better-auth/react';
import { anonymousClient, magicLinkClient } from 'better-auth/client/plugins';
import { API_URL } from './env';

export const authClient = createAuthClient({
  baseURL: `${API_URL}/api/auth`,
  fetchOptions: { credentials: 'include' },
  plugins: [magicLinkClient(), anonymousClient()],
});
