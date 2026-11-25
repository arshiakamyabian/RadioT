'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Link } from '@/i18n/navigation';
import { api } from '@/lib/api';
import { useMe } from '@/lib/session';

function urlBase64ToUint8Array(base64: string) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export function SettingsForm() {
  const t = useTranslations('Profile');
  const tc = useTranslations('Common');
  const { me, profile, refresh } = useMe();
  const [pushOn, setPushOn] = useState(false);
  const [pushKey, setPushKey] = useState<string | null>(null);
  const pushSupported =
    typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window;

  useEffect(() => {
    void api<{ publicKey: string | null }>('/api/push/key')
      .then((r) => setPushKey(r.publicKey))
      .catch(() => {});
    if (pushSupported)
      void navigator.serviceWorker
        .getRegistration()
        .then((reg) => reg?.pushManager.getSubscription())
        .then((s) => setPushOn(Boolean(s)));
  }, [pushSupported]);

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const payload: Record<string, unknown> = {};
    for (const k of ['handle', 'displayName', 'bio'] as const) {
      const v = String(f.get(k) ?? '').trim();
      if (v) payload[k] = k === 'handle' ? v.toLowerCase() : v;
    }
    if (f.get('adult') === 'on') payload.ageConfirmedAdult = true;
    try {
      await api('/api/me/profile', { method: 'PATCH', json: payload });
      toast.success(t('saved'));
      refresh();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  async function togglePush(on: boolean) {
    if (!pushKey) return;
    const reg = await navigator.serviceWorker.register('/sw.js');
    if (on) {
      if ((await Notification.requestPermission()) !== 'granted') return;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(pushKey),
      });
      await api('/api/push/subscribe', { method: 'POST', json: sub.toJSON() });
    } else {
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await api('/api/push/subscribe', {
          method: 'DELETE',
          json: { endpoint: sub.endpoint },
        }).catch(() => {});
        await sub.unsubscribe();
      }
    }
    setPushOn(on);
  }

  if (!me) return <p className="mt-6 text-muted-foreground">{tc('loading')}</p>;

  return (
    <form onSubmit={save} className="mt-6 flex flex-col gap-4" key={profile?.handle ?? 'new'}>
      <div className="flex flex-col gap-2">
        <Label htmlFor="handle">{t('handle')}</Label>
        <Input
          id="handle"
          name="handle"
          defaultValue={profile?.handle ?? ''}
          pattern="[a-z0-9_]{3,24}"
          autoCapitalize="none"
          autoComplete="username"
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="displayName">{t('displayName')}</Label>
        <Input
          id="displayName"
          name="displayName"
          defaultValue={profile?.displayName ?? ''}
          maxLength={40}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="bio">{t('bio')}</Label>
        <textarea
          id="bio"
          name="bio"
          defaultValue={profile?.bio ?? ''}
          maxLength={280}
          rows={3}
          className="rounded-lg border border-input bg-card px-3 py-2 focus-visible:outline-2 focus-visible:outline-ring"
        />
      </div>
      {!profile?.ageConfirmedAdult && (
        <label className="flex items-start gap-3 text-sm">
          <input type="checkbox" name="adult" className="mt-1 size-4 accent-[var(--primary)]" />
          <span>{t('adult')}</span>
        </label>
      )}
      <Button type="submit">{t('save')}</Button>
      {pushKey &&
        (pushSupported ? (
          <label className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              checked={pushOn}
              onChange={(e) => void togglePush(e.target.checked)}
              className="mt-1 size-4 accent-[var(--primary)]"
            />
            <span>{t('notifications')}</span>
          </label>
        ) : (
          <p className="text-sm text-muted-foreground">{t('notificationsUnsupported')}</p>
        ))}
      {profile?.handle && (
        <Link
          href={`/u/${profile.handle}`}
          className="text-sm text-brand underline-offset-4 hover:underline"
        >
          {t('viewPublic')}
        </Link>
      )}
    </form>
  );
}
