import type { RequestPublic } from '@radiot/shared';
import { serverApi } from '@/lib/api';
import { ogCard, ogSize } from '@/lib/og/card';

export const size = ogSize;
export const contentType = 'image/png';
export const alt = 'Song on RadioT';

export default async function Og({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = (await serverApi<{ request: RequestPublic }>(`/api/requests/${id}`, 300))?.request;
  if (!r) return ogCard({ eyebrow: 'RadioT', title: 'Community radio' });
  const eyebrow =
    r.status === 'ready'
      ? 'Vote for this song'
      : r.status === 'played' || r.status === 'playing' || r.status === 'queued'
        ? 'Song won the vote'
        : 'Requested on RadioT';
  return ogCard({
    eyebrow,
    title: r.title,
    subtitle: `Requested by ${r.requester.name}`,
    art: r.artworkUrl,
  });
}
