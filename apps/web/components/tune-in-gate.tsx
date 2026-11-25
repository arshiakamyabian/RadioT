'use client';

import Image from 'next/image';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRadio } from '@/lib/radio';
import { cn } from '@/lib/utils';

const SEEN_KEY = 'radiot:tuned-in';

type Phase = 'hidden' | 'idle' | 'tuning' | 'leaving';

function readSeen() {
  try {
    return sessionStorage.getItem(SEEN_KEY) === '1';
  } catch {
    return false;
  }
}

function markSeen() {
  try {
    sessionStorage.setItem(SEEN_KEY, '1');
  } catch {
    // storage blocked (private mode): the gate just shows again next visit
  }
}

/** A short burst of band-passed static with "station found" chirps, like turning a dial. */
function playStaticSweep() {
  const AC =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return;
  const ac = new AC();
  const at = ac.currentTime + 0.02;
  const out = ac.createGain();
  out.gain.value = 0.6;
  out.connect(ac.destination);

  const len = Math.floor(ac.sampleRate * 1.1);
  const buf = ac.createBuffer(1, len, ac.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  const noise = ac.createBufferSource();
  noise.buffer = buf;
  const bp = ac.createBiquadFilter();
  bp.type = 'bandpass';
  bp.Q.value = 2.5;
  bp.frequency.setValueAtTime(600, at);
  bp.frequency.exponentialRampToValueAtTime(5000, at + 0.5);
  bp.frequency.exponentialRampToValueAtTime(1200, at + 1.05);
  const g = ac.createGain();
  g.gain.setValueAtTime(0, at);
  g.gain.linearRampToValueAtTime(0.3, at + 0.08);
  g.gain.setValueAtTime(0.3, at + 0.7);
  g.gain.linearRampToValueAtTime(0, at + 1.1);
  noise.connect(bp).connect(g).connect(out);
  noise.start(at);
  noise.stop(at + 1.15);

  [0.25, 0.55, 0.8].forEach((o, k) => {
    const osc = ac.createOscillator();
    const og = ac.createGain();
    osc.frequency.setValueAtTime(900 + k * 500, at + o);
    osc.frequency.exponentialRampToValueAtTime(300, at + o + 0.12);
    og.gain.setValueAtTime(0.06, at + o);
    og.gain.exponentialRampToValueAtTime(0.0001, at + o + 0.14);
    osc.connect(og).connect(out);
    osc.start(at + o);
    osc.stop(at + o + 0.15);
  });

  setTimeout(() => void ac.close(), 1500);
}

function FrequencyDial({ fast, reduce }: { fast: boolean; reduce: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const targetRef = useRef(0.25);
  targetRef.current = fast ? 9 : 0.25;

  useEffect(() => {
    const cv = ref.current;
    const cx = cv?.getContext('2d');
    if (!cv || !cx) return;
    let offset = 0;
    let speed = 0.25;
    let raf = 0;
    const size = () => {
      const r = window.devicePixelRatio || 1;
      cv.width = cv.clientWidth * r;
      cv.height = cv.clientHeight * r;
      cx.setTransform(r, 0, 0, r, 0, 0);
    };
    size();
    window.addEventListener('resize', size);
    const draw = () => {
      speed += (targetRef.current - speed) * 0.08;
      if (!reduce) offset += speed;
      const w = cv.clientWidth;
      const h = cv.clientHeight;
      cx.clearRect(0, 0, w, h);
      const step = 12;
      for (let x = -(offset % step), i = Math.floor(offset / step); x < w; x += step, i++) {
        const major = i % 10 === 0;
        const mid = i % 5 === 0;
        cx.strokeStyle = major ? 'rgba(245,200,120,.9)' : 'rgba(245,200,120,.35)';
        cx.lineWidth = major ? 1.6 : 1;
        const len = major ? 22 : mid ? 14 : 8;
        cx.beginPath();
        cx.moveTo(x, h - 8);
        cx.lineTo(x, h - 8 - len);
        cx.stroke();
        if (major) {
          cx.fillStyle = 'rgba(245,200,120,.8)';
          cx.font = '600 10px ui-monospace, monospace';
          const mhz = 87.5 + (((((i / 10) * 0.5) % 20.5) + 20.5) % 20.5);
          cx.fillText(mhz.toFixed(1), x + 3, 14);
        }
      }
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', size);
    };
  }, [reduce]);

  return (
    <div
      aria-hidden
      className="relative h-16 w-full overflow-hidden rounded-[10px] border border-border bg-[linear-gradient(oklch(0.2_0.03_70/0.9),oklch(0.15_0.02_70/0.9))] shadow-[inset_0_0_30px_oklch(0.82_0.15_var(--dyn-h)/0.12)]"
    >
      <canvas ref={ref} className="block size-full" />
      <div className="absolute inset-y-1.5 left-1/2 w-0.5 -translate-x-1/2 bg-live shadow-[0_0_10px_var(--live)]" />
    </div>
  );
}

const mmss = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export function TuneInGate() {
  const t = useTranslations('TuneIn');
  const r = useRadio();
  const [phase, setPhase] = useState<Phase>('idle');
  const [reduce, setReduce] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (readSeen()) return setPhase('hidden');
    setReduce(window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    buttonRef.current?.focus({ preventScroll: true });
  }, []);

  const open = phase === 'idle' || phase === 'tuning';
  useEffect(() => {
    if (phase === 'hidden') return;
    document.documentElement.classList.toggle('gate-open', open);
    return () => document.documentElement.classList.remove('gate-open');
  }, [phase, open]);

  const { startedAt, durationMs } = r.now ?? {};
  useEffect(() => {
    if (!startedAt || !durationMs || phase === 'hidden') return;
    const tick = () =>
      setElapsed(Math.min(durationMs, r.serverNow() - new Date(startedAt).getTime()));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [startedAt, durationMs, r, phase]);

  const close = useCallback(
    (delay: number) => {
      markSeen();
      setTimeout(() => setPhase('leaving'), delay);
      setTimeout(() => setPhase('hidden'), delay + (reduce ? 50 : 1000));
    },
    [reduce],
  );

  const tuneIn = () => {
    if (phase !== 'idle') return;
    // Must run inside the tap so the browser unlocks audio.
    r.play();
    if (!reduce) {
      try {
        playStaticSweep();
      } catch {
        // decorative only
      }
    }
    setPhase('tuning');
    close(reduce ? 0 : 900);
  };

  const browse = useCallback(() => {
    if (phase !== 'idle') return;
    close(0);
  }, [phase, close]);

  useEffect(() => {
    if (phase !== 'idle') return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && browse();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, browse]);

  if (phase === 'hidden') return null;
  const now = r.now;

  return (
    <>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="tune-in-title"
        aria-describedby="tune-in-note"
        className={cn(
          'tune-gate fixed inset-0 z-[60] grid grid-cols-[minmax(0,1fr)] place-items-center overflow-y-auto px-4 pt-[calc(env(safe-area-inset-top)+5rem)] pb-[calc(env(safe-area-inset-bottom)+1.5rem)] backdrop-blur-xl',
          phase === 'leaving' && 'tune-gate-out',
        )}
      >
        <div className="absolute inset-x-5 top-[calc(env(safe-area-inset-top)+1.25rem)] flex items-center justify-between gap-3">
          <span className="flex items-center gap-2 text-xl font-black tracking-tight">
            <span
              aria-hidden
              className="size-2.5 rounded-full bg-live shadow-[0_0_12px_var(--live)]"
            />
            RadioT
          </span>
          <span className="inline-flex items-center gap-2 rounded-md border border-live/50 px-3 py-1.5 font-mono text-xs font-semibold tracking-[0.14em] text-live [text-shadow:0_0_10px_oklch(0.68_0.21_28/0.7)]">
            <span
              aria-hidden
              className="tune-blink size-2 rounded-full bg-live shadow-[0_0_10px_var(--live)]"
            />
            ON AIR
          </span>
        </div>

        <div className="flex w-full max-w-[560px] flex-col items-center gap-6 text-center max-sm:gap-5">
          <FrequencyDial fast={phase !== 'idle'} reduce={reduce} />

          <h1
            id="tune-in-title"
            className="m-0 text-[clamp(2.2rem,8vw,4.2rem)] leading-[0.95] font-black tracking-[-0.045em] text-balance"
          >
            {t.rich('title', {
              em: (chunks) => (
                <em className="text-brand not-italic [text-shadow:0_0_30px_oklch(0.82_0.15_var(--dyn-h)/0.45)]">
                  {chunks}
                </em>
              ),
            })}
          </h1>

          {now && (
            <div className="flex max-w-full min-w-0 items-center gap-3.5 text-left">
              {now.artworkUrl ? (
                <Image
                  src={now.artworkUrl}
                  alt=""
                  width={64}
                  height={64}
                  unoptimized
                  className="size-16 shrink-0 rounded-[10px] object-cover shadow-[0_10px_30px_-8px_oklch(0.82_0.15_var(--dyn-h)/0.5)]"
                />
              ) : (
                <span
                  aria-hidden
                  className="size-16 shrink-0 rounded-[10px] bg-[conic-gradient(from_200deg_at_30%_30%,var(--brand),var(--live),oklch(0.35_0.08_300),var(--brand))] shadow-[0_10px_30px_-8px_oklch(0.82_0.15_var(--dyn-h)/0.5)]"
                />
              )}
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">{t('nowOnAir')}</p>
                <p className="truncate text-lg font-extrabold tracking-tight">{now.title}</p>
                {now.artist && (
                  <p className="truncate text-sm text-muted-foreground">{now.artist}</p>
                )}
                <p className="mt-0.5 font-mono text-xs text-brand tabular-nums">
                  {now.requester
                    ? t('requestedAt', { name: now.requester.name, time: mmss(elapsed) })
                    : t('rotationAt', { time: mmss(elapsed) })}
                </p>
              </div>
            </div>
          )}

          <button
            ref={buttonRef}
            type="button"
            onClick={tuneIn}
            disabled={phase !== 'idle'}
            className="tune-button relative grid size-[148px] cursor-pointer place-items-center rounded-full border-0 bg-[radial-gradient(circle_at_35%_30%,oklch(0.9_0.12_80),var(--brand)_45%,oklch(0.62_0.15_60))] text-[0.95rem] font-black tracking-[0.14em] text-primary-foreground shadow-[0_0_0_8px_oklch(0.82_0.15_var(--dyn-h)/0.12),0_0_0_1px_oklch(0.82_0.15_var(--dyn-h)/0.6),0_20px_60px_-10px_oklch(0.82_0.15_var(--dyn-h)/0.7)] transition-transform hover:scale-[1.04] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand active:scale-[0.97] max-sm:size-[124px]"
          >
            <span className="flex flex-col items-center gap-1.5">
              <svg
                aria-hidden
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
                className="size-[30px]"
              >
                <path d="M12 3v8" />
                <path d="M6.3 7.2a8 8 0 1 0 11.4 0" />
              </svg>
              {t('button')}
            </span>
          </button>

          <p className="text-sm text-muted-foreground">
            {r.listeners > 0 ? (
              <>
                <span className="font-bold text-foreground tabular-nums">{r.listeners}</span>{' '}
                {t('listening', { count: r.listeners })}
              </>
            ) : (
              t('beFirst')
            )}
          </p>

          <p id="tune-in-note" className="max-w-[40ch] text-xs text-muted-foreground">
            {t('note')}
          </p>

          <button
            type="button"
            onClick={browse}
            className="rounded-md px-3 py-1.5 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-brand"
          >
            {t('browse')}
          </button>
        </div>
      </div>
      {phase === 'tuning' && !reduce && (
        <div aria-hidden className="tune-flash pointer-events-none fixed inset-0 z-[61]" />
      )}
    </>
  );
}
