import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import type { Locale } from '@radiot/shared';
import { SERVER_API_URL } from '@/lib/env';
import { alternates } from '@/lib/seo';
import { SignInForm } from './sign-in-form';

type Props = { params: Promise<{ locale: Locale }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Meta' });
  return {
    title: t('signInTitle'),
    alternates: alternates(locale, '/sign-in'),
    robots: { index: false, follow: true },
  };
}

async function googleEnabled() {
  try {
    const res = await fetch(`${SERVER_API_URL}/api/auth-config`, { next: { revalidate: 60 } });
    if (!res.ok) return false;
    const body: unknown = await res.json();
    return typeof body === 'object' && body !== null && 'google' in body && body.google === true;
  } catch {
    return false;
  }
}

export default async function SignInPage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-6">
      <SignInForm locale={locale} google={await googleEnabled()} />
    </main>
  );
}
