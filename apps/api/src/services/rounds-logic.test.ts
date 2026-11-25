import { describe, expect, it } from 'vitest';
import { airtimeMs, trackMedia } from '@radiot/shared';
import {
  computeLockAt,
  detectVoteFlags,
  expiringAfterRound,
  pickRoundWinner,
  pickWinner,
} from './rounds-logic.js';

const c = (id: string, minutesAgo: number) => ({
  id,
  createdAt: new Date(Date.now() - minutesAgo * 60_000),
});

describe('pickRoundWinner', () => {
  const fresh = [c('new-late', 1), c('new-early', 5)];
  const rotation = [c('rot-1', 60), c('rot-2', 90)];

  it('lets a rotation song win on votes', () => {
    const counts = new Map([
      ['rot-2', 2],
      ['new-late', 1],
    ]);
    expect(pickRoundWinner(fresh, rotation, counts)).toMatchObject({
      winner: { id: 'rot-2' },
      fromRotation: true,
    });
  });

  it('breaks ties toward new uploads', () => {
    const counts = new Map([
      ['rot-1', 1],
      ['new-late', 1],
    ]);
    expect(pickRoundWinner(fresh, rotation, counts)).toMatchObject({
      winner: { id: 'new-late' },
      fromRotation: false,
    });
  });

  it('plays the oldest new upload when nobody voted', () => {
    expect(pickRoundWinner(fresh, rotation, new Map())?.winner.id).toBe('new-early');
  });

  it('leaves it to the rotation order when nobody voted and nothing is new', () => {
    expect(pickRoundWinner([], rotation, new Map())).toBeNull();
  });
});

describe('pickWinner', () => {
  it('picks the most voted', () => {
    expect(
      pickWinner(
        [c('a', 5), c('b', 1)],
        new Map([
          ['b', 3],
          ['a', 1],
        ]),
      )?.id,
    ).toBe('b');
  });
  it('breaks ties by earliest request', () => {
    expect(
      pickWinner(
        [c('new', 1), c('old', 9)],
        new Map([
          ['new', 2],
          ['old', 2],
        ]),
      )?.id,
    ).toBe('old');
  });
  it('takes the single candidate even with no votes', () => {
    expect(pickWinner([c('only', 1)], new Map())?.id).toBe('only');
  });
  it('returns null with no candidates', () => {
    expect(pickWinner([], new Map())).toBeNull();
  });
});

describe('computeLockAt', () => {
  const start = new Date('2026-01-01T00:00:00Z');
  it('locks lockLead seconds before the transition', () => {
    expect(computeLockAt(start, 180_000, 30).toISOString()).toBe('2026-01-01T00:02:30.000Z');
  });
  it('keeps voting open for at least 80% of a short track', () => {
    // 46 s track, 30 s lead requested → lead capped at 9.2 s.
    expect(computeLockAt(start, 46_000, 30).toISOString()).toBe('2026-01-01T00:00:36.800Z');
  });
  it('never locks sooner than the minimum lead', () => {
    expect(computeLockAt(start, 4_000, 30).toISOString()).toBe('2026-01-01T00:00:05.000Z');
  });
});

describe('expiry and flags', () => {
  it('expires requests that reach the round limit', () => {
    const out = expiringAfterRound(
      [
        { id: 'a', roundsWaited: 4 },
        { id: 'b', roundsWaited: 1 },
      ],
      5,
    );
    expect(out.map((r) => r.id)).toEqual(['a']);
  });
  it('flags several accounts from one IP voting identically', () => {
    const flags = detectVoteFlags([
      { userId: 'u1', requestId: 'r1', ipHash: 'ip1' },
      { userId: 'u2', requestId: 'r1', ipHash: 'ip1' },
      { userId: 'u3', requestId: 'r2', ipHash: 'ip1' },
      { userId: 'u4', requestId: 'r1', ipHash: 'ip2' },
    ]);
    expect(flags).toEqual([{ ipHash: 'ip1', requestId: 'r1', userIds: ['u1', 'u2'] }]);
  });
});

describe('trackMedia', () => {
  const track = {
    id: 't1',
    storageKey: 'cooked/request/t1.mp3',
    durationMs: 185_000,
    gainDb: -3.2,
    cueInMs: 1200,
    cueOutMs: 181_000,
    crossfadeDurationMs: 6000,
  };
  it('carries the precomputed transition data to the stream engine', () => {
    expect(trackMedia(track, 'https://blob.example/', 5000, 140_000)).toEqual({
      url: 'https://blob.example/cooked/request/t1.mp3',
      cueInMs: 1200,
      cueOutMs: 181_000,
      gainDb: -3.2,
      crossfadeMs: 6000,
      mixFromMs: 140_000,
      fileMs: 185_000,
    });
  });
  it('leaves the mix point unset when it is not known', () => {
    expect(trackMedia(track, 'https://blob.example/', 5000).mixFromMs).toBeNull();
  });
  it('falls back to the whole file and the default crossfade when analysis is missing', () => {
    const m = trackMedia(
      { ...track, cueInMs: null, cueOutMs: null, gainDb: null, crossfadeDurationMs: null },
      'https://blob.example',
      5000,
    );
    expect(m).toMatchObject({ cueInMs: 0, cueOutMs: 185_000, gainDb: 0, crossfadeMs: 5000 });
  });
  it('computes airtime up to the start of the next crossfade', () => {
    expect(airtimeMs(track)).toBe(181_000 - 1200 - 6000);
  });
});
