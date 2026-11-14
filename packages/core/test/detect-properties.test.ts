/**
 * T5-09 / T5-10, property style: thousands of random mixes of courier words, office words, home
 * words, streets, flats, other couriers, towns and geocoder answers. Seeded, so a failure repeats.
 */
import { describe, expect, it } from 'vitest';
import { detectDelivery, type GeoPoint } from '../src/detect/decide.ts';
import { analyze, type DetectionInput } from '../src/detect/signals.ts';
import { mergeDictionary } from '../src/detect/dictionary.ts';
import { fakeDeps, POINTS } from './detect-fixtures.ts';

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FRAGMENTS = [
  '',
  'Еконт',
  'Ekont',
  'Спиди',
  'spidi',
  'Speedy',
  'офис',
  'ofis',
  'автомат',
  'еконтомат',
  'до адрес',
  'личен адрес',
  'home address',
  'ул. Примерна 12',
  'бул. Демо 7',
  'ж.к. Тракия бл. 148',
  'вх. Б',
  'ет. 3, ап. 12',
  'Капана',
  'Тракия',
  'Младост 1',
  'Буров',
  'Кауфланд',
  '4064',
  '№ 9145',
  'BOX NOW',
  'Sameday',
  'моля обадете се',
  'след 17 ч.',
  'Тест',
  '123',
  'apteka',
  'или',
];
const TOWNS = ['Пловдив', 'София', 'Русе', 'Plovdiv', 'Варна', 'Айтос', '', 'гр. Русе'];

function randomInput(rand: () => number): DetectionInput {
  const pick = <T>(list: T[]) => list[Math.floor(rand() * list.length)]!;
  const text = (n: number) => Array.from({ length: n }, () => pick(FRAGMENTS)).join(' ');
  return {
    address1: text(1 + Math.floor(rand() * 3)),
    address2: rand() < 0.3 ? text(1) : '',
    company: rand() < 0.1 ? text(1) : '',
    notes: rand() < 0.3 ? [text(2)] : [],
    city: pick(TOWNS),
    zip: rand() < 0.3 ? pick(['4000', '1000', '7000', '']) : '',
    shippingMethod: pick(['Free shipping', 'Standard', null]),
  };
}

function randomGeo(rand: () => number): GeoPoint | null | 'busy' {
  const r = rand();
  if (r < 0.15) return null;
  if (r < 0.2) return 'busy';
  const p = POINTS[Math.floor(rand() * POINTS.length)]!;
  return {
    lat: p.lat! + (rand() - 0.5) * 0.04,
    lng: p.lng! + (rand() - 0.5) * 0.04,
    precision: (['street', 'block', 'quarter', 'city'] as const)[Math.floor(rand() * 4)]!,
  };
}

describe('detection properties', () => {
  it('T5-09 every decision has a reason; T5-10 a certain decision is fully resolved', async () => {
    const rand = mulberry32(20261114);
    const dictionary = mergeDictionary(null);
    let certain = 0;
    for (let i = 0; i < 2000; i++) {
      const input = randomInput(rand);
      const geo = randomGeo(rand);
      const deps = { ...fakeDeps(), geocode: async () => geo };
      const out = await detectDelivery(input, deps);
      if (out.kind === 'busy') continue;
      const d = out.decision;
      const where = JSON.stringify(input);
      expect(d.reasons.length, where).toBeGreaterThanOrEqual(1);
      for (const r of [...d.reasons, ...d.hints]) {
        expect(r.bg.trim(), where).not.toBe('');
        expect(r.en.trim(), where).not.toBe('');
      }
      // Offices only (owner, 14 Nov 2026): no locker or mobile office is ever decided, suggested
      // or offered, whatever the customer wrote.
      for (const p of [d.point, d.suggestion, ...d.alternatives]) {
        if (p) expect(p.type, where).toBe('office');
      }
      expect(d.deliveryType, where).not.toBe('locker');
      if (d.certainty === 'certain') {
        certain++;
        if (d.deliveryType === 'address') {
          // B: "до адрес" + street; E (owner's middle way): nothing asked, no office near, and a
          // complete street address found on the map beyond the town.
          expect(['B', 'E'], where).toContain(d.rule);
          expect(analyze(input, dictionary).streetAddress, where).toBe(true);
          if (d.rule === 'E') {
            expect(d.geo?.precision, where).not.toBe('city');
            expect(analyze(input, dictionary).pointWords, where).toEqual([]);
          }
        } else {
          expect(d.rule, where).toBe('A');
          expect(d.point, where).not.toBeNull();
          expect(d.deliveryType, where).toBe(d.point!.type === 'locker' ? 'locker' : 'office');
          expect(d.carrier, where).toBe(d.point!.carrier);
        }
      } else {
        expect(d.point, where).toBeNull();
      }
      if (d.certainty === 'error') expect(d.rule, where).toBe('F');
    }
    expect(certain).toBeGreaterThan(20); // the generator does reach the certain rules
  });
});
