'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';
import { Link } from '@/i18n/navigation';
import { useRadio } from '@/lib/radio';
import { cn } from '@/lib/utils';
import { LogoMark } from './logo';
import { OnAir } from './on-air';

function useElapsed(
  startedAt: string | undefined,
  durationMs: number | undefined,
  serverNow: () => number,
) {
  const [ms, setMs] = useState(0);
  useEffect(() => {
    if (!startedAt || !durationMs) return setMs(0);
    const tick = () => {
      const elapsed = serverNow() - new Date(startedAt).getTime();
      setMs(Math.max(0, Math.min(durationMs, elapsed)));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [startedAt, durationMs, serverNow]);
  return ms;
}

const mmss = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

const BARS = 72;

/** Stable pseudo-waveform per track, so every listener sees the same shape. */
function useWaveform(seed: string) {
  return useMemo(() => {
    let h = 2166136261;
    for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
    const rand = () => {
      h = Math.imul(h ^ (h >>> 15), 2246822507);
      h = Math.imul(h ^ (h >>> 13), 3266489909);
      return ((h ^= h >>> 16) >>> 0) / 4294967296;
    };
    return Array.from({ length: BARS }, (_, i) => {
      // Quiet intro/outro, louder body: reads like a real song.
      const env = Math.sin((Math.PI * (i + 0.5)) / BARS) ** 0.6;
      return 0.18 + env * (0.35 + rand() * 0.47);
    });
  }, [seed]);
}

function Waveform({
  seed,
  pct,
  label,
  valueText,
}: {
  seed: string;
  pct: number;
  label: string;
  valueText: string;
}) {
  const bars = useWaveform(seed);
  const head = pct * BARS;
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct * 100)}
      aria-valuetext={valueText}
      className="flex h-12 items-center gap-[2px] sm:h-14"
    >
      {bars.map((v, i) => (
        <span
          key={i}
          aria-hidden
          className={cn(
            'flex-1 rounded-full transition-colors duration-500',
            i < head
              ? 'bg-brand shadow-[0_0_8px_oklch(0.82_0.15_var(--dyn-h)/0.55)]'
              : 'bg-foreground/15',
          )}
          style={{ height: `${Math.round(v * 1000) / 10}%` }}
        />
      ))}
    </div>
  );
}

export function NowPlayingCard() {
  const t = useTranslations('Player');
  const th = useTranslations('Home');
  const { now, listeners, serverNow, status } = useRadio();
  const spinning = status === 'playing';
  const elapsed = useElapsed(now?.startedAt, now?.durationMs, serverNow);
  const duration = now?.durationMs ?? 0;
  const pct = duration ? elapsed / duration : 0;
  const credit = now?.requester ? t('requestedBy', { name: now.requester.name }) : null;
  const art = now?.artworkUrl;

  return (
    <section
      aria-labelledby="now-title"
      className="glass relative isolate overflow-hidden p-4 sm:p-6"
    >
      {/* Ambient glow taken from the cover itself. */}
      {art && (
        // eslint-disable-next-line @next/next/no-img-element -- artwork lives on S3/CDN
        <img
          src={art}
          alt=""
          aria-hidden
          className="absolute inset-0 -z-10 hidden size-full scale-125 object-cover opacity-25 blur-3xl saturate-150 will-change-transform sm:block"
        />
      )}
      <div
        aria-hidden
        className="absolute inset-0 -z-10 bg-gradient-to-t from-card via-card/80 to-card/40"
      />

      <div className="flex items-center justify-between gap-3">
        <OnAir label={th('onAir')} lit={Boolean(now)} />
        <span className="legend tabular-nums">
          <span className="text-foreground">{listeners}</span> {t('tunedIn')}
        </span>
      </div>

      <div className="mt-5 flex flex-col gap-5 sm:flex-row sm:items-end sm:gap-16">
        <div className="relative w-full max-w-[15rem] shrink-0 sm:w-52">
          <div
            aria-hidden
            data-playing={spinning}
            className={cn(
              'vinyl absolute inset-[4%] rounded-full transition-transform duration-700 ease-[cubic-bezier(0.2,0.8,0.2,1)]',
              spinning ? 'translate-x-[34%]' : 'translate-x-[8%]',
            )}
          />
          <div
            style={{ viewTransitionName: 'np-cover' }}
            className="relative aspect-square w-full overflow-hidden rounded-2xl bg-muted shadow-[0_30px_70px_-25px_rgba(0,0,0,0.95)] ring-1 ring-white/10"
          >
            {art ? (
              // eslint-disable-next-line @next/next/no-img-element -- artwork lives on S3/CDN
              <img src={art} alt="" className="size-full object-cover" />
            ) : (
              <div className="grid size-full place-items-center bg-[radial-gradient(circle_at_30%_20%,oklch(0.32_0.06_var(--dyn-h)),oklch(0.14_0.006_75))]">
                <LogoMark className="size-16 opacity-90" />
              </div>
            )}
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 bg-[linear-gradient(135deg,oklch(1_0_0/0.14),transparent_40%)]"
            />
          </div>
        </div>

        <div className="min-w-0 flex-1">
          <p className="legend">{now?.kind === 'request' ? t('onRequest') : t('nowPlaying')}</p>
          <h1
            id="now-title"
            style={{ viewTransitionName: 'np-title' }}
            className="text-shine mt-2 line-clamp-2 text-3xl leading-[0.95] font-black tracking-[-0.03em] text-balance sm:text-5xl"
          >
            {now?.title ?? t('offAir')}
          </h1>
          <p className="mt-2 truncate text-sm text-muted-foreground sm:text-base">
            {now?.artist}
            {credit && (
              <>
                {now?.artist ? ' · ' : ''}
                {now?.requester?.handle ? (
                  <Link
                    href={`/u/${now.requester.handle}`}
                    className="text-brand underline-offset-4 hover:underline"
                  >
                    {credit}
                  </Link>
                ) : (
                  <span className="text-brand">{credit}</span>
                )}
              </>
            )}
            {!now?.artist && !credit && now && t('fallback')}
          </p>
        </div>
      </div>

      <div className="mt-6">
        <Waveform
          seed={now?.trackId ?? now?.title ?? 'radiot'}
          pct={pct}
          label={t('nowPlaying')}
          valueText={duration ? `${mmss(elapsed)} / ${mmss(duration)}` : t('offAir')}
        />
        <div className="mt-2 flex justify-between font-mono text-xs tabular-nums text-muted-foreground">
          <span className="text-foreground">{mmss(elapsed)}</span>
          <span>{mmss(duration)}</span>
        </div>
      </div>
    </section>
  );
}
