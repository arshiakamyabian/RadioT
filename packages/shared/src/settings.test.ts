import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, STATION_NAME, handleSchema, stationSettingsSchema } from './index.js';

describe('shared', () => {
  it('exposes the station name', () => {
    expect(STATION_NAME).toBe('RadioT');
  });

  it('defaults settings to a 10s lock lead', () => {
    expect(DEFAULT_SETTINGS.lockLeadSeconds).toBe(10);
  });

  it('rejects out-of-range settings', () => {
    expect(stationSettingsSchema.safeParse({ lockLeadSeconds: 1 }).success).toBe(false);
  });

  it('validates handles', () => {
    expect(handleSchema.safeParse('dj_ayse').success).toBe(true);
    expect(handleSchema.safeParse('DJ Ayse').success).toBe(false);
  });
});

describe('moderation', async () => {
  const { maskBlockedWords } = await import('./moderation.js');
  it('masks whole blocked words, case-insensitively, keeping length', () => {
    expect(maskBlockedWords('what the FUCK')).toEqual({ text: 'what the ••••', masked: true });
  });
  it('does not mask substrings of innocent words', () => {
    expect(maskBlockedWords('shitake mushrooms').masked).toBe(false);
    expect(maskBlockedWords('Scunthorpe').masked).toBe(false);
  });
  it('handles Turkish words and admin extras', () => {
    expect(maskBlockedWords('siktir git').text).toBe('•••••• git');
    expect(maskBlockedWords('spam link', ['spam']).text).toBe('•••• link');
  });
});
