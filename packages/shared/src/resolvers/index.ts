import { ALLOWED_AUDIO_MIME } from '../media.js';

export interface ResolvedAudio {
  /** A direct file URL, a SoundCloud page, or a `scsearch5:<query>` search (see `viaYtdlp`). */
  url: string;
  contentType: string;
  size: number | null;
  filename: string;
  title?: string;
  artist?: string;
  artworkUrl?: string;
}

/** Links the worker hands to yt-dlp instead of fetching directly. */
export const SOUNDCLOUD_HOSTS = ['soundcloud.com', 'on.soundcloud.com', 'm.soundcloud.com'];
export const viaYtdlp = (raw: string) => {
  if (raw.startsWith('scsearch')) return true;
  try {
    return SOUNDCLOUD_HOSTS.includes(new URL(raw).hostname.replace(/^www\./, ''));
  } catch {
    return false;
  }
};

export interface LinkResolver {
  readonly name: string;
  canResolve(url: URL): boolean;
  resolve(url: URL): Promise<ResolvedAudio>;
}

export class ResolveError extends Error {
  constructor(
    message: string,
    readonly code: 'unsupported' | 'unimplemented' | 'not_audio' | 'too_large' | 'unreachable',
  ) {
    super(message);
  }
}

export class UnimplementedResolver implements LinkResolver {
  constructor(
    readonly name: string,
    private readonly hosts: string[],
  ) {}

  canResolve(url: URL) {
    return this.hosts.some((h) => url.hostname === h || url.hostname.endsWith(`.${h}`));
  }

  async resolve(): Promise<ResolvedAudio> {
    // TODO: only via an officially licensed API. Ripping audio from this platform is not allowed.
    throw new ResolveError(`${this.name} links are not supported yet`, 'unimplemented');
  }
}

export const AppleMusicResolver = () =>
  new UnimplementedResolver('Apple Music', ['music.apple.com']);

const AUDIO_EXT = /\.(mp3|m4a|aac|flac|ogg|oga|opus|wav|webm)$/i;
const isAudioType = (t: string) =>
  (ALLOWED_AUDIO_MIME as readonly string[]).includes(t) || t.startsWith('audio/');

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class DirectAudioResolver implements LinkResolver {
  readonly name = 'Direct audio';
  constructor(
    private readonly maxBytes: number,
    private readonly fetcher: FetchLike = fetch,
  ) {}

  canResolve(url: URL) {
    return url.protocol === 'https:' || url.protocol === 'http:';
  }

  async resolve(url: URL): Promise<ResolvedAudio> {
    let res: Response;
    try {
      res = await this.fetcher(url.toString(), {
        method: 'HEAD',
        redirect: 'follow',
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      throw new ResolveError('Could not reach that URL', 'unreachable');
    }
    if (!res.ok) throw new ResolveError(`URL responded with ${res.status}`, 'unreachable');
    const contentType = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    const finalUrl = new URL(res.url || url.toString());
    const looksAudio =
      isAudioType(contentType) ||
      (contentType === 'application/octet-stream' && AUDIO_EXT.test(finalUrl.pathname));
    if (!looksAudio) throw new ResolveError('That link is not a direct audio file', 'not_audio');
    const lengthHeader = res.headers.get('content-length');
    const size = lengthHeader ? Number(lengthHeader) : null;
    if (size !== null && size > this.maxBytes) {
      throw new ResolveError('That file is too large', 'too_large');
    }
    const filename = decodeURIComponent(finalUrl.pathname.split('/').pop() || 'audio');
    return { url: finalUrl.toString(), contentType, size, filename };
  }
}

const hostIn = (url: URL, hosts: string[]) =>
  hosts.some((h) => url.hostname === h || url.hostname.endsWith(`.${h}`));

const meta = (html: string, prop: string) => {
  const m =
    html.match(new RegExp(`<meta[^>]+(?:property|name)="${prop}"[^>]+content="([^"]*)"`, 'i')) ??
    html.match(new RegExp(`<meta[^>]+content="([^"]*)"[^>]+(?:property|name)="${prop}"`, 'i'));
  return m ? decodeEntities(m[1]!) : '';
};
const decodeEntities = (s: string) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** SoundCloud tracks: the worker downloads them with yt-dlp; oEmbed gives title and artist. */
export class SoundCloudResolver implements LinkResolver {
  readonly name = 'SoundCloud';
  constructor(private readonly fetcher: FetchLike = fetch) {}

  canResolve(url: URL) {
    return hostIn(url, SOUNDCLOUD_HOSTS);
  }

  async resolve(url: URL): Promise<ResolvedAudio> {
    url.search = '';
    if (/\/sets\//.test(url.pathname))
      throw new ResolveError('That is a SoundCloud playlist. Paste a single track.', 'unsupported');
    let res: Response;
    try {
      res = await this.fetcher(
        `https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(url.toString())}`,
        { signal: AbortSignal.timeout(8000) },
      );
    } catch {
      throw new ResolveError('Could not reach SoundCloud', 'unreachable');
    }
    if (!res.ok)
      throw new ResolveError('That SoundCloud track is private or does not exist', 'unreachable');
    const o = (await res.json()) as {
      title?: string;
      author_name?: string;
      thumbnail_url?: string;
    };
    const artist = o.author_name?.trim() ?? '';
    // oEmbed titles read "<track> by <uploader>".
    const title = (o.title ?? '').replace(new RegExp(` by ${escapeRe(artist)}$`), '').trim();
    return {
      url: url.toString(),
      contentType: 'audio/mpeg',
      size: null,
      filename: title || 'SoundCloud track',
      title,
      artist,
      artworkUrl: o.thumbnail_url,
    };
  }
}

/** Main artist + bare song name: "(feat. …)" and "- 2011 Remaster" make SoundCloud miss. */
export const searchQuery = (artist: string, title: string) =>
  `${artist.split(',')[0]!.trim()} ${title
    .replace(/\s*[([](feat|ft|with)\.?\s[^)\]]*[)\]]/gi, '')
    .replace(/\s+(feat|ft)\.?\s.*$/i, '')
    .replace(/\s+-\s+[^-]*(remaster|version|edit|mix)[^-]*$/i, '')}`.trim();

/**
 * Spotify audio can't be downloaded (DRM). The track page gives its name and artist, and the
 * worker downloads the same song from SoundCloud by search.
 */
export class SpotifyResolver implements LinkResolver {
  readonly name = 'Spotify';
  constructor(private readonly fetcher: FetchLike = fetch) {}

  canResolve(url: URL) {
    return hostIn(url, ['spotify.com', 'spotify.link']);
  }

  async resolve(url: URL): Promise<ResolvedAudio> {
    let res: Response;
    try {
      res = await this.fetcher(url.toString(), {
        redirect: 'follow',
        signal: AbortSignal.timeout(8000),
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; RadioT link preview)' },
      });
    } catch {
      throw new ResolveError('Could not reach Spotify', 'unreachable');
    }
    if (!res.ok) throw new ResolveError('That Spotify link does not work', 'unreachable');
    const finalPath = new URL(res.url || url.toString()).pathname;
    if (!/\/track\//.test(finalPath))
      throw new ResolveError(
        'Paste a link to a single Spotify song, not an album or playlist.',
        'unsupported',
      );
    const html = await res.text();
    const title = meta(html, 'og:title').trim();
    // og:description reads "<artist> · <album> · Song · <year>".
    const artist =
      meta(html, 'music:musician_description').trim() ||
      meta(html, 'og:description').split(' · ')[0]!.trim();
    if (!title)
      throw new ResolveError('Could not read the song from that Spotify link', 'not_audio');
    return {
      url: `scsearch5:${searchQuery(artist, title)}`,
      contentType: 'audio/mpeg',
      size: null,
      filename: title,
      title,
      artist,
      artworkUrl: meta(html, 'og:image') || undefined,
    };
  }
}

const VIDEO_NOISE =
  /\s*[([][^)\]]*\b(official|video|audio|lyrics?|visuali[sz]er|hd|hq|4k|mv|clip)\b[^)\]]*[)\]]/gi;

