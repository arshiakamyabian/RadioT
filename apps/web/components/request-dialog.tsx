'use client';

import { Loader2, Upload } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { audioMimeFor, type RequestPublic, type UploadTicket } from '@radiot/shared';
import { api } from '@/lib/api';
import { track } from '@/lib/analytics';
import { useSocketEvent } from '@/lib/realtime';
import { useMe } from '@/lib/session';
import { cn } from '@/lib/utils';
import { Turnstile } from './turnstile';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';

const MAX_MB = 150;

/** Straight from the browser to Vercel Blob; large files go up in parts with built-in retries. */
async function uploadToBlob(
  upload: UploadTicket['upload'],
  file: File,
  onProgress: (pct: number) => void,
) {
  const { put } = await import('@vercel/blob/client');
  await put(upload.pathname, file, {
    access: 'public',
    token: upload.token,
    contentType: upload.contentType,
    multipart: file.size > 20 * 1024 * 1024,
    onUploadProgress: (e) => onProgress(Math.min(99, Math.round(e.percentage))),
  });
}

/** `inline` renders the form directly (the /request page); otherwise a button opens it in a dialog. */
export function RequestDialog({ inline = false }: { inline?: boolean }) {
  const t = useTranslations('Request');
  const { me } = useMe();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [mode, setMode] = useState<'upload' | 'link'>('upload');
  const [rights, setRights] = useState(false);
  const [token, setToken] = useState<string | undefined>();
  const [progress, setProgress] = useState<number | null>(null);
  const [phase, setPhase] = useState<'uploading' | 'sending' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mine, setMine] = useState<RequestPublic[]>([]);

  const loadMine = useCallback(() => {
    if (me)
      void api<{ requests: RequestPublic[] }>('/api/requests/mine')
        .then((r) => setMine(r.requests))
        .catch(() => {});
  }, [me]);
  useEffect(loadMine, [loadMine]);
  useSocketEvent('request:status', loadMine);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const form = new FormData(e.currentTarget);
    try {
      if (mode === 'upload') {
        const file = form.get('file');
        if (!(file instanceof File) || !file.size) throw new Error(t('file', { mb: MAX_MB }));
        const contentType = audioMimeFor(file.name, file.type);
        if (!contentType) throw new Error(t('badType'));
        if (file.size > MAX_MB * 1024 * 1024) throw new Error(t('tooBig', { mb: MAX_MB }));
        setPhase('uploading');
        setProgress(0);
        const ticket = await api<UploadTicket>('/api/requests/upload', {
          method: 'POST',
          json: {
            filename: file.name,
            contentType,
            size: file.size,
            rightsConfirmed: rights,
            turnstileToken: token,
          },
        });
        try {
          await uploadToBlob(ticket.upload, file, setProgress);
        } catch {
          // Free the slot so a failed upload doesn't count against the user's request limit.
          void api(`/api/requests/${ticket.request.id}`, { method: 'DELETE' }).catch(() => {});
          throw new Error(t('uploadFailed'));
        }
        setPhase('sending');
        await api(`/api/requests/${ticket.request.id}/confirm`, { method: 'POST', json: {} });
      } else {
        setPhase('sending');
        await api('/api/requests/url', {
          method: 'POST',
          json: {
            url: String(form.get('url') ?? ''),
            rightsConfirmed: rights,
            turnstileToken: token,
          },
        });
      }
      track('request_submitted', { source: mode });
      toast.success(t('processing'));
      if (inline) (e.target as HTMLFormElement).reset();
      else dialogRef.current?.close();
      setRights(false);
      loadMine();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setProgress(null);
      setPhase(null);
    }
  }

  async function withdraw(id: string) {
    await api(`/api/requests/${id}`, { method: 'DELETE' }).catch((err: Error) =>
      toast.error(err.message),
    );
    loadMine();
  }

  // The guest account is created automatically on first visit; this only shows for a moment.
  if (!me) {
    return (
      <Button className="w-full" disabled>
        {inline ? '…' : t('open')}
      </Button>
    );
  }

  const form = (
    <form onSubmit={onSubmit} className="flex flex-col gap-4 p-5">
      <h2 id="req-title" className={cn('text-xl font-bold', inline && 'sr-only')}>
        {t('title')}
      </h2>
      <div
        role="tablist"
        aria-label={t('title')}
        className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1"
      >
        {(['upload', 'link'] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            onClick={() => setMode(m)}
            className={cn(
              'rounded-md py-2 text-sm font-medium text-muted-foreground',
              mode === m && 'bg-muted text-foreground',
            )}
          >
            {t(m)}
          </button>
        ))}
      </div>
      {mode === 'upload' ? (
        <div className="flex flex-col gap-2">
          <Label htmlFor="req-file" className="flex items-center gap-2">
            <Upload className="size-4 text-brand" aria-hidden />
            {t('file', { mb: MAX_MB })}
          </Label>
          <Input
            id="req-file"
            name="file"
            type="file"
            accept="audio/*,video/mp4,video/webm,video/quicktime,.m4a,.flac,.opus,.aiff"
            required
            className="h-auto cursor-pointer border-dashed py-3 file:mr-3 file:rounded-md file:border-0 file:bg-muted file:px-3 file:py-1.5 file:text-sm file:font-semibold file:text-foreground"
          />
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <Label htmlFor="req-url">{t('url')}</Label>
          <Input
            id="req-url"
            name="url"
            type="url"
            inputMode="url"
            placeholder="https://youtu.be/… · https://soundcloud.com/… · https://open.spotify.com/track/…"
            required
          />
          <p className="text-xs text-muted-foreground">{t('urlHint')}</p>
        </div>
      )}
      <label className="flex items-start gap-3 text-sm">
        <input
          type="checkbox"
          checked={rights}
          onChange={(e) => setRights(e.target.checked)}
          required
          className="mt-1 size-4 accent-[var(--primary)]"
        />
        <span>{t('rights')}</span>
      </label>
      <Turnstile onToken={setToken} />
      {phase === 'uploading' && (
        <div className="h-1 overflow-hidden rounded-full bg-muted" aria-hidden>
          <div
            className="h-full bg-primary transition-[width] duration-300"
            style={{ width: `${progress ?? 0}%` }}
          />
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        {!inline && (
          <Button type="button" variant="ghost" onClick={() => dialogRef.current?.close()}>
            {t('cancel')}
          </Button>
        )}
        <Button type="submit" disabled={!rights || phase !== null}>
          {phase && <Loader2 className="size-4 animate-spin" aria-hidden />}
          {phase === 'uploading'
            ? t('submitting', { pct: progress ?? 0 })
            : phase === 'sending'
              ? t('sending')
              : t('submit')}
        </Button>
      </div>
    </form>
  );

  const active = mine.filter((r) =>
    ['pending_upload', 'ingesting', 'ready', 'queued', 'playing'].includes(r.status),
  );

  return (
    <div className="flex flex-col gap-3">
      {!inline && (
        <Button className="w-full" onClick={() => dialogRef.current?.showModal()}>
          {t('open')}
        </Button>
      )}
      {active.length > 0 && (
        <section
          aria-labelledby="mine-title"
          className="rounded-xl border border-border bg-background/40 p-3"
        >
          <h2 id="mine-title" className="legend">
            {t('mine')}
          </h2>
          <ul className="mt-2 flex flex-col gap-2 text-sm">
            {active.map((r) => (
              <li key={r.id} className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate">{r.title}</span>
                <span
                  className={cn(
                    'inline-flex items-center gap-1 rounded-md px-2 py-0.5 font-mono text-[0.6875rem] uppercase',
                    r.status === 'playing'
                      ? 'bg-[oklch(0.68_0.21_28/0.18)] text-[oklch(0.8_0.15_30)]'
                      : r.status === 'ready' || r.status === 'queued'
                        ? 'bg-[oklch(0.82_0.15_var(--dyn-h)/0.15)] text-brand'
                        : 'bg-muted text-muted-foreground',
                  )}
                >
                  {(r.status === 'ingesting' || r.status === 'pending_upload') && (
                    <Loader2 className="size-3 animate-spin" aria-hidden />
                  )}
                  {t(`status.${r.status}`)}
                </span>
                {(r.status === 'ready' || r.status === 'pending_upload') && (
                  <Button variant="ghost" size="sm" onClick={() => void withdraw(r.id)}>
                    {t('withdraw')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {inline ? (
        <section className="glass">{form}</section>
      ) : (
        <dialog
          ref={dialogRef}
          aria-labelledby="req-title"
          className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-2xl bg-card p-0 text-foreground ring-1 ring-border backdrop:bg-black/70 backdrop:backdrop-blur-sm"
        >
          {form}
        </dialog>
      )}
    </div>
  );
}

/** Global toasts for the signed-in user's request lifecycle. */
export function RequestToasts() {
  const t = useTranslations('Toast');
  const seen = useRef(new Map<string, string>());
  useSocketEvent('request:status', (r) => {
    if (seen.current.get(r.id) === r.status) return;
    seen.current.set(r.id, r.status);
    const title = r.title || 'Your song';
    if (r.status === 'ready') toast.success(t('ready', { title }));
    if (r.status === 'rejected')
      toast.error(t('rejected', { title, reason: r.rejectReason ?? '' }));
    if (r.status === 'queued') toast.success(t('won', { title }));
    if (r.status === 'playing') toast.success(t('live', { title }));
    if (r.status === 'expired') toast(t('expired', { title }));
  });
  return null;
}
