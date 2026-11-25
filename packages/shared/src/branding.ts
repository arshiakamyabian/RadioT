export const STATION_NAME = 'RadioT';
export const STATION_TAGLINE = 'Community radio. You pick what plays next.';
export const LOCALES = ['en', 'tr'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en';
