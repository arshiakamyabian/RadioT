import type { PublicUser } from '@radiot/shared';
import { serverApi } from '@/lib/api';
import { ogCard, ogSize } from '@/lib/og/card';

export const size = ogSize;
export const contentType = 'image/png';
export const alt = 'Profile on RadioT';

export default async function Og({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;
  const d = await serverApi<{ user: PublicUser; stats: { played: number } }>(
    `/api/profiles/${handle}`,
    300,
  );
  if (!d) return ogCard({ eyebrow: 'RadioT', title: 'Community radio' });
  return ogCard({
    eyebrow: `@${handle}`,
    title: d.user.name,
    subtitle: `${d.stats.played} songs played on RadioT`,
    art: d.user.avatarUrl,
  });
}
