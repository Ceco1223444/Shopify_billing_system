import { describe, expect, it } from 'vitest';
import {
  combinedReasons,
  compareShipments,
  displayPhone,
  isOpenStatus,
  telHref,
  visibleToPacker,
} from './shipments';

describe('shipment helpers', () => {
  it('open = before waybill_created', () => {
    expect(
      ['imported', 'needs_check', 'ready', 'waiting_manual_waybill'].map(isOpenStatus),
    ).toEqual([true, true, true, true]);
    expect(
      ['waybill_created', 'printed', 'handed_over', 'cancelled', null].map(isOpenStatus),
    ).toEqual([false, false, false, false, false]);
  });

  it('packers do not see shipments that need checking (P3-15)', () => {
    expect(visibleToPacker('needs_check')).toBe(false);
    expect(visibleToPacker('imported')).toBe(false);
    expect(visibleToPacker('ready')).toBe(true);
    expect(visibleToPacker('handed_over')).toBe(true);
  });

  it.each([
    ['0888000102', 'tel:+359888000102', '+359 888 000 102'],
    ['029876543', 'tel:+35929876543', '+359 29 876 543'],
    ['+390612345678', 'tel:+390612345678', '+390612345678'],
    ['', null, ''],
    [null, null, ''],
  ])('telHref(%s)', (norm, href, shown) => {
    expect(telHref(norm)).toBe(href);
    expect(displayPhone(norm)).toBe(shown);
  });

  it('keeps the combined reasons in a fixed order and drops unknown values', () => {
    expect(combinedReasons(['manual', 'email', 'x'])).toEqual(['email', 'manual']);
    expect(combinedReasons(null)).toEqual([]);
  });

  it('lists shipments that need checking first, then the oldest', () => {
    const rows = [
      { status: 'ready', first_order_at: '2026-11-02T10:00:00Z', reference: '#3' },
      { status: 'needs_check', first_order_at: '2026-11-05T10:00:00Z', reference: '#2' },
      { status: 'ready', first_order_at: '2026-11-01T10:00:00Z', reference: '#1' },
      { status: 'handed_over', first_order_at: '2026-10-01T10:00:00Z', reference: '#0' },
    ];
    expect(rows.sort(compareShipments).map((r) => r.reference)).toEqual(['#2', '#1', '#3', '#0']);
  });
});
