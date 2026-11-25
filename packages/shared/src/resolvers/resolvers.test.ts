import { describe, expect, it } from 'vitest';
import {
  ResolveError,
  defaultResolvers,
  parseVideoTitle,
  resolveLink,
  searchQuery,
  viaYtdlp,
} from './index.js';

const fakeFetch =
  (headers: Record<string, string>, status = 200, url?: string) =>
  async (input: string) =>
    ({ ok: status < 400, status, url: url ?? input, headers: new Headers(headers) }) as Response;

describe('link resolvers', () => {
  it('accepts a direct audio URL', async () => {
    const r = defaultResolvers(
      1e6,
      fakeFetch({ 'content-type': 'audio/mpeg', 'content-length': '500' }),
    );
    const res = await resolveLink('https://cdn.example.com/a%20song.mp3', r);
    expect(res).toMatchObject({ contentType: 'audio/mpeg', size: 500, filename: 'a song.mp3' });
  });

  it('refuses Apple Music with an unimplemented error', async () => {
    const r = defaultResolvers(1e6, fakeFetch({ 'content-type': 'text/html' }));
    await expect(resolveLink('https://music.apple.com/tr/album/x', r)).rejects.toMatchObject({
      code: 'unimplemented',
    });
  });

  it('turns a YouTube video into a SoundCloud search for the same song', async () => {
    const asked: string[] = [];
    const fetcher = async (u: string) => {
      asked.push(u);
      return new Response(
        JSON.stringify({
          title: 'Rick Astley - Never Gonna Give You Up (Official Music Video)',
          author_name: 'Rick Astley',
          thumbnail_url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
        }),
      );
    };
    for (const link of [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL1',
      'https://youtu.be/dQw4w9WgXcQ?si=x',
      'https://music.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://m.youtube.com/shorts/dQw4w9WgXcQ',
    ]) {
      const res = await resolveLink(link, defaultResolvers(1e6, fetcher));
      expect(res).toMatchObject({
        url: 'scsearch5:Rick Astley Never Gonna Give You Up',
        title: 'Never Gonna Give You Up',
        artist: 'Rick Astley',
      });
      expect(viaYtdlp(res.url)).toBe(true);
    }
    expect(asked.every((u) => u.includes(encodeURIComponent('watch?v=dQw4w9WgXcQ')))).toBe(true);
    await expect(
      resolveLink('https://www.youtube.com/playlist?list=PL1', defaultResolvers(1e6, fetcher)),
    ).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('reads the artist from the channel when the video title has none', () => {
    expect(parseVideoTitle('Bad Guy [Official Audio]', 'Billie Eilish - Topic')).toEqual({
      artist: 'Billie Eilish',
      title: 'Bad Guy',
    });
    expect(parseVideoTitle('Halo (Lyrics)', 'BeyonceVEVO')).toEqual({
      artist: 'Beyonce',
      title: 'Halo',
    });
  });

  it('rejects HTML pages and oversize files', async () => {
    await expect(
      resolveLink(
        'https://example.com/page',
        defaultResolvers(1e6, fakeFetch({ 'content-type': 'text/html' })),
      ),
    ).rejects.toBeInstanceOf(ResolveError);
    await expect(
      resolveLink(
        'https://example.com/big.mp3',
        defaultResolvers(10, fakeFetch({ 'content-type': 'audio/mpeg', 'content-length': '11' })),
      ),
    ).rejects.toMatchObject({ code: 'too_large' });
  });

  it('accepts octet-stream when the path has an audio extension', async () => {
    const r = defaultResolvers(1e6, fakeFetch({ 'content-type': 'application/octet-stream' }));
    await expect(resolveLink('https://example.com/x.flac', r)).resolves.toMatchObject({
      filename: 'x.flac',
    });
  });

  it('takes a SoundCloud track with its title and artist from oEmbed', async () => {
    const seen: string[] = [];
    const fetcher = async (u: string) => {
      seen.push(u);
      return new Response(
        JSON.stringify({
          title: 'Night Drive by DJ Kay',
          author_name: 'DJ Kay',
          thumbnail_url: 'https://i1.sndcdn.com/a.jpg',
        }),
        { status: 200 },
      );
    };
    const res = await resolveLink(
      'https://soundcloud.com/djkay/night-drive?utm_source=x',
      defaultResolvers(1e6, fetcher),
    );
    expect(res).toMatchObject({
      url: 'https://soundcloud.com/djkay/night-drive',
      title: 'Night Drive',
      artist: 'DJ Kay',
    });
    expect(seen[0]).toContain('soundcloud.com/oembed');
    expect(viaYtdlp(res.url)).toBe(true);
    await expect(
      resolveLink('https://soundcloud.com/djkay/sets/mix', defaultResolvers(1e6, fetcher)),
    ).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('turns a Spotify song into a SoundCloud search for the same song', async () => {
    const html =
      '<meta property="og:title" content="Get Lucky (feat. Pharrell Williams)"/>' +
      '<meta property="og:description" content="Daft Punk, Pharrell Williams · Random Access Memories · Song · 2013"/>' +
      '<meta property="og:image" content="https://i.scdn.co/image/x"/>';
    const fetcher = async (u: string) => {
      const r = new Response(html, { status: 200 });
      Object.defineProperty(r, 'url', { value: u });
      return r;
    };
    const res = await resolveLink(
      'https://open.spotify.com/track/abc?si=1',
      defaultResolvers(1e6, fetcher),
    );
    expect(res).toMatchObject({
      url: 'scsearch5:Daft Punk Get Lucky',
      title: 'Get Lucky (feat. Pharrell Williams)',
      artist: 'Daft Punk, Pharrell Williams',
      artworkUrl: 'https://i.scdn.co/image/x',
    });
    expect(viaYtdlp(res.url)).toBe(true);
    await expect(
      resolveLink('https://open.spotify.com/album/abc', defaultResolvers(1e6, fetcher)),
    ).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('searches for the main artist and the bare song name', () => {
    expect(searchQuery('Queen', 'Bohemian Rhapsody - Remastered 2011')).toBe(
      'Queen Bohemian Rhapsody',
    );
    expect(searchQuery('A, B', 'Song [feat. C] (Live)')).toBe('A Song (Live)');
    expect(searchQuery('Luis Fonsi', 'Despacito ft. Daddy Yankee')).toBe('Luis Fonsi Despacito');
  });

  it('leaves plain links to the direct fetcher', () => {
    expect(viaYtdlp('https://cdn.example.com/a.mp3')).toBe(false);
  });
});
