import { lookup } from 'node:dns/promises';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rename, rm } from 'node:fs/promises';
import { isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { run } from './media/exec.js';

// Blocks requests that would let a user make the server fetch internal resources (SSRF).
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v === '::1' || v === '::') return true;
    if (v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80')) return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
    return mapped ? isPrivateAddress(mapped[1]!) : false;
  }
  const [a, b] = ip.split('.').map(Number) as [number, number];
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

/** `permanent` = retrying won't help (e.g. 404); otherwise the job is retried. */
export class DownloadError extends Error {
  constructor(
    message: string,
    readonly permanent: boolean,
  ) {
    super(message);
  }
}

export async function assertPublicUrl(raw: string) {
  const url = new URL(raw);
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new Error('unsupported protocol');
  const addrs = await lookup(url.hostname, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) {
    throw new Error('URL resolves to a private address');
  }
}

/** Streams a public URL to disk, enforcing a byte limit. Redirects are re-validated. */
export async function downloadPublic(
  raw: string,
  file: string,
  maxBytes: number,
  hops = 3,
): Promise<void> {
  await assertPublicUrl(raw);
  // Abort only when the server goes quiet (slow hosts are fine), plus a generous overall cap.
  const controller = new AbortController();
  const overall = setTimeout(
    () => controller.abort(new Error('download took longer than 10 minutes')),
    10 * 60_000,
  );
  let idle = setTimeout(() => controller.abort(new Error('server stopped sending data')), 45_000);
  const bump = () => {
    clearTimeout(idle);
    idle = setTimeout(() => controller.abort(new Error('server stopped sending data')), 45_000);
  };
  const res = await fetch(raw, {
    redirect: 'manual',
    signal: controller.signal,
    headers: {
      'user-agent': 'Mozilla/5.0 (compatible; RadioT/1.0; +https://radiot.app)',
      accept: 'audio/*,*/*;q=0.8',
    },
  }).catch((err: unknown) => {
    clearTimeout(overall);
    clearTimeout(idle);
    throw err;
  });
  if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
    clearTimeout(overall);
    clearTimeout(idle);
    if (hops <= 0) throw new Error('too many redirects');
    return downloadPublic(
      new URL(res.headers.get('location')!, raw).toString(),
      file,
      maxBytes,
      hops - 1,
    );
  }
  if (!res.ok || !res.body) {
    clearTimeout(overall);
    clearTimeout(idle);
    throw new DownloadError(
      `the link returned HTTP ${res.status}`,
      res.status >= 400 && res.status < 500,
    );
  }
  let seen = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      seen += chunk.length;
      bump();
      cb(seen > maxBytes ? new Error('file exceeds size limit') : null, chunk);
    },
  });
  try {
    await pipeline(
      Readable.fromWeb(res.body as WebReadableStream),
      limiter,
      createWriteStream(file),
    );
  } finally {
    clearTimeout(overall);
    clearTimeout(idle);
  }
}

/**
 * Downloads a SoundCloud track, or the first full-length hit of a `scsearch5:` query, with
 * yt-dlp. Previews (SoundCloud Go+ tracks give 30 s) are skipped by the duration filter.
 */
export async function downloadWithYtdlp(
  raw: string,
  file: string,
  maxBytes: number,
  bin: string,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'ytdlp-'));
  try {
    const res = await run(
      bin,
      [
        '--no-playlist',
        '--no-progress',
        '--no-warnings',
        '--no-cache-dir',
        '--max-filesize',
        String(maxBytes),
        '--match-filter',
        '!is_live & duration >= 60',
        '--max-downloads',
        '1',
        '-f',
        'ba[ext=mp3]/ba[ext=m4a]/ba/b',
        '-o',
        join(dir, 'dl.%(ext)s'),
        '--print',
        'after_move:filepath',
        '--',
        raw,
      ],
      { timeoutMs: 8 * 60_000, env: { ...process.env, HOME: dir } },
    ).catch((err: NodeJS.ErrnoException) => {
      throw new DownloadError(
        err.code === 'ENOENT' ? 'yt-dlp is not installed on the media server' : err.message,
        false,
      );
    });
    // 101 = stopped after --max-downloads, i.e. one file was downloaded.
    const out = res.stdout.toString().trim().split('\n').filter(Boolean).at(-1);
    if ((res.code === 0 || res.code === 101) && out) {
      await rename(out, file);
      return;
    }
    const err =
      res.stderr
        .split('\n')
        .filter((l) => l.includes('ERROR'))
        .at(-1) ?? '';
    if (res.code === 0 || res.code === 101)
      throw new DownloadError(
        raw.startsWith('scsearch')
          ? 'no full-length version of this song was found on SoundCloud'
          : 'SoundCloud only offers a preview of this track',
        true,
      );
    const permanent = /404|not found|private|unavailable|unsupported url|geo/i.test(err);
    throw new DownloadError(
      err.replace(/^ERROR:\s*/, '').slice(0, 200) || 'yt-dlp failed',
      permanent,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
