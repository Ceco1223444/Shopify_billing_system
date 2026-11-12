import { describe, expect, it } from 'vitest';
import { SHIPMENT_STATUSES } from './domain';
import { APP_LOCALES, DEFAULT_LOCALE, isAppLocale } from './locale';
import { SETTINGS_DEFAULTS } from './settings';

describe('domain vocabulary', () => {
  it('keeps the shipment pipeline in the order the brief defines', () => {
    expect(SHIPMENT_STATUSES[0]).toBe('imported');
    expect(SHIPMENT_STATUSES.indexOf('ready')).toBeLessThan(
      SHIPMENT_STATUSES.indexOf('waiting_manual_waybill'),
    );
    expect(SHIPMENT_STATUSES.indexOf('waiting_manual_waybill')).toBeLessThan(
      SHIPMENT_STATUSES.indexOf('waybill_created'),
    );
    expect(new Set(SHIPMENT_STATUSES).size).toBe(SHIPMENT_STATUSES.length);
  });
});

describe('locale', () => {
  it('defaults to Bulgarian and knows both UI languages', () => {
    expect(DEFAULT_LOCALE).toBe('bg');
    expect(APP_LOCALES).toEqual(['bg', 'en']);
    expect(isAppLocale('en')).toBe(true);
    expect(isAppLocale('de')).toBe(false);
    expect(isAppLocale(undefined)).toBe(false);
  });
});

describe('settings defaults', () => {
  it('starts Econt in API mode against the demo environment and Speedy in manual mode', () => {
    expect(SETTINGS_DEFAULTS.courier_modes).toEqual({ econt: 'api', speedy: 'manual' });
    expect(SETTINGS_DEFAULTS.econt_env).toBe('demo');
    expect(SETTINGS_DEFAULTS.courier_fee_payer).toBe('SENDER');
  });

  it('uses integer grams and cents', () => {
    for (const key of [
      'default_parcel_weight_g',
      'packaging_weight_g',
      'packaging_cost_cents',
    ] as const) {
      expect(Number.isInteger(SETTINGS_DEFAULTS[key])).toBe(true);
    }
  });
});
