import { describe, expect, it } from 'vitest';
import type { NowPlaying, TrackMedia, UpNext } from '@radiot/shared';
import { DEFAULT_PLAN_CONFIG, planPieces, wallOf, type Cursor } from './pieces.js';

const T0 = Date.parse('2026-01-01T00:00:00Z');
const media = (id: string, over: Partial<TrackMedia> = {}): TrackMedia => ({
  url: `http://m/${id}.mp3`,
  cueInMs: 1000,
  cueOutMs: 181_000,
  gainDb: -3,
  crossfadeMs: 5000,
  mixFromMs: 140_000,
  fileMs: 183_000,
  ...over,
});
const nowOf = (id: string, startedAt: number, m = media(id)): NowPlaying => ({
  kind: 'fallback',
  trackId: id,
  roundId: null,
  title: id,
  artist: '',
  artworkUrl: null,
  durationMs: 150_000,
  startedAt: new Date(startedAt).toISOString(),
  requester: null,
  media: m,
});
const nextOf = (id: string, startsAt: number, over: Partial<UpNext> = {}): UpNext => ({
  kind: 'fallback',
  trackId: id,
  title: id,
  artist: '',
  artworkUrl: null,
  startsAt: new Date(startsAt).toISOString(),
  media: media(id),
  fadeMs: 4000,
  transition: null,
  ...over,
});
const clipFor = (aFileStartMs: number) => ({
  aFileStartMs,
  leadInMs: 4000,
  overlapMs: 12_000,
  handoffClipMs: 16_000,
  handoffFileMs: 21_000,
  clipMs: 24_000,
  style: 'beatmatch' as const,
  clipUrl: 'http://m/clip.mp3',
  clipStartsAt: new Date(T0).toISOString(),
});
const always = () => true;
let n = 0;
const nextId = () => `p${++n}`;

describe('joining the timeline', () => {
  it('starts mid-track at the position that is on air now, plain up to the split', () => {
    const wall = T0 + 30_000;
    const r = planPieces({
      now: nowOf('a', T0),
      next: null,
      cursor: null,
      wall,
      ready: always,
      nextId,
    });
    expect(r.pieces).toHaveLength(1);
    const p = r.pieces[0]!;
    // 30 s into the track + the join lead, from the cue-in
    expect(p.fromMs).toBe(1000 + 30_000 + DEFAULT_PLAN_CONFIG.joinLeadMs);
    expect(p.toMs).toBe(140_000);
    expect(p.gainDb).toBe(-3);
    expect(r.entered[0]?.how).toBe('join');
  });

  it('waits for the track to be downloaded', () => {
    const r = planPieces({
      now: nowOf('a', T0),
      next: null,
      cursor: null,
      wall: T0,
      ready: () => false,
      nextId,
    });
    expect(r.pieces).toHaveLength(0);
    expect(r.waiting).toMatch(/fetching/);
  });
});

