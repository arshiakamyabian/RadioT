import type { MetadataRoute } from 'next';
import { LOCALES, type RequestPublic } from '@radiot/shared';
import { serverApi } from '@/lib/api';
import { SITE_URL } from '@/lib/env';

export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const entry = (
    path: string,
    priority: number,
    freq: MetadataRoute.Sitemap[number]['changeFrequency'],
    lastModified?: string,
  ): MetadataRoute.Sitemap[number] => ({
    url: `${SITE_URL}/en${path}`,
    lastModified: lastModified ?? new Date().toISOString(),
    changeFrequency: freq,
    priority,
    alternates: {
      languages: Object.fromEntries(LOCALES.map((l) => [l, `${SITE_URL}/${l}${path}`])),
    },
  });
  const history = await serverApi<{ requests: RequestPublic[] }>('/api/history', 3600);
  const handles = new Set(
    (history?.requests ?? []).flatMap((r) => (r.requester.handle ? [r.requester.handle] : [])),
  );
  return [
    entry('', 1, 'always'),
    entry('/charts', 0.8, 'hourly'),
    entry('/recent', 0.6, 'hourly'),
    ...(history?.requests ?? []).map((r) =>
      entry(`/history/${r.id}`, 0.5, 'weekly', r.playedAt ?? r.createdAt),
    ),
    ...[...handles].map((h) => entry(`/u/${h}`, 0.4, 'weekly')),
  ];
}
