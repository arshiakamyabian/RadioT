import {
  radioStateSchema,
  type NowPlaying,
  type RadioState,
  type StreamState,
  type UpNext,
} from '@radiot/shared';
import type { Env } from './env.js';
import type { LiquidsoapClient } from './liquidsoap.js';
import { annotateUri } from './liquidsoap.js';
import type { MediaCache } from './media-cache.js';
import { planPieces, type Cursor, type Piece } from './pieces.js';

type Log = {
  info: (o: object, m: string) => void;
  warn: (o: object, m: string) => void;
  error: (o: object, m: string) => void;
  debug: (o: object, m: string) => void;
};

const TICK_MS = 100;
const HISTORY = 8;
/** The program may run this far off the timeline before the engine rejoins it. */
const MAX_LAG_MS = 6000;
/** Leave a rejoin this long to settle before judging the lag again. */
const RESYNC_SETTLE_MS = 30_000;

/**
 * Follows the station timeline of the API and keeps Liquidsoap fed with what it says is on air:
 * the API decides what plays and when (votes, rotation, transition plans); the engine turns that
 * into a continuous program. It is the always-on ticker the timeline never had, and the source of
 * what the website shows as "now playing" (delayed to match what listeners hear).
 */
export class Engine {
  private snapshot: { state: RadioState; fetchedAt: number } | null = null;
  private clockOffset = 0;
  private bestRtt = Infinity;
  private nextPollAt = 0;
  private polling = false;
  private cursor: Cursor | null = null;
  private known: { trackId: string; startedAtMs: number }[] = [];
  private pieceSeq = 0;
  private pushing = false;
  private waiting: string | null = null;
  private history: NowPlaying[] = [];
  private current: NowPlaying | null = null;
  private lastPollOk = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private listeners = new Set<(s: StreamState) => void>();
  private onAir: { id: string; label: string; at: number } | null = null;
  private readonly pieces = new Map<string, Piece>();
  private pushed = 0;
  private resyncs = 0;
  /** How far behind the timeline the last piece went on air, ms. */
  private lagMs = 0;
  private lastResyncAt = 0;

  constructor(
    private readonly env: Env,
    private readonly lq: LiquidsoapClient,
    private readonly cache: MediaCache,
    private readonly log: Log,
  ) {}

  start() {
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    void this.tick();
  }

  stop() {
    clearInterval(this.timer);
    this.lq.close();
  }

  /** The station clock (the API server's), ms. */
  wall() {
    return Date.now() + this.clockOffset;
  }

  subscribe(fn: (s: StreamState) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  state(): StreamState {
    const now = this.snapshot?.state.now ?? null;
    return {
      now,
      next: this.snapshot?.state.next ?? null,
      history: this.history,
      serverTime: new Date(this.wall()).toISOString(),
      // What listeners hear runs behind by the encoder/HLS delay plus any lag of the playout.
      streamDelayMs: this.env.STREAM_DELAY_MS + Math.max(0, Math.round(this.lagMs)),
      live: !!now?.media && Date.now() - this.lastPollOk < 30_000,
      hlsUrl: `${this.env.PUBLIC_URL}/hls/radiot.m3u8`,
      mp3Url: `${this.env.PUBLIC_URL}/radiot.mp3`,
    };
  }

  health() {
    return {
      ok: true,
      wall: new Date(this.wall()).toISOString(),
      lastPollAgoMs: this.lastPollOk ? Date.now() - this.lastPollOk : null,
      clockOffsetMs: Math.round(this.clockOffset),
      onAir: this.onAir,
      lagMs: Math.round(this.lagMs),
      waiting: this.waiting,
      cursor: this.cursor && {
        trackId: this.cursor.trackId,
        posMs: Math.round(this.cursor.posMs),
        queuedUntil: new Date(
          this.cursor.startedAtMs + (this.cursor.posMs - this.cursor.media.cueInMs),
        ).toISOString(),
      },
      piecesPushed: this.pushed,
      resyncs: this.resyncs,
    };
  }

  /** Liquidsoap reports a piece going on air (its own clock, before encoding). */
  noteOnAir(id: string) {
    const piece = this.pieces.get(id);
    this.onAir = { id, label: piece?.label ?? id, at: Date.now() };
    const lag = piece ? this.wall() - piece.atMs : null;
    this.log.info({ id, label: piece?.label, lagMs: lag && Math.round(lag) }, 'on air');
    if (lag !== null) {
      const hadLag = this.lagMs;
      this.lagMs = lag;
      if (hadLag !== lag) this.emit();
      if (Math.abs(lag) > MAX_LAG_MS && Date.now() - this.lastResyncAt > RESYNC_SETTLE_MS)
        this.resync(`program is ${Math.round(lag / 1000)} s off the timeline`);
    }
    for (const key of this.pieces.keys()) {
      if (Number(key.slice(1)) < Number(id.slice(1)) - 12) this.pieces.delete(key);
    }
  }

  private emit() {
    if (!this.listeners.size) return;
    const s = this.state();
    for (const fn of this.listeners) fn(s);
  }

  private async tick() {
    const wall = this.wall();
    if (wall >= this.nextPollAt && !this.polling) void this.poll();
    if (this.pushing || !this.snapshot) return;
    this.pushing = true;
    try {
      this.checkResync();
      const { now, next } = this.snapshot.state;
      const out = planPieces({
        now,
        next,
        cursor: this.cursor,
        wall,
        ready: (url) => this.cache.isReady(url),
        nextId: () => `p${++this.pieceSeq}`,
      });
      this.waiting = out.waiting;
      for (const piece of out.pieces) await this.push(piece);
      this.cursor = out.cursor;
      for (const e of out.entered) {
        this.known.push({ trackId: e.trackId, startedAtMs: e.startedAtMs });
        this.log.info({ ...e }, 'track entered');
      }
      if (this.known.length > 12) this.known.splice(0, this.known.length - 12);
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, 'could not feed liquidsoap');
    } finally {
      this.pushing = false;
    }
  }

