import type { NowPlaying, TrackMedia, UpNext } from '@radiot/shared';

/**
 * Turns the station timeline (what the API says is on air and what comes next) into the pieces
 * Liquidsoap plays: cut parts of track files and pre-rendered transition clips, joined by file
 * position. Joins are exact because the transition renderer defines them in file positions:
 *
 *   A [cursor .. clip.aFileStartMs)  +  clip [0 .. clipMs)
 *     +  B [clip.handoffFileMs + (clipMs - handoffClipMs) .. ]
 *
 * Wall-clock time only decides *when* to hand a piece to Liquidsoap, never where a join is.
 */

export interface Cursor {
  trackId: string;
  /** Timeline time (ms) at which the track's cue-in goes on air. */
  startedAtMs: number;
  media: TrackMedia;
  /** Everything of the track before this file position (ms) has been queued. */
  posMs: number;
}

export interface Piece {
  id: string;
  /** 'mix' = this part of a crossfaded with the opening of `mixWith`, rendered by the engine. */
  kind: 'track' | 'clip' | 'mix';
  url: string;
  fromMs: number;
  /** null = to the end of the file */
  toMs: number | null;
  gainDb: number;
  /** Liquidsoap crossfade into the next piece, ms (0 = gapless join). */
  crossMs: number;
  /** Track whose audio this is (the incoming track for a clip). */
  trackId: string;
  label: string;
  /** Timeline time (ms) at which this piece should go on air; the engine checks it was. */
  atMs: number;
  mixWith?: { url: string; fromMs: number; toMs: number; gainDb: number };
}

export interface PlanConfig {
  /** Hand pieces to Liquidsoap when they start within this long. */
  lookaheadMs: number;
  /** When the queued audio has this little left, stop waiting and commit to what is known. */
  commitMs: number;
  /** Length of the chunks of the current track played while the next one is still unknown. */
  holdMs: number;
  /** A late joiner starts this far ahead of "now" (time to resolve the piece). */
  joinLeadMs: number;
}

export const DEFAULT_PLAN_CONFIG: PlanConfig = {
  lookaheadMs: 12_000,
  commitMs: 1_200,
  holdMs: 3_000,
  joinLeadMs: 400,
};

const MIN_PIECE_MS = 20;

export interface PlanInput {
  now: NowPlaying | null;
  next: UpNext | null;
  cursor: Cursor | null;
  /** Timeline clock, ms. */
  wall: number;
  ready: (url: string) => boolean;
  cfg?: PlanConfig;
  nextId: () => string;
}

export interface PlanOutput {
  pieces: Piece[];
  cursor: Cursor | null;
  /** Why planning stopped early (for logs and /health). */
  waiting: string | null;
  /** Tracks entered in this call (join, hand-over): the engine records them as known. */
  entered: { trackId: string; startedAtMs: number; how: 'join' | 'clip' | 'crossfade' }[];
}

export const wallOf = (c: Cursor, posMs: number) => c.startedAtMs + (posMs - c.media.cueInMs);
export const posAt = (c: Cursor, wall: number) => c.media.cueInMs + (wall - c.startedAtMs);

/** Where the plain part of a track ends: the engine cuts here so what follows can be chosen later. */
export function splitOf(c: Cursor) {
  const m = c.media;
  const wanted = m.mixFromMs ?? Math.max(c.posMs, m.cueOutMs - 20_000);
  return Math.min(m.cueOutMs, Math.max(wanted, m.cueInMs));
}

