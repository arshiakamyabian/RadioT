'use client';

import { AnimatePresence, motion, useReducedMotion, type TargetAndTransition } from 'motion/react';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { REACTION_STICKERS, type ReactionEvent, type ReactionSticker } from '@radiot/shared';
import { api } from '@/lib/api';
import { track } from '@/lib/analytics';
import { useSocketEvent } from '@/lib/realtime';
import { useMe } from '@/lib/session';
import { cn } from '@/lib/utils';
import { Sticker } from './stickers';

type Floating = ReactionEvent & { key: number; x: number; combo: number };
const MAX_ON_SCREEN = 30;
const COMBO_WINDOW_MS = 1800;
const LIFETIME_MS = 2900;

/** Each sticker's personality, played inside the rising wrapper. */
const MOVES: Record<ReactionSticker, TargetAndTransition> = {
  fire: { scale: [0.5, 1.15, 1], transition: { duration: 0.5, ease: 'easeOut' } },
  airhorn: {
    rotate: [0, -10, 10, -6, 6, 0],
    scale: [0.5, 1.15, 1],
    transition: { duration: 0.7 },
  },
  rewind: { rotate: [0, -360], transition: { duration: 1.2, ease: 'easeOut' } },
};

/** Studio applause meter: rises with every reaction, decays back down. */
function useCrowd() {
  const [level, setLevel] = useState(0);
  const target = useRef(0);
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  useEffect(() => () => clearInterval(timer.current), []);
  // Only animate while the meter is moving; an always-on 8 Hz re-render made phones stutter.
  const bump = useCallback(() => {
    target.current = Math.min(1, target.current + 0.12);
    if (timer.current) return;
    timer.current = setInterval(() => {
      target.current = Math.max(0, target.current - 0.04);
      setLevel((l) => {
        const v = l + (target.current - l) * 0.35;
        if (target.current === 0 && v < 0.01) {
          clearInterval(timer.current);
          timer.current = undefined;
          return 0;
        }
        return v;
      });
    }, 120);
  }, []);
  return { level, bump };
}

export function Reactions() {
  const t = useTranslations('Reactions');
  const { me } = useMe();
  const reduce = useReducedMotion();
  const [floating, setFloating] = useState<Floating[]>([]);
  const seq = useRef(0);
  const lastSent = useRef(0);
  const recent = useRef<{ sticker: ReactionSticker; at: number }[]>([]);
  const crowd = useCrowd();

  useSocketEvent('reactions', (e) => {
    const key = ++seq.current;
    const now = Date.now();
    recent.current = recent.current.filter((r) => now - r.at < COMBO_WINDOW_MS);
    recent.current.push({ sticker: e.sticker, at: now });
    const combo = recent.current.filter((r) => r.sticker === e.sticker).length;
    crowd.bump();
    setFloating((f) => [
      ...f.slice(-MAX_ON_SCREEN + 1),
      { ...e, key, combo, x: 6 + Math.random() * 82 },
    ]);
    setTimeout(() => setFloating((f) => f.filter((x) => x.key !== key)), LIFETIME_MS);
  });

  function send(sticker: ReactionSticker) {
    // Client-side debounce; the server enforces its own limit.
    if (Date.now() - lastSent.current < 350) return;
    lastSent.current = Date.now();
    track('reaction_sent', { sticker });
    void api('/api/reactions', { method: 'POST', json: { sticker } }).catch(() => {});
  }

  const hype = Math.round(crowd.level * 10);

  return (
    <>
      <div
        aria-hidden
        className="pointer-events-none fixed inset-x-0 top-1/4 bottom-20 z-30 overflow-hidden"
      >
        <AnimatePresence>
          {floating.map((f) => (
            <motion.div
              key={f.key}
              className="absolute bottom-0 flex flex-col items-center"
              style={{ left: `${f.x}%` }}
              initial={{ opacity: 0, y: 20 }}
              animate={
                reduce
                  ? { opacity: [0, 1, 1, 0] }
                  : { opacity: [0, 1, 1, 0], y: -360 - Math.random() * 80 }
              }
              exit={{ opacity: 0 }}
              transition={{
                duration: LIFETIME_MS / 1000 - 0.1,
                ease: 'easeOut',
                times: [0, 0.08, 0.75, 1],
              }}
            >
              {f.combo > 1 && (
                <motion.span
                  initial={{ scale: 0.4, rotate: -12 }}
                  animate={{ scale: [1.6, 1], rotate: -8 }}
                  className="mb-1 rounded-md bg-primary px-1.5 font-mono text-sm font-black text-primary-foreground shadow-lg"
                >
                  x{f.combo}
                </motion.span>
              )}
              <motion.div animate={reduce ? undefined : MOVES[f.sticker]}>
                <Sticker
                  id={f.sticker}
                  className={cn(
                    'size-14 drop-shadow-[0_6px_14px_rgba(0,0,0,0.6)]',
                    f.combo >= 5 && 'size-20',
                  )}
                />
              </motion.div>
              <span className="mt-1 max-w-28 truncate rounded-full bg-black/70 px-2 py-0.5 text-[0.625rem] font-semibold text-white">
                {f.userId === me?.id ? t('you') : f.name}
              </span>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      {me && (
        <section aria-labelledby="react-title" className="glass p-3 sm:p-4">
          <div className="mb-2 flex items-center justify-between gap-3 px-1">
            <h2 id="react-title" className="legend">
              {t('label')}
            </h2>
            <div className="flex items-center gap-2" aria-hidden>
              <span className="legend">{t('crowd')}</span>
              <div className="flex gap-[3px]">
                {Array.from({ length: 10 }, (_, i) => (
                  <span
                    key={i}
                    className={cn(
                      'h-2.5 w-1.5 rounded-[1px] transition-colors',
                      i < hype ? (i >= 8 ? 'bg-live' : 'bg-brand') : 'bg-muted',
                    )}
                  />
                ))}
              </div>
            </div>
          </div>
          <div role="group" aria-label={t('label')} className="flex gap-2">
            {REACTION_STICKERS.map((s) => (
              <motion.button
                key={s}
                type="button"
                onClick={() => send(s)}
                whileHover={reduce ? undefined : { y: -2 }}
                whileTap={reduce ? undefined : { scale: 0.95 }}
                className="flex min-w-0 flex-1 items-center gap-2.5 rounded-2xl border border-white/10 bg-white/[0.03] p-2 pr-3 text-left transition-colors hover:border-brand/60 max-sm:flex-col max-sm:gap-1 max-sm:pr-2 max-sm:text-center"
                aria-label={`${t('label')}: ${t(`stickers.${s}`)}`}
              >
                <Sticker id={s} className="size-9 shrink-0" />
                <span className="truncate text-sm font-semibold">{t(`stickers.${s}`)}</span>
              </motion.button>
            ))}
          </div>
        </section>
      )}
    </>
  );
}
