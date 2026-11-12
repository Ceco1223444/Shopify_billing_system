/** UI languages. Bulgarian is the default; English is the full second language. */
export const APP_LOCALES = ['bg', 'en'] as const;
export type AppLocale = (typeof APP_LOCALES)[number];
export const DEFAULT_LOCALE: AppLocale = 'bg';

/** BCP 47 tags used with Intl for each UI language. */
export const INTL_LOCALE: Record<AppLocale, string> = {
  bg: 'bg-BG',
  en: 'en-GB',
};

/** All times are stored as timestamptz and shown in Bulgarian time. */
export const APP_TIME_ZONE = 'Europe/Sofia';

export function isAppLocale(value: unknown): value is AppLocale {
  return typeof value === 'string' && (APP_LOCALES as readonly string[]).includes(value);
}
