import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import type { Locale, NowPlaying } from '@radiot/shared';
import { Chat } from '@/components/chat';
import { NowPlayingCard } from '@/components/now-playing';
import { Reactions } from '@/components/reactions';
import { RequestDialog } from '@/components/request-dialog';
import { Stage } from '@/components/stage';
import { TuneInGate } from '@/components/tune-in-gate';
import { VotePanel } from '@/components/vote-panel';
import { serverApi } from '@/lib/api';
import { JsonLd } from '@/components/json-ld';
import { homeJsonLd, pageMetadata } from '@/lib/seo';

type Props = { params: Promise<{ locale: Locale }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Meta' });
  return pageMetadata({
    locale,
    path: '',
    title: t('homeTitle'),
    description: t('homeDescription'),
    absoluteTitle: true,
  });
}

export default async function HomePage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const meta = await getTranslations('Meta');
  const tr = await getTranslations('Request');
  const initial = await serverApi<{ now: NowPlaying | null }>('/api/now-playing', 5);

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_22rem] lg:gap-5">
      <div className="flex min-w-0 flex-col gap-4 lg:gap-5">
        <NowPlayingCard />
        <Reactions />
        <Stage />
        <div className="reveal">
          <VotePanel />
        </div>
      </div>
      <aside className="flex flex-col gap-4 lg:gap-5">
        <section aria-labelledby="line-title" className="glass reveal relative overflow-hidden p-5">
          <div
            aria-hidden
            className="absolute -top-16 -right-16 size-40 rounded-full bg-brand/25 blur-3xl"
          />
          <p className="legend">{tr('lineEyebrow')}</p>
          <h2 id="line-title" className="mt-1 text-lg font-bold">
            {tr('lineTitle')}
          </h2>
          <p className="mt-1 mb-3 text-sm text-muted-foreground">{tr('lineBody')}</p>
          <RequestDialog />
        </section>
        <Chat />
      </aside>
      <TuneInGate />
      <JsonLd data={homeJsonLd(locale, meta('homeDescription'), initial?.now ?? null)} />
    </div>
  );
}
