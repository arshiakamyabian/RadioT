import type { Metadata } from 'next';
import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server';
import type { Locale, RequestPublic } from '@radiot/shared';
import { Link } from '@/i18n/navigation';
import { serverApi } from '@/lib/api';
import { pageMetadata } from '@/lib/seo';

type Props = { params: Promise<{ locale: Locale }> };
export const revalidate = 60;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Meta' });
  return pageMetadata({
    locale,
    path: '/recent',
    title: t('recentTitle'),
    description: t('homeDescription'),
  });
}

export default async function RecentPage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('Meta');
  const tc = await getTranslations('Charts');
  const format = await getFormatter();
  const data = await serverApi<{ requests: RequestPublic[] }>('/api/history', 60);
  const items = data?.requests ?? [];
  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-3xl font-black">{t('recentTitle')}</h1>
      {!items.length ? (
        <p className="mt-6 text-muted-foreground">{tc('empty')}</p>
      ) : (
        <ol className="mt-6 flex flex-col gap-2">
          {items.map((r) => (
            <li
              key={r.id}
              className="flex items-center gap-4 rounded-2xl bg-white/5 p-4 ring-1 ring-white/10"
            >
              <div className="min-w-0 flex-1">
                <Link
                  href={`/history/${r.id}`}
                  className="block truncate font-semibold hover:underline"
                >
                  {r.title}
                </Link>
                <p className="truncate text-sm text-muted-foreground">{r.requester.name}</p>
              </div>
              {r.playedAt && (
                <time dateTime={r.playedAt} className="text-xs text-muted-foreground">
                  {format.relativeTime(new Date(r.playedAt))}
                </time>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
