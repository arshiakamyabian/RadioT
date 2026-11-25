'use client';

import { Check, Lock, Music, Plus, Repeat } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import type { Candidate, RoundState } from '@radiot/shared';
import { Link } from '@/i18n/navigation';
import { api } from '@/lib/api';
import { track } from '@/lib/analytics';
import { useSocketEvent } from '@/lib/realtime';
import { useMe } from '@/lib/session';
import { cn } from '@/lib/utils';
import { ShareButton } from './share-button';
import { Turnstile, turnstileEnabled } from './turnstile';
import { Button } from './ui/button';

export function VotePanel() {
  const t = useTranslations('Vote');
  const tr = useTranslations('Rotation');
  const locale = useLocale();
  const { me } = useMe();
  const reduce = useReducedMotion();
  const [round, setRound] = useState<RoundState | null>(null);
  const [token, setToken] = useState<string | undefined>();
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    void api<{ round: RoundState }>('/api/rounds/current')
      .then((r) => setRound(r.round))
      .catch(() => {});
  }, []);
  useEffect(load, [load, me?.id]);
  useSocketEvent('queue:update', load);
  useSocketEvent('radio:now', load);
  useSocketEvent('round:locked', load);
  useSocketEvent('round:update', ({ roundId, counts }) => {
    const apply = (list: Candidate[]) => list.map((c) => ({ ...c, votes: counts[c.id] ?? 0 }));
    setRound((r) =>
      r && r.roundId === roundId
        ? { ...r, candidates: apply(r.candidates), rotation: apply(r.rotation) }
        : r,
    );
  });

  async function vote(requestId: string) {
    setBusy(requestId);
    try {
      await api('/api/rounds/current/vote', {
        method: 'POST',
        json: { requestId, turnstileToken: token },
      });
      setRound((r) => (r ? { ...r, myVote: requestId } : r));
      track('vote_cast');
    } catch (err) {
      toast.error((err as Error).message);
      load();
    } finally {
      setBusy(null);
    }
  }

  // No countdown: the server closes voting 10 s before the song ends and announces it with round:locked.
  const open = round?.status === 'open';
  const fresh = [...(round?.candidates ?? [])].sort(
    (a, b) => b.votes - a.votes || a.createdAt.localeCompare(b.createdAt),
  );
  const rotation = round?.rotation ?? [];
  const all = [...fresh, ...rotation];
  const total = all.reduce((n, c) => n + c.votes, 0);
  const winner = round?.winnerRequestId ? all.find((c) => c.id === round.winnerRequestId) : null;

  const leader = fresh[0]?.votes ? fresh[0].id : null;

  function row(c: Candidate, label: React.ReactNode) {
    const mine = round?.myVote === c.id;
    const share = total ? c.votes / total : 0;
    return (
      <motion.li
        key={c.id}
        layout={!reduce}
        transition={{ type: 'spring', stiffness: 380, damping: 32 }}
        className={cn(
          'relative overflow-hidden rounded-2xl bg-white/[0.03] p-3.5 ring-1 transition-colors',
          mine ? 'ring-[var(--brand)]' : 'ring-white/10',
          c.id === leader && open && 'shadow-[0_0_40px_-18px_var(--brand)]',
        )}
      >
        <div
          aria-hidden
          className="brand-gradient absolute inset-y-0 left-0 opacity-20 transition-[width] duration-700 ease-[cubic-bezier(0.2,0.8,0.2,1)]"
          style={{ width: `${share * 100}%` }}
        />
        <div className="relative flex items-center gap-3">
          <span
            className={cn(
              'w-6 text-center font-mono text-sm font-bold tabular-nums',
              c.id === leader && open ? 'text-brand' : 'text-muted-foreground',
            )}
          >
            {label}
          </span>
          <div className="min-w-0 flex-1">
            <Link
              href={`/history/${c.id}`}
              className="block truncate font-semibold underline-offset-4 hover:underline"
            >
              {c.title}
            </Link>
            <p className="truncate text-xs text-muted-foreground">
              {c.artist ? `${c.artist} · ` : ''}
              {c.requester.name} ·{' '}
              <span className="tabular-nums">{t('votes', { count: c.votes })}</span>
            </p>
          </div>
          <ShareButton path={`/${locale}/history/${c.id}`} title={c.title} campaign="vote_for_me" />
          <Button
            size="sm"
            variant={mine ? 'default' : 'outline'}
            className="min-w-24"
            disabled={!me || !open || busy !== null}
            onClick={() => void vote(c.id)}
            aria-pressed={mine}
            aria-label={mine ? t('voted') : `${t('vote')}: ${c.title}`}
          >
            {mine ? (
              <>
                <Check className="size-4" aria-hidden /> {t('voted')}
              </>
            ) : open ? (
              t('voteNow')
            ) : (
              <>
                <Lock className="size-3.5" aria-hidden /> {t('votingClosed')}
              </>
            )}
          </Button>
        </div>
      </motion.li>
    );
  }

  return (
    <section aria-labelledby="vote-title" className="glass p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="legend">{t('eyebrow')}</p>
          <h2 id="vote-title" className="mt-1 text-xl font-bold tracking-tight">
            {t('title')}
          </h2>
        </div>
        {all.length > 0 && (
          <p
            className={cn(
              'rounded-md px-2.5 py-1 text-xs font-semibold ring-1',
              open
                ? 'bg-white/5 text-brand ring-white/15'
                : 'bg-white/5 text-muted-foreground ring-white/10',
            )}
            aria-live="polite"
          >
            {open ? t('open') : t('locked')}
          </p>
        )}
      </div>
      {winner && !open ? (
        <p className="mt-2 text-sm font-semibold text-brand">
          {t('winner', { title: winner.title })}
        </p>
      ) : (
        all.length > 0 && <p className="mt-2 text-sm text-muted-foreground">{t('closesNote')}</p>
      )}

      {!all.length ? (
        <div className="mt-5 flex flex-col items-center gap-3 rounded-xl border border-dashed border-border px-4 py-8 text-center">
          <span className="brand-gradient grid size-12 place-items-center rounded-full">
            <Music className="size-5" aria-hidden />
          </span>
          <p className="font-semibold">{t('empty')}</p>
          <p className="max-w-xs text-sm text-muted-foreground">{t('emptyHint')}</p>
          <Button asChild>
            <Link href="/request">
              <Plus className="size-4" aria-hidden /> {t('requestCta')}
            </Link>
          </Button>
        </div>
      ) : (
        <>
          {fresh.length > 0 && (
            <>
              <h3 className="mt-5 text-sm font-semibold">{t('newTitle')}</h3>
              <ol className="mt-2 flex flex-col gap-3">
                {fresh.map((c, i) => row(c, String(i + 1).padStart(2, '0')))}
              </ol>
            </>
          )}
          {rotation.length > 0 && (
            <>
              <h3 className="mt-5 text-sm font-semibold">
                {tr('title', { count: rotation.length })}
              </h3>
              <p className="mt-0.5 text-xs text-muted-foreground">{tr('body')}</p>
              <ol className="mt-2 flex flex-col gap-3">
                {rotation.map((c, i) =>
                  row(
                    c,
                    i === 0 ? (
                      <Repeat className="mx-auto size-4 text-brand" aria-label={tr('upNext')} />
                    ) : (
                      String(i + 1).padStart(2, '0')
                    ),
                  ),
                )}
              </ol>
            </>
          )}
          {!open && <p className="mt-3 text-xs text-muted-foreground">{t('nextOpens')}</p>}
        </>
      )}
      {me && open && turnstileEnabled && !round?.myVote && all.length > 0 && (
        <div className="mt-4">
          <Turnstile onToken={setToken} />
        </div>
      )}
    </section>
  );
}