  private async push(piece: Piece) {
    // Tracks are cut to the exact sample; a transition clip is played whole.
    const file =
      piece.kind === 'clip'
        ? this.cache.localPath(piece.url)
        : piece.kind === 'mix' && piece.mixWith && piece.toMs !== null
          ? await this.cache.mix(
              { url: piece.url, fromMs: piece.fromMs, toMs: piece.toMs, gainDb: piece.gainDb },
              piece.mixWith,
              piece.id,
            )
          : await this.cache.cut(piece.url, piece.fromMs, piece.toMs, piece.id);
    if (!file) throw new Error(`piece ${piece.id} has no local file`);
    const uri = annotateUri(file, {
      id: piece.id,
      // A mix has both tracks' gains baked in.
      gainDb: piece.kind === 'mix' ? 0 : piece.gainDb,
      crossMs: piece.crossMs,
    });
    await this.lq.push(uri);
    this.pieces.set(piece.id, piece);
    this.pushed++;
    this.log.info(
      { id: piece.id, kind: piece.kind, label: piece.label, crossMs: piece.crossMs },
      'queued',
    );
  }

  /** The timeline moved somewhere the queue does not lead to (skip, restart): rejoin it. */
  private checkResync() {
    const now = this.snapshot?.state.now;
    if (!now?.media || !this.cursor || !this.known.length) return;
    const startedAt = Date.parse(now.startedAt);
    const known = this.known.some(
      (k) => k.trackId === now.trackId && Math.abs(k.startedAtMs - startedAt) < 4000,
    );
    if (known) return;
    this.resync(`timeline jumped to ${now.trackId}`);
  }

  /** Drops the queue and starts again from what the timeline says is on air right now. */
  private resync(reason: string) {
    this.log.warn({ reason }, 'rejoining the timeline');
    this.resyncs++;
    this.lastResyncAt = Date.now();
    this.cursor = null;
    this.known = [];
    this.lagMs = 0;
    void this.lq
      .flushAndSkip()
      .catch((e: Error) => this.log.warn({ err: e.message }, 'flush failed'));
  }

  private async poll() {
    this.polling = true;
    const sentAt = Date.now();
    try {
      const res = await fetch(`${this.env.API_URL}/api/now-playing`, {
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`api answered ${res.status}`);
      const state = radioStateSchema.parse(await res.json());
      const receivedAt = Date.now();
      const rtt = receivedAt - sentAt;
      const offset = Date.parse(state.serverTime) - (sentAt + receivedAt) / 2;
      if (rtt <= this.bestRtt * 1.5 || Math.abs(offset - this.clockOffset) > 2000) {
        this.clockOffset = offset;
        this.bestRtt = rtt;
      } else this.bestRtt *= 1.05;
      this.lastPollOk = receivedAt;
      this.snapshot = { state, fetchedAt: receivedAt };
      this.trackHistory(state.now);
      this.prefetch(state.now, state.next);
      this.emit();
      // Check back at the next scheduled change, and quickly while a hand-over is being prepared.
      const waitingForNext = !state.next || (state.next && !state.next.transition);
      const hurry = this.cursor && waitingForNext && this.cursorAheadMs() < 25_000;
      const dueIn = Date.parse(state.dueAt) - this.wall();
      this.nextPollAt = this.wall() + Math.max(500, Math.min(hurry ? 700 : 5000, dueIn + 80));
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, 'api poll failed');
      this.nextPollAt = this.wall() + 2000;
    } finally {
      this.polling = false;
    }
  }

  private cursorAheadMs() {
    const c = this.cursor;
    return c ? c.startedAtMs + (c.posMs - c.media.cueInMs) - this.wall() : Infinity;
  }

  private trackHistory(now: NowPlaying | null) {
    if (!now) return;
    const cur = this.current;
    if (cur && (cur.trackId !== now.trackId || cur.startedAt !== now.startedAt)) {
      this.history = [cur, ...this.history].slice(0, HISTORY);
    }
    this.current = now;
  }

  /** Starts downloading and converting what will be needed, so pieces are ready when due. */
  private prefetch(now: NowPlaying | null, next: UpNext | null) {
    const urls = [now?.media?.url, next?.media.url, next?.transition?.clipUrl].filter(
      (u): u is string => !!u,
    );
    for (const url of urls) {
      if (this.cache.isReady(url)) continue;
      this.cache
        .fetch(url)
        .catch((err: Error) => this.log.warn({ err: err.message }, 'fetch failed'));
    }
  }
}
