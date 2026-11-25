import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import type { Locale } from '@radiot/shared';
import { RequestDialog } from '@/components/request-dialog';
import { pageMetadata } from '@/lib/seo';

type Props = { params: Promise<{ locale: Locale }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Meta' });
  const r = await getTranslations({ locale, namespace: 'Request' });
  return pageMetadata({
    locale,
    path: '/request',
    title: t('requestTitle'),
    description: r('intro'),
  });
}

export default async function RequestPage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('Request');
  return (
    <div className="mx-auto flex max-w-xl flex-col gap-4">
      <h1 className="text-3xl font-black">{t('title')}</h1>
      <p className="text-muted-foreground">{t('intro')}</p>
      <RequestDialog inline />
    </div>
  );
}
