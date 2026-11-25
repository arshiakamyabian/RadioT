import type { Metadata } from 'next';
import { setRequestLocale } from 'next-intl/server';
import { STATION_NAME, type Locale } from '@radiot/shared';
import { MiniPlayer } from '@/components/mini-player';
import { SITE_URL } from '@/lib/env';

type Props = { params: Promise<{ locale: Locale }> };

export const metadata: Metadata = { title: `${STATION_NAME} player`, robots: { index: false } };

/** Lightweight iframe player for other sites: <iframe src="https://radiot.app/en/embed" height="64">. */
export default async function EmbedPage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  return (
    <div className="relative h-dvh">
      <a
        href={`${SITE_URL}/${locale}?utm_source=embed&utm_medium=iframe&utm_campaign=embed`}
        target="_blank"
        rel="noopener"
        className="absolute right-3 top-2 text-xs font-black text-brand"
      >
        {STATION_NAME} ↗
      </a>
      <MiniPlayer />
    </div>
  );
}