export function planPieces(input: PlanInput): PlanOutput {
  const cfg = input.cfg ?? DEFAULT_PLAN_CONFIG;
  const { now, next, wall, ready } = input;
  const pieces: Piece[] = [];
  const entered: PlanOutput['entered'] = [];
  let waiting: string | null = null;
  let c = input.cursor;

  const track = (cur: Cursor, from: number, to: number | null, crossMs = 0): Piece => ({
    id: input.nextId(),
    kind: 'track',
    url: cur.media.url,
    fromMs: from,
    toMs: to,
    gainDb: cur.media.gainDb,
    crossMs,
    trackId: cur.trackId,
    atMs: wallOf(cur, from),
    label: `${cur.trackId.slice(0, 8)} ${(from / 1000).toFixed(1)}-${to === null ? 'end' : (to / 1000).toFixed(1)}s`,
  });

  for (let guard = 0; guard < 12; guard++) {
    if (!c) {
      if (!now?.media) {
        waiting = 'nothing on air';
        break;
      }
      const m = now.media;
      if (!ready(m.url)) {
        waiting = 'fetching the track on air';
        break;
      }
      const startedAtMs = Date.parse(now.startedAt);
      const pos = Math.max(m.cueInMs, m.cueInMs + (wall + cfg.joinLeadMs - startedAtMs));
      if (pos >= m.cueOutMs - 1500) {
        waiting = 'track on air is about to end';
        break;
      }
      c = { trackId: now.trackId ?? 'unknown', startedAtMs, media: m, posMs: pos };
      entered.push({ trackId: c.trackId, startedAtMs, how: 'join' });
    }

    const m = c.media;
    const end = wallOf(c, c.posMs);
    const ahead = end - wall;
    const split = splitOf(c);
    const nxt = next && next.trackId !== c.trackId ? next : null;

    // 1. The plain stretch of this track, up to where a transition may begin.
    if (c.posMs < split - MIN_PIECE_MS) {
      if (ahead > cfg.lookaheadMs) break;
      if (!ready(m.url)) {
        waiting = 'fetching the current track';
        break;
      }
      pieces.push(track(c, c.posMs, split));
      c = { ...c, posMs: split };
      continue;
    }

    // 2. At the split the next track decides how to go on.
    if (nxt) {
      const tr = nxt.transition;
      const clipUsable =
        !!tr && ready(tr.clipUrl) && ready(nxt.media.url) && tr.aFileStartMs >= c.posMs - 5;
      if (tr && clipUsable) {
        if (ahead > cfg.lookaheadMs) break;
        if (tr.aFileStartMs > c.posMs + MIN_PIECE_MS)
          pieces.push(track(c, c.posMs, tr.aFileStartMs));
        const clipAt = wallOf(c, Math.max(c.posMs, tr.aFileStartMs));
        pieces.push({
          id: input.nextId(),
          kind: 'clip',
          url: tr.clipUrl,
          fromMs: 0,
          toMs: null,
          gainDb: 0,
          crossMs: 0,
          trackId: nxt.trackId,
          atMs: clipAt,
          label: `clip ${tr.style} ${(tr.clipMs / 1000).toFixed(1)}s`,
        });
        // From handoffClipMs on, the clip is b alone at normal speed (its lead-out), so b's file
        // goes on where the clip stops: handoffFileMs + the lead-out. Resuming at handoffFileMs
        // replayed the lead-out (8-14 s) and left the program that far behind the timeline.
        // Inside the clip b may be stretched or enter past its cue-in, so b is anchored at the
        // handoff, which is also where the API's timeline puts it.
        const startedAtMs = Date.parse(nxt.startsAt);
        const handoffAt = clipAt + tr.handoffClipMs;
        c = {
          trackId: nxt.trackId,
          startedAtMs: handoffAt - (tr.handoffFileMs - nxt.media.cueInMs),
          media: nxt.media,
          posMs: tr.handoffFileMs + (tr.clipMs - tr.handoffClipMs),
        };
        entered.push({ trackId: c.trackId, startedAtMs, how: 'clip' });
        continue;
      }
      // No usable clip (not announced, not downloaded yet, or too late): wait for one until the
      // queued audio is nearly out, then fall back to a plain crossfade.
      if (ahead > cfg.commitMs) {
        waiting = tr ? 'fetching the transition clip' : 'waiting for the transition clip';
        break;
      }
      if (ready(nxt.media.url)) {
        const fade = nxt.fadeMs ?? m.crossfadeMs;
        const startsAt = Date.parse(nxt.startsAt);
        const bStart = Math.max(startsAt, end);
        const limit = Math.min(m.fileMs ?? Infinity, m.cueOutMs + 1500);
        const endPos = Math.min(limit, Math.max(posAt(c, bStart + fade), c.posMs + fade));
        const bPos = Math.max(nxt.media.cueInMs, nxt.media.cueInMs + (bStart - startsAt));
        // The overlap is mixed by the engine into one piece: Liquidsoap only ever joins
        // pieces end to end, so the program can't drift from the timeline at a crossfade.
        const overlap = Math.max(0, Math.min(fade, endPos - c.posMs));
        const mixFrom = endPos - overlap;
        if (mixFrom > c.posMs + MIN_PIECE_MS) pieces.push(track(c, c.posMs, mixFrom));
        if (overlap >= MIN_PIECE_MS) {
          pieces.push({
            id: input.nextId(),
            kind: 'mix',
            url: m.url,
            fromMs: mixFrom,
            toMs: endPos,
            gainDb: m.gainDb,
            crossMs: 0,
            trackId: nxt.trackId,
            atMs: wallOf(c, mixFrom),
            mixWith: {
              url: nxt.media.url,
              fromMs: bPos,
              toMs: bPos + overlap,
              gainDb: nxt.media.gainDb,
            },
            label: `mix ${(overlap / 1000).toFixed(1)}s`,
          });
        }
        c = {
          trackId: nxt.trackId,
          startedAtMs: startsAt,
          media: nxt.media,
          posMs: bPos + (overlap >= MIN_PIECE_MS ? overlap : 0),
        };
        entered.push({ trackId: c.trackId, startedAtMs: startsAt, how: 'crossfade' });
        continue;
      }
      waiting = 'next track not downloaded in time';
    }

    // 3. Nothing to hand over to yet: keep the current track going, as late as possible, in
    // short chunks, so a clip that arrives a moment later can still start exactly on its mark.
    if (ahead > cfg.commitMs) break;
    const limit = Math.min(m.fileMs ?? Infinity, m.cueOutMs);
    const chunk = Math.min(cfg.holdMs, limit - c.posMs);
    if (chunk < MIN_PIECE_MS) {
      waiting = waiting ?? 'end of track reached without a next track';
      break;
    }
    pieces.push(track(c, c.posMs, c.posMs + chunk));
    c = { ...c, posMs: c.posMs + chunk };
  }

  return { pieces, cursor: c, waiting, entered };
}
