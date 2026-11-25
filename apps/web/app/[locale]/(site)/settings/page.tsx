import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import type { Locale } from '@radiot/shared';
import { SettingsForm } from './settings-form';

type Props = { params: Promise<{ locale: Locale }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Meta' });
  return { title: t('settingsTitle'), robots: { index: false } };
}

export default async function SettingsPage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('Meta');
  return (
    <div className="mx-auto max-w-lg">
      <h1 className="text-3xl font-black">{t('settingsTitle')}</h1>
      <SettingsForm />
    </div>
  );
}
