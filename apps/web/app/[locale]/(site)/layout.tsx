import type { ReactNode } from 'react';
import { MiniPlayer } from '@/components/mini-player';
import { RequestToasts } from '@/components/request-dialog';
import { SiteHeader } from '@/components/site-header';

export default function SiteLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <SiteHeader />
      <main id="main" className="mx-auto max-w-6xl px-4 pt-5 pb-28 sm:pt-6">
        {children}
      </main>
      <MiniPlayer />
      <RequestToasts />
    </>
  );
}
