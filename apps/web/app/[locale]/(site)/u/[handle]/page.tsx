import type { Metadata } from 'next';
import Image from 'next/image';
import { notFound } from 'next/navigation';
import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server';
import type { Locale, PublicUser, RequestPublic } from '@radiot/shared';
import { Link } from '@/i18n/navigation';
import { serverApi } from '@/lib/api';
import { JsonLd } from '@/components/json-ld';
import { pageMetadata, profilePageJsonLd } from '@/lib/seo';

type Props = { params: Promise<{ locale: Locale; handle: string }> };
type ProfileData = {
  user: PublicUser;
  profile: { bio: string | null; badges: string[]; createdAt: string };
  requests: RequestPublic[];
  stats: { played: number };
};
export const revalidate = 120;

const load = (handle: string) =>
  /^[a-z0-9_]{3,24}$/.test(handle)
    ? serverApi<ProfileData>(`/api/profiles/${handle}`, 120)
    : Promise.resolve(null);

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, handle } = await params;
  const data = await load(handle);
  if (!data) return { robots: { index: false } };
  const t = await getTranslations({ locale, namespace: 'Meta' });
  return pageMetadata({
    locale,
    path: `/u/${handle}`,
    title: t('profileTitle', { name: data.user.name }),
    description: data.profile.bio || t('profileDescription', { name: data.user.name }),
    type: 'profile',
  });
}

export default async function ProfilePage({ params }: Props) {
  const { locale, handle } = await params;
  setRequestLocale(locale);
  const data = await load(handle);
  if (!data) notFound();
  const t = await getTranslations('Profile');
  const ts = await getTranslations('Request.status');
  const format = await getFormatter();
  return (
    <div className="mx-auto max-w-2xl">
      <header className="flex items-center gap-4">
        <div className="grid size-20 place-items-center overflow-hidden rounded-full bg-card text-3xl font-black text-brand ring-1 ring-border">
          {data.user.avatarUrl ? (
            <Image
              src={data.user.avatarUrl}
              alt=""
              width={160}
              height={160}
              className="size-full object-cover"
            />
          ) : (
            data.user.name.slice(0, 1).toUpperCase()
          )}
        </div>
        <div>
          <h1 className="text-2xl font-black">{data.user.name}</h1>
          <p className="text-muted-foreground">@{handle}</p>
          <p className="text-sm text-muted-foreground">
            {t('played', { count: data.stats.played })} ·{' '}
            {t('memberSince', {
              date: format.dateTime(new Date(data.profile.createdAt), {
                year: 'numeric',
                month: 'long',
              }),
            })}
          </p>
        </div>
      </header>
      {data.profile.bio && <p className="mt-4">{data.profile.bio}</p>}
      <h2 className="mt-8 text-lg font-bold">{t('requests')}</h2>
      <ul className="mt-3 flex flex-col gap-2">
        {data.requests.map((r) => (
          <li
            key={r.id}
            className="flex items-center gap-3 rounded-2xl bg-white/5 p-3 ring-1 ring-white/10"
          >
            <Link
              href={`/history/${r.id}`}
              className="min-w-0 flex-1 truncate font-semibold hover:underline"
            >
              {r.title}
            </Link>
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs">{ts(r.status)}</span>
          </li>
        ))}
      </ul>
      <JsonLd data={profilePageJsonLd(locale, data.user)} />
    </div>
  );
}