/** "Artist - Song (Official Video)" or a channel ("ArtistVEVO", "Artist - Topic") + "Song". */
export function parseVideoTitle(videoTitle: string, channel: string) {
  const clean = videoTitle.replace(VIDEO_NOISE, '').replace(/\s+/g, ' ').trim();
  const dash = clean.match(/^(.+?)\s+[-–—|]\s+(.+)$/);
  if (dash) return { artist: dash[1]!.trim(), title: dash[2]!.replace(/^["']|["']$/g, '').trim() };
  return {
    artist: channel
      .replace(/\s*-\s*Topic$/i, '')
      .replace(/VEVO$/i, '')
      .trim(),
    title: clean,
  };
}

/**
 * YouTube audio is not downloaded (YouTube's terms forbid it and it blocks server IPs). oEmbed
 * gives the video's title and channel, and the worker downloads the same song from SoundCloud.
 */
export class YouTubeResolver implements LinkResolver {
  readonly name = 'YouTube';
  constructor(private readonly fetcher: FetchLike = fetch) {}

  canResolve(url: URL) {
    return hostIn(url, ['youtube.com', 'youtu.be']);
  }

  async resolve(url: URL): Promise<ResolvedAudio> {
    const id = url.hostname.endsWith('youtu.be')
      ? url.pathname.slice(1).split('/')[0]
      : (url.searchParams.get('v') ?? url.pathname.match(/^\/(?:shorts|live|embed)\/([^/]+)/)?.[1]);
    if (!id)
      throw new ResolveError(
        'Paste a link to a single YouTube video, not a playlist.',
        'unsupported',
      );
    const watch = `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
    let res: Response;
    try {
      res = await this.fetcher(
        `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(watch)}`,
        { signal: AbortSignal.timeout(8000) },
      );
    } catch {
      throw new ResolveError('Could not reach YouTube', 'unreachable');
    }
    if (!res.ok)
      throw new ResolveError('That YouTube video is private or does not exist', 'unreachable');
    const o = (await res.json()) as {
      title?: string;
      author_name?: string;
      thumbnail_url?: string;
    };
    const { artist, title } = parseVideoTitle(o.title ?? '', o.author_name ?? '');
    if (!title)
      throw new ResolveError('Could not read the song from that YouTube link', 'not_audio');
    return {
      url: `scsearch5:${searchQuery(artist, title)}`,
      contentType: 'audio/mpeg',
      size: null,
      filename: title,
      title,
      artist,
      artworkUrl: o.thumbnail_url,
    };
  }
}

// Platform resolvers are checked first so their links get a clear "not supported" error
// instead of being treated as (non-audio) direct URLs.
export function defaultResolvers(maxBytes: number, fetcher?: FetchLike): LinkResolver[] {
  return [
    new YouTubeResolver(fetcher),
    new SoundCloudResolver(fetcher),
    new SpotifyResolver(fetcher),
    AppleMusicResolver(),
    new DirectAudioResolver(maxBytes, fetcher),
  ];
}

export async function resolveLink(raw: string, resolvers: LinkResolver[]): Promise<ResolvedAudio> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ResolveError('That is not a valid URL', 'unsupported');
  }
  const resolver = resolvers.find((r) => r.canResolve(url));
  if (!resolver) throw new ResolveError('Unsupported link', 'unsupported');
  return resolver.resolve(url);
}
