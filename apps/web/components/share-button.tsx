'use client';

import { Share2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { track } from '@/lib/analytics';
import { SITE_URL } from '@/lib/env';
import { Button } from './ui/button';

export function shareUrl(path: string, campaign: string) {
  const url = new URL(path, SITE_URL);
  url.searchParams.set('utm_source', 'share');
  url.searchParams.set('utm_medium', 'social');
  url.searchParams.set('utm_campaign', campaign);
  return url.toString();
}

export function ShareButton({
  path,
  title,
  campaign,
}: {
  path: string;
  title: string;
  campaign: string;
}) {
  const t = useTranslations('Vote');
  async function onClick() {
    const url = shareUrl(path, campaign);
    track('share_clicked', { campaign });
    if (navigator.share) {
      await navigator.share({ title, url }).catch(() => {});
      return;
    }
    await navigator.clipboard.writeText(url);
    toast.success(t('copied'));
  }
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => void onClick()}
      aria-label={`${t('share')}: ${title}`}
    >
      <Share2 className="size-4" aria-hidden />
      <span className="sr-only sm:not-sr-only">{t('share')}</span>
    </Button>
  );
}
