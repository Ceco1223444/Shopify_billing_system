/**
 * Econt mapping against a saved getOffices answer (production, 13 Nov 2026: an office, an
 * Еконтомат, a mobile station, an "Еконт Точка" and another office).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  econtCalculateRequest,
  econtErrorMessage,
  econtTime,
  econtWorkingHours,
  mapEcontOffice,
  mapEcontOffices,
  parseEcontQuote,
  pointProblems,
  type EcontOffice,
} from '../src/couriers/index.ts';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/econt-offices.json', import.meta.url), 'utf8'),
) as { offices: EcontOffice[] };

describe('mapEcontOffices', () => {
  const { points, skipped, withoutCoordinates } = mapEcontOffices(fixture);

  it('maps every office of the saved answer', () => {
    expect(points).toHaveLength(fixture.offices.length);
    expect(skipped).toBe(0);
    expect(withoutCoordinates).toBe(0);
    for (const p of points) expect(pointProblems(p), p.externalId).toEqual([]);
  });

  it('office: code, names, city, postcode, address, coordinates, hours', () => {
    const plovdiv = points.find((p) => p.externalId === '4044')!;
    expect(plovdiv).toMatchObject({
      carrier: 'econt',
      code: '4044',
      type: 'office',
      nameBg: 'Пловдив',
      nameEn: 'Plovdiv',
      city: 'Пловдив',
      postcode: '4000',
      addressText: 'Пловдив Район Южен ул. Кукленско Шосе №11',
      coordConfidence: 3,
      coordSource: 'courier',
      phone: '+359 32 673 388',
    });
    expect(plovdiv.lat).toBeCloseTo(42.1221, 3);
    expect(plovdiv.lng).toBeCloseTo(24.7595, 3);
    expect(plovdiv.workingHours).toEqual({
      weekdays: { from: '09:00', to: '19:30' },
      saturday: { from: '09:00', to: '15:00' },
    });
    expect(plovdiv.raw).toMatchObject({
      id: 970,
      city_id: 33,
      street: 'ул. Кукленско Шосе',
      num: '11',
    });
  });

  it('isAPS → locker, isMPS → mobile', () => {
    expect(points.find((p) => p.externalId === '4068')?.type).toBe('locker');
    expect(points.find((p) => p.externalId === '2951@2932')?.type).toBe('mobile');
  });

  it('drops duplicates, non-Bulgarian offices and offices without a code', () => {
    const office = fixture.offices[0]!;
    const greek = {
      ...office,
      code: '9999',
      address: { ...office.address, city: { ...office.address?.city, country: { code3: 'GRC' } } },
    };
    const mapped = mapEcontOffices({ offices: [office, office, greek, { ...office, code: '' }] });
    expect(mapped.points).toHaveLength(1);
    expect(mapped.skipped).toBe(3);
  });

  it('0,0 coordinates (demo data) become "no coordinates"', () => {
    const office = fixture.offices[0]!;
    const p = mapEcontOffice({
      ...office,
      address: { ...office.address, location: { latitude: 0, longitude: 0, confidence: 3 } },
    })!;
    expect(p).toMatchObject({ lat: null, lng: null, coordConfidence: null, coordSource: null });
  });

  it('throws on an answer that is not an office list', () => {
    expect(() => mapEcontOffices({ type: 'ExInvalidParam', message: 'x' })).toThrow();
  });
});

describe('Econt business hours', () => {
  it('epoch ms → Sofia time, in winter and in summer', () => {
    expect(econtTime(Date.UTC(2026, 10, 13, 7, 0))).toBe('09:00'); // EET, UTC+2
    expect(econtTime(Date.UTC(2026, 6, 13, 6, 30))).toBe('09:30'); // EEST, UTC+3
  });

  it('"HH:MM(:SS)" strings as the spec says, and nothing for empty values', () => {
    expect(econtTime('9:30:00')).toBe('09:30');
    expect(econtTime('18:00')).toBe('18:00');
    expect(econtTime(null)).toBeNull();
    expect(econtTime('')).toBeNull();
  });

  it('weekdays from the normal hours, Saturday from the half-day hours, Sunday unknown', () => {
    const hours = econtWorkingHours({
      normalBusinessHoursFrom: '08:30',
      normalBusinessHoursTo: '18:00',
      halfDayBusinessHoursFrom: null,
      halfDayBusinessHoursTo: null,
    });
    expect(hours).toEqual({ weekdays: { from: '08:30', to: '18:00' }, saturday: null });
    expect(econtWorkingHours({})).toBeNull();
  });
});

describe('Econt price calculation (read-only)', () => {
  it('builds a "calculate" request for an office and for an address', () => {
    const toOffice = econtCalculateRequest({
      senderOfficeCode: '4044',
      destination: { kind: 'office', officeCode: '1127' },
      weightG: 1500,
      codCents: 5000,
      declaredValueCents: 0,
      payer: 'SENDER',
      packCount: 1,
    });
    expect(toOffice.mode).toBe('calculate');
    expect(toOffice.label).toMatchObject({
      senderOfficeCode: '4044',
      receiverOfficeCode: '1127',
      weight: 1.5,
      shipmentType: 'pack',
      paymentSenderMethod: 'cash',
      services: { cdAmount: 50, cdType: 'get', cdCurrency: 'EUR' },
    });

    const toAddress = econtCalculateRequest({
      senderOfficeCode: '4044',
      destination: {
        kind: 'address',
        city: 'Русе',
        postcode: '7000',
        street: 'Александровска',
        number: '5',
        quarter: null,
        other: null,
      },
      weightG: 800,
      codCents: 0,
      declaredValueCents: 2000,
      payer: 'RECIPIENT',
      packCount: 1,
    });
    expect(toAddress.label.receiverOfficeCode).toBeUndefined();
    expect(toAddress.label.receiverAddress).toMatchObject({
      city: { name: 'Русе', postCode: '7000' },
      street: 'Александровска',
      num: '5',
    });
    expect(toAddress.label.services).toEqual({
      declaredValueAmount: 20,
      declaredValueCurrency: 'EUR',
    });
    expect(toAddress.label.paymentReceiverMethod).toBe('cash');
  });

  it('reads the price (the demo answer of 13 Nov 2026)', () => {
    const quote = parseEcontQuote({
      label: {
        totalPrice: 4.54,
        currency: 'EUR',
        shipmentNumber: null,
        services: [
          { type: 'C', description: 'Куриерска услуга', price: 3.78, currency: 'EUR' },
          { type: 'CD', description: 'Такса наложен платеж', price: 0.76, currency: 'EUR' },
        ],
      },
    });
    expect(quote).toEqual({
      totalCents: 454,
      currency: 'EUR',
      lines: [
        { label: 'Куриерска услуга', cents: 378 },
        { label: 'Такса наложен платеж', cents: 76 },
      ],
      approximate: false,
      source: 'econt_api',
    });
    expect(() => parseEcontQuote({ label: {} })).toThrow();
  });

  it('reads Econt error bodies', () => {
    expect(
      econtErrorMessage({
        type: 'ExInvalidParam',
        message: 'Invalid office',
        innerErrors: [{ message: 'receiverOfficeCode' }],
      }),
    ).toBe('Invalid office | receiverOfficeCode');
    expect(econtErrorMessage('nope')).toBeNull();
  });
});
