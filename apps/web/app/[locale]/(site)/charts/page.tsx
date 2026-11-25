import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import type { Locale, RequestPublic } from '@radiot/shared';
import { Link } from '@/i18n/navigation';
import { serverApi } from '@/lib/api';
import { JsonLd } from '@/components/json-ld';
import { pageMetadata } from '@/lib/seo';
import { SITE_URL } from '@/lib/env';

type Props = { params: Promise<{ locale: Locale }> };
type Entry = { rank: number; votes: number; request: RequestPublic };
export const revalidate = 300;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Meta' });
  return pageMetadata({
    locale,
    path: '/charts',
    title: t('chartsTitle'),
    description: t('chartsDescription'),
  });
}

export default async function ChartsPage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('Charts');
  const data = await serverApi<{ entries: Entry[] }>('/api/charts/weekly', 300);
  const entries = data?.entries ?? [];
  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-3xl font-black">{t('title')}</h1>
      {!entries.length ? (
        <p className="mt-6 text-muted-foreground">{t('empty')}</p>
      ) : (
        <ol className="mt-6 flex flex-col gap-2">
          {entries.map((e) => (
            <li
              key={e.request.id}
              className="flex items-center gap-4 rounded-2xl bg-white/5 p-4 ring-1 ring-white/10"
            >
              <span className="w-8 text-2xl font-black tabular-nums text-brand">{e.rank}</span>
              <div className="min-w-0 flex-1">
                <Link
                  href={`/history/${e.request.id}`}
                  className="block truncate font-semibold hover:underline"
                >
                  {e.request.title}
                </Link>
                <p className="truncate text-sm text-muted-foreground">
                  {e.request.artist ? `${e.request.artist} · ` : ''}
                  {e.request.requester.name}
                </p>
              </div>
              <span className="text-sm text-muted-foreground">
                {t('votes', { count: e.votes })}
              </span>
            </li>
          ))}
        </ol>
      )}
      <JsonLd
        data={{
          '@context': 'https://schema.org',
          '@type': 'MusicPlaylist',
          name: t('title'),
          numTracks: entries.length,
          track: entries.map((e) => ({
            '@type': 'MusicRecording',
            name: e.request.title,
            url: `${SITE_URL}/${locale}/history/${e.request.id}`,
          })),
        }}
      />
    </div>
  );
}
