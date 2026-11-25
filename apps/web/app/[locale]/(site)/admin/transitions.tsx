'use client';

import { useEffect, useState } from 'react';
import { transitionModeSchema, type TransitionMode } from '@radiot/shared';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';

type Track = {
  id: string;
  kind: string;
  title: string;
  artist: string;
  analyzed: boolean;
  bpm: number | null;
  key: string | null;
  camelot: string | null;
  intro: string | null;
  outro: string | null;
};
type Preview = {
  status: 'rendering' | 'ready' | 'failed' | 'unavailable';
  reason?: string | null;
  plan?: { style: string; reasons: string[]; overlapMs: number; beats: number | null };
  compat?: { tempoRatio: number | null; tempoMatch: boolean; key: number };
  clipUrl?: string | null;
  metrics?: {
    truePeakDb: number;
    beforeLufs: number;
    afterLufs: number;
    loudnessExcursionLu: number;
    beatErrorMs: { median: number; p90: number; beats: number } | null;
  } | null;
};

const describe = (t: Track) =>
  [
    t.artist ? `${t.artist} – ${t.title}` : t.title,
    t.analyzed
      ? [
          t.bpm ? `${Math.round(t.bpm)} BPM` : 'no steady beat',
          t.camelot,
          `${t.intro} in`,
          `${t.outro} out`,
        ]
          .filter(Boolean)
          .join(', ')
      : 'not analysed yet',
  ].join(' · ');

const selectClass =
  'h-10 w-full rounded-lg bg-background px-3 text-sm ring-1 ring-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/** Pick any two tracks and hear the hand-over the station would play between them. */
export function TransitionPreview() {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [fromId, setFromId] = useState('');
  const [toId, setToId] = useState('');
  const [mode, setMode] = useState<TransitionMode | ''>('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  // Counts preview runs, so a newer run (or leaving the tab) stops an older poll.
  const [run] = useState(() => ({ n: 0 }));

  useEffect(() => {
    void api<{ tracks: Track[] }>('/api/admin/transitions/tracks')
      .then((d) => {
        setTracks(d.tracks);
        setFromId(d.tracks[0]?.id ?? '');
        setToId(d.tracks[1]?.id ?? '');
      })
      .catch(() => setTracks([]));
    return () => {
      run.n++;
    };
  }, [run]);

  async function render() {
    const mine = ++run.n;
    setBusy(true);
    setPreview(null);
    try {
      // Rendering takes a few seconds on the worker; the same call reports progress.
      for (let tries = 0; tries < 60 && run.n === mine; tries++) {
        const p = await api<Preview>('/api/admin/transitions/preview', {
          method: 'POST',
          json: { fromId, toId, options: mode ? { transitionMode: mode } : undefined },
        });
        if (run.n !== mine) return;
        setPreview(p);
        if (p.status !== 'rendering') return;
        await new Promise((r) => setTimeout(r, 2000));
      }
    } catch (err) {
      if (run.n === mine) setPreview({ status: 'failed', reason: (err as Error).message });
    } finally {
      if (run.n === mine) setBusy(false);
    }
  }

  if (tracks.length < 2)
    return <p className="text-sm text-muted-foreground">At least two ready tracks are needed.</p>;

  const picker = (label: string, value: string, set: (id: string) => void) => (
    <label className="grid gap-1 text-sm">
      <span className="font-medium">{label}</span>
      <select value={value} onChange={(e) => set(e.target.value)} className={selectClass}>
        {tracks.map((t) => (
          <option key={t.id} value={t.id}>
            {describe(t)}
          </option>
        ))}
      </select>
    </label>
  );
  const m = preview?.metrics;

  return (
    <div className="grid max-w-2xl gap-4">
      {picker('From (ending track)', fromId, setFromId)}
      {picker('To (next track)', toId, setToId)}
      <label className="grid gap-1 text-sm">
        <span className="font-medium">Style</span>
        <select
          value={mode}
          onChange={(e) => setMode(e.target.value as TransitionMode | '')}
          className={selectClass}
        >
          <option value="">Saved station setting</option>
          {transitionModeSchema.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      </label>
      <Button onClick={() => void render()} disabled={busy || fromId === toId} className="w-fit">
        {busy ? 'Rendering…' : 'Preview transition'}
      </Button>

      <div aria-live="polite" className="grid gap-3 text-sm">
        {preview?.plan && (
          <div className="rounded-2xl bg-white/5 p-4 ring-1 ring-white/10">
            <p className="text-lg font-bold capitalize">
              {preview.plan.style} · {(preview.plan.overlapMs / 1000).toFixed(1)} s overlap
              {preview.plan.beats ? ` · ${preview.plan.beats} beats` : ''}
            </p>
            <ul className="mt-1 list-disc pl-5 text-muted-foreground">
              {preview.plan.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
            {preview.compat && (
              <p className="mt-2 text-muted-foreground">
                Tempo:{' '}
                {preview.compat.tempoRatio === null
                  ? 'unknown'
                  : `${((preview.compat.tempoRatio - 1) * 100).toFixed(1)}% apart${preview.compat.tempoMatch ? ' (matched)' : ''}`}
                {' · '}Key fit: {Math.round(preview.compat.key * 100)}%
              </p>
            )}
          </div>
        )}
        {preview?.status === 'rendering' && <p>Rendering the clip…</p>}
        {(preview?.status === 'failed' || preview?.status === 'unavailable') && (
          <p className="text-destructive">{preview.reason ?? 'The preview could not be made.'}</p>
        )}
        {preview?.status === 'ready' && preview.clipUrl && (
          <>
            {/* The clip is the end of one track mixed into the start of the next. */}
            <audio controls preload="auto" src={preview.clipUrl} className="w-full" />
            {m && (
              <p className="text-muted-foreground">
                Loudness {m.beforeLufs.toFixed(1)} → {m.afterLufs.toFixed(1)} LUFS, largest step{' '}
                {m.loudnessExcursionLu.toFixed(1)} LU · true peak {m.truePeakDb.toFixed(1)} dB
                {m.beatErrorMs ? ` · beats within ${Math.round(m.beatErrorMs.median)} ms` : ''}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
