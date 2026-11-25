import type { Metadata } from 'next';
import {
  LOCALES,
  STATION_NAME,
  type Locale,
  type NowPlaying,
  type PublicUser,
  type RequestPublic,
} from '@radiot/shared';
import { SITE_URL } from './env';

export function localizedUrl(locale: Locale, path = '', base = SITE_URL) {
  const clean = path === '/' ? '' : path;
  return new URL(`/${locale}${clean}`, base).toString();
}

export function alternates(locale: Locale, path = '', base = SITE_URL): Metadata['alternates'] {
  const languages: Record<string, string> = Object.fromEntries(
    LOCALES.map((l) => [l, localizedUrl(l, path, base)]),
  );
  languages['x-default'] = localizedUrl('en', path, base);
  return { canonical: localizedUrl(locale, path, base), languages };
}

/** Standard metadata for an indexable page: canonical, hreflang, OG and Twitter cards. */
export function pageMetadata(opts: {
  locale: Locale;
  path: string;
  title: string;
  description: string;
  absoluteTitle?: boolean;
  type?: 'website' | 'profile' | 'music.song';
}): Metadata {
  return {
    title: opts.absoluteTitle ? { absolute: opts.title } : opts.title,
    description: opts.description,
    alternates: alternates(opts.locale, opts.path),
    openGraph: {
      type:
        opts.type === 'music.song' ? 'music.song' : opts.type === 'profile' ? 'profile' : 'website',
      siteName: STATION_NAME,
      title: opts.title,
      description: opts.description,
      locale: opts.locale,
      url: localizedUrl(opts.locale, opts.path),
    },
    twitter: { card: 'summary_large_image', title: opts.title, description: opts.description },
  };
}

export function radioStationJsonLd(locale: Locale, description: string, base = SITE_URL) {
  return {
    '@context': 'https://schema.org',
    '@type': 'RadioStation',
    name: STATION_NAME,
    url: localizedUrl(locale, '', base),
    description,
    inLanguage: locale,
    logo: new URL('/icon.svg', base).toString(),
  };
}

export function homeJsonLd(
  locale: Locale,
  description: string,
  now: NowPlaying | null,
  base = SITE_URL,
) {
  const station = radioStationJsonLd(locale, description, base);
  const graph: Record<string, unknown>[] = [
    station,
    {
      '@type': 'BroadcastService',
      name: `${STATION_NAME} live`,
      broadcaster: { '@type': 'RadioStation', name: STATION_NAME },
      broadcastDisplayName: STATION_NAME,
      inLanguage: locale,
      url: localizedUrl(locale, '', base),
    },
  ];
  if (now && now.kind !== 'unknown') {
    graph.push({
      '@type': 'MusicRecording',
      name: now.title,
      byArtist: now.artist ? { '@type': 'MusicGroup', name: now.artist } : undefined,
      duration: isoDuration(now.durationMs),
    });
  }
  return {
    '@context': 'https://schema.org',
    '@graph': graph.map(({ ['@context']: _c, ...rest }) => rest),
  };
}

export function musicRecordingJsonLd(locale: Locale, r: RequestPublic, base = SITE_URL) {
  return {
    '@context': 'https://schema.org',
    '@type': 'MusicRecording',
    name: r.title,
    url: localizedUrl(locale, `/history/${r.id}`, base),
    byArtist: r.artist ? { '@type': 'MusicGroup', name: r.artist } : undefined,
    duration: r.durationMs ? isoDuration(r.durationMs) : undefined,
    image: r.artworkUrl ?? undefined,
    datePublished: r.playedAt ?? r.createdAt,
  };
}

export function profilePageJsonLd(locale: Locale, user: PublicUser, base = SITE_URL) {
  return {
    '@context': 'https://schema.org',
    '@type': 'ProfilePage',
    url: localizedUrl(locale, `/u/${user.handle}`, base),
    mainEntity: {
      '@type': 'Person',
      name: user.name,
      alternateName: user.handle ? `@${user.handle}` : undefined,
      image: user.avatarUrl ?? undefined,
    },
  };
}

export function isoDuration(ms: number) {
  const s = Math.round(ms / 1000);
  return `PT${Math.floor(s / 60)}M${s % 60}S`;
}
