'use client';

import { Loader2, Pause, Play, Volume2, VolumeX, WifiOff } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { useRadio } from '@/lib/radio';
import { cn } from '@/lib/utils';

function useProgress(
  startedAt: string | undefined,
  durationMs: number | undefined,
  serverNow: () => number,
) {
  const [pct, setPct] = useState(0);
  useEffect(() => {
    if (!startedAt || !durationMs) return setPct(0);
    const tick = () =>
      setPct(Math.max(0, Math.min(1, (serverNow() - new Date(startedAt).getTime()) / durationMs)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [startedAt, durationMs, serverNow]);
  return pct;
}

function Equalizer({ active }: { active: boolean }) {
  return (
    <span aria-hidden className="flex h-4 items-end gap-[2px]">
      {[0.9, 0.5, 1, 0.65].map((d, i) => (
        <span
          key={i}
          className={cn('w-[3px] rounded-full bg-brand', active ? 'eq-bar' : 'h-1')}
          style={
            active
              ? {
                  height: '100%',
                  animationDuration: `${0.6 + d * 0.5}s`,
                  animationDelay: `${-i * 0.17}s`,
                }
              : undefined
          }
        />
      ))}
    </span>
  );
}

export function MiniPlayer({ embedded = false }: { embedded?: boolean }) {
  const t = useTranslations('Player');
  const r = useRadio();
  const pct = useProgress(r.now?.startedAt, r.now?.durationMs, r.serverNow);
  const playing = r.status === 'playing' || r.status === 'buffering' || r.status === 'loading';
  const statusText =
    r.status === 'loading'
      ? t('loading')
      : r.status === 'buffering'
        ? t('buffering')
        : r.status === 'offline'
          ? t('offline')
          : r.status === 'error'
            ? t('error')
            : null;
  const sub =
    statusText ??
    (r.now?.requester
      ? t('requestedBy', { name: r.now.requester.name })
      : r.now?.artist || t('fallback'));

  return (
    <div
      role="region"
      aria-label={t('nowPlaying')}
      className={cn(
        'z-50',
        embedded
          ? 'absolute inset-x-0 bottom-0 border-t border-border bg-[oklch(0.13_0.006_75/0.92)] backdrop-blur-md'
          : 'fixed inset-x-0 bottom-0 px-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] sm:px-4',
      )}
    >
      <div
        className={cn(
          'relative mx-auto flex h-16 max-w-6xl items-center gap-3 overflow-hidden',
          embedded
            ? 'px-4'
            : 'glass rounded-full! bg-[oklch(0.15_0.007_75/0.78)]! pr-4 pl-2.5 max-sm:bg-[oklch(0.15_0.007_75/0.97)]!',
        )}
      >
        {!embedded && (
          <span
            aria-hidden
            className="absolute inset-x-6 bottom-0 h-[2px] origin-left rounded-full bg-brand/80 shadow-[0_0_12px_var(--brand)] transition-transform duration-1000 ease-linear"
            style={{ transform: `scaleX(${pct})` }}
          />
        )}
        <button
          type="button"
          onClick={r.toggle}
          aria-label={playing ? t('pause') : t('play')}
          className={cn(
            'grid size-11 shrink-0 place-items-center rounded-full transition-all active:scale-95',
            playing
              ? 'bg-white/10 text-brand ring-1 ring-brand/60'
              : 'brand-gradient shadow-[0_0_24px_-6px_var(--brand)] hover:scale-105',
          )}
        >
          {r.status === 'loading' || r.status === 'buffering' ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : playing ? (
            <Pause className="size-4 fill-current" aria-hidden />
          ) : (
            <Play className="size-4 translate-x-px fill-current" aria-hidden />
          )}
        </button>

        <div className="flex min-w-0 flex-1 items-center gap-3" aria-live="polite">
          {r.now?.artworkUrl && (
            // eslint-disable-next-line @next/next/no-img-element -- artwork lives on Blob/CDN
            <img
              src={r.now.artworkUrl}
              alt=""
              className="size-10 shrink-0 rounded-lg object-cover ring-1 ring-white/10"
            />
          )}
          <Equalizer active={r.status === 'playing'} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm leading-tight font-semibold">
              {r.now?.title ?? t('offAir')}
            </p>
            <p className="truncate font-mono text-[0.6875rem] leading-tight text-muted-foreground">
              {sub}
            </p>
          </div>
        </div>

        {r.status === 'offline' && <WifiOff className="size-4 text-destructive" aria-hidden />}
        <span className="legend hidden tabular-nums sm:inline">
          {t('listeners', { count: r.listeners })}
        </span>
        <button
          type="button"
          onClick={r.toggleMute}
          aria-label={r.muted ? t('unmute') : t('mute')}
          className="grid size-9 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          {r.muted ? (
            <VolumeX className="size-4" aria-hidden />
          ) : (
            <Volume2 className="size-4" aria-hidden />
          )}
        </button>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={r.volume}
          onChange={(e) => r.setVolume(Number(e.target.value))}
          aria-label={t('volume')}
          className="hidden w-24 accent-[var(--primary)] md:block"
        />
      </div>
    </div>
  );
}
