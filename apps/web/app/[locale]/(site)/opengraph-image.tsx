import { STATION_NAME, STATION_TAGLINE, type NowPlaying } from '@radiot/shared';
import { serverApi } from '@/lib/api';
import { ogCard, ogSize } from '@/lib/og/card';

export const size = ogSize;
export const contentType = 'image/png';
export const alt = STATION_NAME;
export const revalidate = 60;

export default async function OgImage() {
  const now = (await serverApi<{ now: NowPlaying | null }>('/api/now-playing', 30))?.now;
  if (!now || now.kind === 'unknown')
    return ogCard({ eyebrow: 'Live now', title: STATION_NAME, subtitle: STATION_TAGLINE });
  return ogCard({
    eyebrow: 'Live now',
    title: now.title,
    subtitle: now.requester ? `Requested by ${now.requester.name}` : now.artist,
    art: now.artworkUrl,
  });
}
