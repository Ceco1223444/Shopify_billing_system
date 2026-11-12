import { APP_TIME_ZONE, INTL_LOCALE, type AppLocale } from './locale';

/**
 * Money is stored as integer euro cents and always shown in Bulgarian format,
 * e.g. 1234 -> "12,34 €" (the brief fixes bg-BG for money in both UI languages).
 */
const moneyFormatters = new Map<string, Intl.NumberFormat>();

export function formatMoneyCents(cents: number, currency = 'EUR'): string {
  if (!Number.isSafeInteger(cents)) {
    throw new RangeError(`Money must be an integer number of cents, got ${String(cents)}`);
  }
  let formatter = moneyFormatters.get(currency);
  if (!formatter) {
    formatter = new Intl.NumberFormat('bg-BG', { style: 'currency', currency });
    moneyFormatters.set(currency, formatter);
  }
  return formatter.format(cents / 100);
}

type DateInput = Date | string | number;

function toDate(value: DateInput): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new RangeError(`Invalid date: ${String(value)}`);
  }
  return date;
}

/** Date + time in Bulgarian time (Europe/Sofia), e.g. "12.11.2026 г., 14:05". */
export function formatDateTime(value: DateInput, locale: AppLocale = 'bg'): string {
  return new Intl.DateTimeFormat(INTL_LOCALE[locale], {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: APP_TIME_ZONE,
  }).format(toDate(value));
}

/** Date only in Bulgarian time (Europe/Sofia), e.g. "12.11.2026 г.". */
export function formatDate(value: DateInput, locale: AppLocale = 'bg'): string {
  return new Intl.DateTimeFormat(INTL_LOCALE[locale], {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: APP_TIME_ZONE,
  }).format(toDate(value));
}
