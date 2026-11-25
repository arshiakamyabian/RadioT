import type { RequestPublic } from '@radiot/shared';
import { serverApi } from '@/lib/api';
import { ogCard, ogSize } from '@/lib/og/card';

export const size = ogSize;
export const contentType = 'image/png';
export const alt = 'RadioT weekly chart';
export const revalidate = 3600;

export default async function Og() {
  const top = (
    await serverApi<{ entries: { request: RequestPublic }[] }>('/api/charts/weekly', 3600)
  )?.entries[0]?.request;
  return ogCard({
    eyebrow: 'Weekly chart',
    title: top ? `#1 ${top.title}` : 'This week on RadioT',
    subtitle: top ? `Requested by ${top.requester.name}` : 'The community picks every song',
    art: top?.artworkUrl,
  });
}
