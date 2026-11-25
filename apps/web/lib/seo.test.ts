import { describe, expect, it } from 'vitest';
import {
  alternates,
  homeJsonLd,
  isoDuration,
  musicRecordingJsonLd,
  radioStationJsonLd,
} from './seo';

const base = 'https://radiot.app';

describe('seo helpers', () => {
  it('builds canonical and hreflang alternates for every locale', () => {
    const a = alternates('tr', '/sign-in', base);
    expect(a?.canonical).toBe('https://radiot.app/tr/sign-in');
    expect(a?.languages).toEqual({
      en: 'https://radiot.app/en/sign-in',
      tr: 'https://radiot.app/tr/sign-in',
      'x-default': 'https://radiot.app/en/sign-in',
    });
  });

  it('describes the station as a RadioStation', () => {
    const ld = radioStationJsonLd('en', 'desc', base);
    expect(ld['@type']).toBe('RadioStation');
    expect(ld.url).toBe('https://radiot.app/en');
  });

  it('home graph includes the broadcast and the current recording', () => {
    const ld = homeJsonLd(
      'en',
      'd',
      {
        kind: 'request',
        trackId: 't',
        roundId: null,
        title: 'Song',
        artist: 'Band',
        artworkUrl: null,
        durationMs: 125_000,
        startedAt: new Date().toISOString(),
        requester: null,
        media: null,
      },
      base,
    );
    expect(ld['@graph'].map((g) => g['@type'])).toEqual([
      'RadioStation',
      'BroadcastService',
      'MusicRecording',
    ]);
  });

  it('formats ISO 8601 durations', () => {
    expect(isoDuration(125_000)).toBe('PT2M5S');
  });

  it('builds MusicRecording for song pages', () => {
    const ld = musicRecordingJsonLd(
      'tr',
      {
        id: 'r1',
        status: 'played',
        title: 'X',
        artist: '',
        artworkUrl: null,
        durationMs: 60_000,
        rejectReason: null,
        createdAt: '2026-01-01T00:00:00Z',
        playedAt: null,
        requester: { id: 'u', name: 'U', handle: null, avatarUrl: null },
      },
      base,
    );
    expect(ld.url).toBe('https://radiot.app/tr/history/r1');
    expect(ld.byArtist).toBeUndefined();
  });
});
