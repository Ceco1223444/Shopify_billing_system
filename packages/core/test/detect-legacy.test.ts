/**
 * Phase 5 acceptance: the detection on the legacy sample shipments (#2001–#2011, invented people
 * and addresses), with the real office list of the fixtures and no geocoder answer (the sample
 * streets do not exist). The table in docs/STATUS.md is this output.
 *
 * Shipments as the import builds them: #2002 + #2007 and #2006 + #2011 travel together (same
 * customer, same address); #2010 is cancelled and is not detected. Notes of all orders count.
 */
import { describe, expect, it } from 'vitest';
import { detectDelivery } from '../src/detect/decide.ts';
import { SAMPLE_ORDERS, type SampleOrder } from '../src/import/samples.ts';
import { fakeDeps } from './detect-fixtures.ts';

const O = SAMPLE_ORDERS;
const SHIPMENTS: SampleOrder[][] = [
  [O.o2001],
  [O.o2002, O.o2007],
  [O.o2003],
  [O.o2004],
  [O.o2005],
  [O.o2006, O.o2011],
  [O.o2008],
  [O.o2009],
];

/** Town centres: what the hosted geocoder falls back to when the street is not found. */
const TOWN_ONLY = {
  'ул. Примерна 12': { lat: 42.6977, lng: 23.3219, precision: 'city' as const }, // София
  'ул. Опитна 21': { lat: 43.8356, lng: 25.9657, precision: 'city' as const }, // Русе
};

async function decide(orders: SampleOrder[], deps = fakeDeps()) {
  const first = orders[0]!;
  const out = await detectDelivery(
    {
      address1: first.a1,
      address2: first.a2 ?? null,
      company: null,
      notes: orders.flatMap((o) => (o.notes ? [o.notes] : [])),
      city: first.city,
      zip: first.zip,
      country: first.country ?? 'BG',
      shippingMethod: 'Standard',
    },
    deps,
  );
  if (out.kind !== 'decided') throw new Error('busy');
  const d = out.decision;
  return [
    orders.map((o) => o.name).join(' + '),
    d.rule,
    d.certainty,
    d.carrier ?? '—',
    d.deliveryType ?? '—',
    [...d.reasons, ...d.hints].map((r) => r.code).join(', '),
    d.suggestion ? `${d.suggestion.carrier} ${d.suggestion.name_bg}` : '',
  ]
    .join(' | ')
    .replace(/ \| $/, '');
}

describe('legacy sample shipments (#2001–#2011)', () => {
  it('decisions', async () => {
    const lines = await Promise.all(SHIPMENTS.map((orders) => decide(orders)));
    expect(lines).toMatchInlineSnapshot(`
      [
        "#2001 | F | error | — | — | geocode_failed",
        "#2002 + #2007 | C | uncertain | econt | office | point_unclear",
        "#2003 | F | error | — | — | geocode_failed",
        "#2004 | F | error | — | — | geocode_failed",
        "#2005 | F | error | — | — | not_bulgaria",
        "#2006 + #2011 | F | error | — | — | geocode_failed",
        "#2008 | C | uncertain | speedy | office | point_unclear",
        "#2009 | F | error | — | — | geocode_failed",
      ]
    `);
  });

  it('with only the town found on the map (what the hosted geocoder returns for them)', async () => {
    const lines = await Promise.all(
      [[O.o2001], [O.o2006, O.o2011]].map((orders) => decide(orders, fakeDeps(TOWN_ONLY))),
    );
    expect(lines).toMatchInlineSnapshot(`
      [
        "#2001 | E | uncertain | econt | address | no_point_in_range, geocode_city_only, looks_like_home",
        "#2006 + #2011 | E | uncertain | speedy | office | nearest_point, geocode_city_only, looks_like_home | speedy РУСЕ - ТЕХНОПОЛИС",
      ]
    `);
  });
});