describe('transitions', () => {
  const cursorAtSplit = (): Cursor => ({
    trackId: 'a',
    startedAtMs: T0,
    media: media('a'),
    posMs: 140_000,
  });
  // The wall time at which the cursor's queued audio runs out.
  const splitWall = wallOf(cursorAtSplit(), 140_000);

  it('queues nothing while the next track is unknown and the queue is long', () => {
    const r = planPieces({
      now: nowOf('a', T0),
      next: null,
      cursor: cursorAtSplit(),
      wall: splitWall - 8000,
      ready: always,
      nextId,
    });
    expect(r.pieces).toHaveLength(0);
  });

  it('joins track, clip and next track by file position', () => {
    const next = nextOf('b', T0 + 135_000, { transition: clipFor(140_000) });
    const r = planPieces({
      now: nowOf('a', T0),
      next,
      cursor: cursorAtSplit(),
      wall: splitWall - 6000,
      ready: always,
      nextId,
    });
    // a's audio before the clip is already queued (aFileStart == the split), so the clip is next.
    expect(r.pieces.map((p) => p.kind)).toEqual(['clip']);
    expect(r.pieces[0]!.crossMs).toBe(0);
    expect(r.cursor?.trackId).toBe('b');
    // b's file goes on after the clip's lead-out (b alone from handoffClipMs to clipMs).
    expect(r.cursor?.posMs).toBe(21_000 + 8000);
    expect(r.entered.at(-1)?.how).toBe('clip');
    // b's own audio is handed over once the clip is about to end.
    const later = planPieces({
      now: nowOf('a', T0),
      next,
      cursor: r.cursor,
      wall: splitWall + 14_000,
      ready: always,
      nextId,
    });
    expect(later.pieces).toHaveLength(1);
    expect(later.pieces[0]!.fromMs).toBe(29_000);
    expect(later.pieces[0]!.toMs).toBe(140_000); // up to b's own split
  });

  it('goes on with b right where the clip ends, without replaying its lead-out', () => {
    // b enters stretched / past its cue-in inside the clip: b is anchored at the handoff, and
    // the piece after the clip starts at the b position the clip stopped at.
    const next = nextOf('b', T0 + 120_000, { transition: clipFor(140_000) });
    const r = planPieces({
      now: nowOf('a', T0),
      next,
      cursor: cursorAtSplit(),
      wall: splitWall - 900,
      ready: always,
      nextId,
    });
    const clip = r.pieces.find((p) => p.kind === 'clip')!;
    const tr = next.transition!;
    expect(r.cursor!.posMs).toBe(tr.handoffFileMs + (tr.clipMs - tr.handoffClipMs));
    expect(wallOf(r.cursor!, tr.handoffFileMs)).toBe(clip.atMs + tr.handoffClipMs);
    expect(wallOf(r.cursor!, r.cursor!.posMs)).toBe(clip.atMs + tr.clipMs);
    expect(r.entered.at(-1)!.startedAtMs).toBe(Date.parse(next.startsAt));
  });

  it('plays the rest of a before the clip when the clip starts later than the split', () => {
    const next = nextOf('b', T0 + 150_000, { transition: clipFor(150_000) });
    const r = planPieces({
      now: nowOf('a', T0),
      next,
      cursor: cursorAtSplit(),
      wall: splitWall - 6000,
      ready: always,
      nextId,
    });
    const [mid, clip] = r.pieces;
    expect(mid!.kind).toBe('track');
    expect(mid!.fromMs).toBe(140_000);
    expect(mid!.toMs).toBe(150_000); // exactly where the clip's first sample is
    expect(clip!.kind).toBe('clip');
  });

  it('waits for a clip that is still downloading, then crossfades at the last moment', () => {
    const next = nextOf('b', T0 + 135_000, { transition: clipFor(140_000) });
    const notReady = (url: string) => !url.endsWith('clip.mp3');
    const early = planPieces({
      now: nowOf('a', T0),
      next,
      cursor: cursorAtSplit(),
      wall: splitWall - 6000,
      ready: notReady,
      nextId,
    });
    expect(early.pieces).toHaveLength(0);
    expect(early.waiting).toMatch(/clip/);

    const late = planPieces({
      now: nowOf('a', T0),
      next,
      cursor: cursorAtSplit(),
      wall: splitWall - 900,
      ready: notReady,
      nextId,
    });
    const mix = late.pieces.find((p) => p.kind === 'mix')!;
    const b = late.pieces.at(-1)!;
    expect(late.pieces.map((p) => p.kind).slice(-2)).toEqual(['mix', 'track']);
    // Gapless: the mix starts where a was queued up to, and b resumes where its mixed part ends.
    expect(mix.fromMs).toBe(cursorAtSplit().posMs);
    expect(mix.toMs! - mix.fromMs).toBe(4000);
    expect(mix.mixWith!.toMs - mix.mixWith!.fromMs).toBe(4000);
    expect(b.fromMs).toBe(mix.mixWith!.toMs);
    expect(b.trackId).toBe('b');
    expect(late.pieces.every((p) => p.crossMs === 0)).toBe(true);
    // Each piece is scheduled right where the previous one ends.
    expect(b.atMs - mix.atMs).toBe(4000);
    expect(late.entered.at(-1)?.how).toBe('crossfade');
  });

  it('never cuts the current track short without a next track: it plays on in chunks', () => {
    const r = planPieces({
      now: nowOf('a', T0),
      next: null,
      cursor: cursorAtSplit(),
      wall: splitWall - 800,
      ready: always,
      nextId,
    });
    expect(r.pieces).toHaveLength(1);
    expect(r.pieces[0]!.fromMs).toBe(140_000);
    expect(r.pieces[0]!.toMs).toBe(143_000);
  });

  it('plays a clip that is too late (a already queued past its start) as a plain crossfade', () => {
    const behind: Cursor = { ...cursorAtSplit(), posMs: 143_000 };
    const next = nextOf('b', T0 + 135_000, { transition: clipFor(140_000) });
    const r = planPieces({
      now: nowOf('a', T0),
      next,
      cursor: behind,
      wall: wallOf(behind, 143_000) - 900,
      ready: always,
      nextId,
    });
    expect(r.pieces.some((p) => p.kind === 'clip')).toBe(false);
    expect(r.entered.at(-1)?.how).toBe('crossfade');
  });
});
