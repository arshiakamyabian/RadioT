import type { Metadata } from 'next';
import Image from 'next/image';
import { notFound } from 'next/navigation';
import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server';
import type { Locale, RequestPublic } from '@radiot/shared';
import { ShareButton } from '@/components/share-button';
import { Button } from '@/components/ui/button';
import { Link } from '@/i18n/navigation';
import { serverApi } from '@/lib/api';
import { JsonLd } from '@/components/json-ld';
import { musicRecordingJsonLd, pageMetadata } from '@/lib/seo';

type Props = { params: Promise<{ locale: Locale; id: string }> };
export const revalidate = 60;

const load = (id: string) =>
  /^[0-9a-f-]{36}$/i.test(id)
    ? serverApi<{ request: RequestPublic }>(`/api/requests/${id}`, 60)
    : Promise.resolve(null);

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, id } = await params;
  const data = await load(id);
  if (!data) return { robots: { index: false } };
  const t = await getTranslations({ locale, namespace: 'Meta' });
  return pageMetadata({
    locale,
    path: `/history/${id}`,
    title: t('historyTitle', { title: data.request.title }),
    description: t('historyDescription', { name: data.request.requester.name }),
    type: 'music.song',
  });
}

export default async function HistoryPage({ params }: Props) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const data = await load(id);
  if (!data) notFound();
  const r = data.request;
  const t = await getTranslations('History');
  const ts = await getTranslations('Request.status');
  const format = await getFormatter();
  return (
    <article className="mx-auto flex max-w-xl flex-col items-center gap-6 text-center">
      <div className="grid size-48 place-items-center overflow-hidden rounded-2xl bg-card text-6xl ring-1 ring-border">
        {r.artworkUrl ? (
          <Image
            src={r.artworkUrl}
            alt=""
            width={384}
            height={384}
            priority
            className="size-full object-cover"
          />
        ) : (
          <span aria-hidden>🎵</span>
        )}
      </div>
      <div>
        <h1 className="text-3xl font-black">{r.title}</h1>
        {r.artist && <p className="mt-1 text-lg text-muted-foreground">{r.artist}</p>}
      </div>
      <dl className="grid w-full grid-cols-2 gap-3 text-sm">
        <div className="rounded-2xl bg-white/5 p-3 ring-1 ring-white/10">
          <dt className="text-muted-foreground">{t('requestedBy')}</dt>
          <dd className="font-semibold">
            {r.requester.handle ? (
              <Link href={`/u/${r.requester.handle}`} className="hover:underline">
                {r.requester.name}
              </Link>
            ) : (
              r.requester.name
            )}
          </dd>
        </div>
        <div className="rounded-2xl bg-white/5 p-3 ring-1 ring-white/10">
          <dt className="text-muted-foreground">{t('status')}</dt>
          <dd className="font-semibold">{ts(r.status)}</dd>
        </div>
      </dl>
      {r.playedAt && (
        <p className="text-sm text-muted-foreground">
          {t('playedAt', {
            date: format.dateTime(new Date(r.playedAt), {
              dateStyle: 'medium',
              timeStyle: 'short',
            }),
          })}
        </p>
      )}
      <div className="flex flex-wrap justify-center gap-2">
        <Button asChild size="lg">
          <Link href="/">{r.status === 'ready' ? t('voteForMe') : t('listen')}</Link>
        </Button>
        <ShareButton
          path={`/${locale}/history/${r.id}`}
          title={r.title}
          campaign={r.status === 'ready' ? 'vote_for_me' : 'song_won'}
        />
      </div>
      <JsonLd data={musicRecordingJsonLd(locale, r)} />
    </article>
  );
}
