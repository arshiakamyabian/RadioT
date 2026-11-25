import { describe, expect, it } from 'vitest';
import { parseFfmpegInfo } from './tools.js';

const MP3 = `Input #0, mp3, from 't.mp3':
  Metadata:
    title           : Test Song
    artist          : The Band
    encoder         : Lavf63.1.102
  Duration: 00:03:12.50, start: 0.025057, bitrate: 128 kb/s
  Stream #0:0: Audio: mp3 (mp3float), 44100 Hz, mono, fltp, 128 kb/s, start 0.025057
At least one output file must be specified`;

const M4A = `[in#0 @ 0x8df020000] stream 0, timescale not set
Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 't.m4a':
  Metadata:
    major_brand     : M4A 
    compatible_brands: M4A isomiso2
    title           : Cover Song
  Duration: 00:00:03.00, start: 0.000000, bitrate: 74 kb/s
  Stream #0:0[0x1](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, mono, fltp, 69 kb/s (default)
    Metadata:
      handler_name    : SoundHandler
  Stream #0:1[0x0]: Video: mjpeg (Baseline), yuvj420p(pc, bt470bg/unknown/unknown), 64x64 [SAR 1:1 DAR 1:1], 90k tbr, 90k tbn (attached pic)
At least one output file must be specified`;

describe('parseFfmpegInfo', () => {
  it('reads codec, duration and tags like ffprobe would', () => {
    const p = parseFfmpegInfo(MP3);
    expect(p.format.duration).toBeCloseTo(192.5);
    expect(p.format.tags).toMatchObject({ title: 'Test Song', artist: 'The Band' });
    expect(p.streams).toEqual([{ codec_type: 'audio', codec_name: 'mp3' }]);
  });
  it('handles stream ids, language suffixes and cover art', () => {
    const p = parseFfmpegInfo(M4A);
    expect(p.format.tags?.title).toBe('Cover Song');
    expect(p.streams.map((s) => [s.codec_type, s.codec_name])).toEqual([
      ['audio', 'aac'],
      ['video', 'mjpeg'],
    ]);
    expect(p.streams[1]?.disposition).toEqual({ attached_pic: 1 });
  });
  it('rejects files ffmpeg cannot open', () => {
    expect(() => parseFfmpegInfo('t.txt: Invalid data found when processing input')).toThrow();
  });
});
