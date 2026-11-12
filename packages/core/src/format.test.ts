import { describe, expect, it } from 'vitest';
import { formatDate, formatDateTime, formatMoneyCents } from './format';

/** ICU uses no-break spaces; compare with plain spaces so tests survive ICU updates. */
const plain = (s: string) => s.replace(/\s/g, ' ');

describe('formatMoneyCents', () => {
  it('formats integer cents in bg-BG euro format', () => {
    expect(plain(formatMoneyCents(1234))).toBe('12,34 €');
    expect(plain(formatMoneyCents(0))).toBe('0,00 €');
    expect(plain(formatMoneyCents(123450))).toBe('1234,50 €');
    expect(plain(formatMoneyCents(1234560))).toBe('12 345,60 €');
    expect(plain(formatMoneyCents(-310))).toBe('-3,10 €');
  });

  it('rejects non-integer cents', () => {
    expect(() => formatMoneyCents(12.5)).toThrow(RangeError);
    expect(() => formatMoneyCents(Number.NaN)).toThrow(RangeError);
  });
});

describe('formatDateTime / formatDate', () => {
  it('shows times in Europe/Sofia (UTC+2 in winter)', () => {
    expect(plain(formatDateTime('2026-11-12T12:05:00Z'))).toBe('12.11.2026 г., 14:05');
  });

  it('shows times in Europe/Sofia (UTC+3 in summer) and crosses midnight', () => {
    expect(plain(formatDateTime('2026-07-01T21:30:00Z'))).toBe('02.07.2026 г., 00:30');
    expect(plain(formatDate('2026-07-01T21:30:00Z'))).toBe('02.07.2026 г.');
  });

  it('uses the English date order for the English UI', () => {
    expect(plain(formatDateTime('2026-11-12T12:05:00Z', 'en'))).toBe('12/11/2026, 14:05');
  });

  it('rejects invalid dates', () => {
    expect(() => formatDate('not a date')).toThrow(RangeError);
  });
});
