import { describe, expect, it } from 'vitest';
import { BACKOFF_MS, backoffDelay, isMobile, prefersNativeHls } from './stream-player';

const audio = (hls: boolean) =>
  ({ canPlayType: () => (hls ? 'maybe' : '') }) as unknown as HTMLAudioElement;

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const IPHONE_CHROME =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0 Mobile/15E148 Safari/604.1';
const MAC_SAFARI =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
const ANDROID =
  'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';
const DESKTOP_CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

describe('transport choice', () => {
  it('plays HLS natively on iPhone and Safari', () => {
    expect(prefersNativeHls(audio(true), IPHONE)).toBe(true);
    expect(prefersNativeHls(audio(true), MAC_SAFARI)).toBe(true);
  });

  it('uses hls.js on Android and desktop Chrome even if they claim native support', () => {
    expect(prefersNativeHls(audio(true), ANDROID)).toBe(false);
    expect(prefersNativeHls(audio(true), DESKTOP_CHROME)).toBe(false);
  });

  it('never picks native without native support', () => {
    expect(prefersNativeHls(audio(false), IPHONE)).toBe(false);
  });

  it('still counts iOS Chrome (WebKit underneath) as Apple', () => {
    expect(prefersNativeHls(audio(true), IPHONE_CHROME)).toBe(true);
  });
});

describe('phones', () => {
  it('detects phones, not desktops', () => {
    expect(isMobile(IPHONE)).toBe(true);
    expect(isMobile(ANDROID)).toBe(true);
    expect(isMobile(DESKTOP_CHROME)).toBe(false);
  });
});

describe('reconnect backoff', () => {
  it('grows, then holds at the cap', () => {
    const delays = Array.from({ length: 10 }, (_, i) => backoffDelay(i, 0.5));
    for (let i = 1; i < delays.length; i++)
      expect(delays[i]!).toBeGreaterThanOrEqual(delays[i - 1]!);
    expect(delays.at(-1)).toBe(BACKOFF_MS.at(-1));
  });

  it('is jittered by about ±15 % so listeners do not reconnect in lockstep', () => {
    expect(backoffDelay(2, 0)).toBe(Math.round(BACKOFF_MS[2]! * 0.85));
    expect(backoffDelay(2, 1)).toBe(Math.round(BACKOFF_MS[2]! * 1.15));
  });
});
