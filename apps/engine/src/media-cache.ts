import { createHash } from 'node:crypto';
import { mkdir, readdir, rename, stat, unlink, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { run } from './exec.js';

const SAMPLE_RATE = 44_100;

/**
 * Local FLAC copies of the cooked tracks and transition clips. Decoding with ffmpeg here (the
 * same decoder the renderer uses) means positions in the files are exactly the positions the
 * transition plans refer to, whatever the MP3 encoder padding is. Liquidsoap then cuts and joins
 * these files sample-accurately.
 */
export class MediaCache {
  private inflight = new Map<string, Promise<string>>();
  private readonly piecesDir: string;
  private readonly ready = new Map<string, string>();

  constructor(
    private readonly dir: string,
    private readonly ffmpeg: string,
    private readonly maxBytes: number,
    private readonly log: {
      info: (o: object, m: string) => void;
      warn: (o: object, m: string) => void;
    },
  ) {
    this.piecesDir = join(dir, '..', 'pieces');
  }

  private pathFor(url: string) {
    return join(this.dir, `${createHash('sha1').update(url).digest('hex').slice(0, 20)}.flac`);
  }

  /** Synchronous: is this URL already converted and on disk? */
  isReady(url: string) {
    return this.ready.has(url);
  }

  localPath(url: string) {
    return this.ready.get(url) ?? null;
  }

  /** Starts (or joins) the download + conversion; resolves to the local path. */
  fetch(url: string): Promise<string> {
    const done = this.ready.get(url);
    if (done) return Promise.resolve(done);
    let job = this.inflight.get(url);
    if (!job) {
      job = this.convert(url).finally(() => this.inflight.delete(url));
      this.inflight.set(url, job);
    }
    return job;
  }

  private async convert(url: string) {
    await mkdir(this.dir, { recursive: true });
    const target = this.pathFor(url);
    const existing = await stat(target).catch(() => null);
    if (existing && existing.size > 1000) {
      this.ready.set(url, target);
      await utimes(target, new Date(), new Date()).catch(() => undefined);
      return target;
    }
    const tmp = `${target}.part.flac`;
    const started = Date.now();
    let lastError = '';
    for (let attempt = 1; attempt <= 3; attempt++) {
      const res = await run(
        this.ffmpeg,
        [
          '-nostdin',
          '-v',
          'error',
          '-y',
          '-reconnect',
          '1',
          '-reconnect_streamed',
          '1',
          '-reconnect_delay_max',
          '3',
          '-i',
          url,
          '-map',
          '0:a:0',
          '-vn',
          '-ar',
          '44100',
          '-ac',
          '2',
          '-c:a',
          'flac',
          '-compression_level',
          '1',
          tmp,
        ],
        120_000,
      );
      if (res.code === 0) {
        await rename(tmp, target);
        this.ready.set(url, target);
        this.log.info({ url: url.slice(-60), ms: Date.now() - started }, 'media cached');
        void this.evict();
        return target;
      }
      lastError = res.stderr.slice(-300);
      await unlink(tmp).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
    throw new Error(`could not fetch ${url.slice(-60)}: ${lastError}`);
  }

  /**
   * Cuts [fromMs, toMs) out of a cached track into its own WAV, to the exact sample. Liquidsoap
   * starts a cue-in exactly but ends a cue-out up to ~30 samples late, which would repeat a
   * sliver of audio at every join; a file that is already the right length ends exactly.
   */
  async cut(url: string, fromMs: number, toMs: number | null, id: string): Promise<string> {
    const src = this.ready.get(url);
    if (!src) throw new Error('cannot cut a track that is not cached');
    await mkdir(this.piecesDir, { recursive: true });
    const target = join(this.piecesDir, `${id}.wav`);
    const first = Math.round((fromMs / 1000) * SAMPLE_RATE);
    const end = toMs === null ? '' : `:end_sample=${Math.round((toMs / 1000) * SAMPLE_RATE)}`;
    const res = await run(
      this.ffmpeg,
      [
        '-nostdin',
        '-v',
        'error',
        '-y',
        '-i',
        src,
        '-af',
        `atrim=start_sample=${first}${end},asetpts=N/SR/TB`,
        '-c:a',
        'pcm_s16le',
        '-f',
        'wav',
        target,
      ],
      60_000,
    );
    if (res.code !== 0) throw new Error(`could not cut piece ${id}: ${res.stderr.slice(-200)}`);
    void this.sweepPieces();
    return target;
  }

  /** Piece files are only needed until Liquidsoap has played them. */
  /**
   * Renders a crossfade: `a` fading out over `b` fading in (equal power), both the same length,
   * with each track's gain baked in. The result lasts exactly as long as each part.
   */
  async mix(
    a: { url: string; fromMs: number; toMs: number; gainDb: number },
    b: { url: string; fromMs: number; gainDb: number },
    id: string,
  ): Promise<string> {
    const srcA = this.ready.get(a.url);
    const srcB = this.ready.get(b.url);
    if (!srcA || !srcB) throw new Error('cannot mix tracks that are not cached');
    await mkdir(this.piecesDir, { recursive: true });
    const target = join(this.piecesDir, `${id}.wav`);
    const n = Math.round(((a.toMs - a.fromMs) / 1000) * SAMPLE_RATE);
    const aFirst = Math.round((a.fromMs / 1000) * SAMPLE_RATE);
    const bFirst = Math.round((b.fromMs / 1000) * SAMPLE_RATE);
    const part = (input: number, first: number, gainDb: number, label: string) =>
      `[${input}:a]atrim=start_sample=${first}:end_sample=${first + n},asetpts=N/SR/TB,` +
      `apad=whole_len=${n},volume=${gainDb.toFixed(2)}dB[${label}]`;
    const graph = [
      part(0, aFirst, a.gainDb, 'a'),
      part(1, bFirst, b.gainDb, 'b'),
      `[a][b]acrossfade=ns=${n}:c1=qsin:c2=qsin[out]`,
    ].join(';');
    const res = await run(
      this.ffmpeg,
      [
        '-nostdin',
        '-v',
        'error',
        '-y',
        '-i',
        srcA,
        '-i',
        srcB,
        '-filter_complex',
        graph,
        '-map',
        '[out]',
        '-c:a',
        'pcm_s16le',
        '-f',
        'wav',
        target,
      ],
      60_000,
    );
    if (res.code !== 0) throw new Error(`could not mix piece ${id}: ${res.stderr.slice(-200)}`);
    void this.sweepPieces();
    return target;
  }

  private async sweepPieces() {
    const names = await readdir(this.piecesDir).catch(() => []);
    const old = Date.now() - 15 * 60_000;
    for (const n of names) {
      const path = join(this.piecesDir, n);
      const s = await stat(path).catch(() => null);
      if (s && s.mtimeMs < old) await unlink(path).catch(() => undefined);
    }
  }

  /** Keeps the cache under its size limit, dropping the least recently used files first. */
  private async evict(keep: Set<string> = new Set(this.ready.values())) {
    const names = (await readdir(this.dir).catch(() => [])).filter((n) => n.endsWith('.flac'));
    const files = await Promise.all(
      names.map(async (n) => {
        const path = join(this.dir, n);
        const s = await stat(path).catch(() => null);
        return s ? { path, size: s.size, used: s.atimeMs } : null;
      }),
    );
    const list = files.filter((f): f is NonNullable<typeof f> => !!f);
    let total = list.reduce((s, f) => s + f.size, 0);
    if (total <= this.maxBytes) return;
    list.sort((a, b) => a.used - b.used);
    for (const f of list) {
      if (total <= this.maxBytes * 0.8) break;
      if (keep.has(f.path) && list.length < 4) continue;
      await unlink(f.path).catch(() => undefined);
      for (const [url, path] of this.ready) if (path === f.path) this.ready.delete(url);
      total -= f.size;
    }
  }
}
