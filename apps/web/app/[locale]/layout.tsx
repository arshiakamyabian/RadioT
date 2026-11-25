import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import { notFound } from 'next/navigation';
import { NextIntlClientProvider, hasLocale } from 'next-intl';
import { setRequestLocale } from 'next-intl/server';
import type { ReactNode } from 'react';
import { STATION_NAME, type NowPlaying } from '@radiot/shared';
import { Providers } from '@/components/providers';
import { routing } from '@/i18n/routing';
import { serverApi } from '@/lib/api';
import { SITE_URL } from '@/lib/env';
import '../globals.css';

const sans = Geist({ subsets: ['latin', 'latin-ext'], variable: '--font-geist', display: 'swap' });
const mono = Geist_Mono({
  subsets: ['latin', 'latin-ext'],
  variable: '--font-geist-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: STATION_NAME, template: `%s · ${STATION_NAME}` },
  applicationName: STATION_NAME,
  icons: { icon: '/icon.svg', apple: '/icon.svg' },
  appleWebApp: { capable: true, title: STATION_NAME, statusBarStyle: 'black-translucent' },
};

export const viewport: Viewport = {
  themeColor: '#151412',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  const initial = await serverApi<{ now: NowPlaying | null }>('/api/now-playing', 5);

  return (
    <html lang={locale} className={`dark ${sans.variable} ${mono.variable}`}>
      <body className="min-h-dvh font-sans">
        <NextIntlClientProvider>
          <Providers initialNow={initial?.now ?? null}>{children}</Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
