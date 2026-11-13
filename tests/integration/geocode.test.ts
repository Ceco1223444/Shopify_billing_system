/**
 * Geocoder against the real database with a fake Nominatim (no request leaves the computer).
 *   T4-03 the same address twice → the second answer comes from the cache, no request
 *   T4-06 never more than 1 request per second to Nominatim, also with concurrent callers
 * Plus the query variants, caching failures, the scheduled-job pace (4 per minute), geocoding
 * points without coordinates, and the geocode Edge Function's callers.
 */
import { SETTINGS_DEFAULTS } from '@happyhome/core';
import type { GeocodeInput } from '@happyhome/core/geo';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { geocodePendingPoints } from '../../supabase/functions/_shared/courier-sync';
import { geocodeAddress, type GeocoderDeps } from '../../supabase/functions/_shared/geocoder';
import { adminClient, signedInClient } from '../support/clients';
import { accessToken, callFunction, pgClient, resetCourierData, rpcDb } from '../support/couriers';
import { TEST_USERS } from '../support/users';

let db: pg.Client;
const rpc = rpcDb(adminClient());
const settings = { ...SETTINGS_DEFAULTS.geocoder, url: 'https://nominatim.test' };

/** Fake Nominatim: answers by query text, remembers when each request came. */
function fakeNominatim(answers: Record<string, unknown[]>, status = 200) {
  const calls: { q: string; at: number; userAgent: string | null }[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const q = url.searchParams.get('q') ?? '';
    calls.push({ q, at: Date.now(), userAgent: new Headers(init?.headers).get('user-agent') });
    if (status !== 200) return new Response('slow down', { status });
    return new Response(JSON.stringify(answers[q] ?? []), {
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const result = (lat: number, lng: number, addresstype: string, rank: number, town = 'Пловдив') => ({
  lat: String(lat),
  lon: String(lng),
  display_name: `${addresstype} ${lat}, ${town}, България`,
  addresstype,
  category: 'place',
  type: addresstype,
  place_rank: rank,
  address: { country_code: 'bg', city: town },
});

function deps(fetch: typeof globalThis.fetch, over: Partial<GeocoderDeps> = {}): GeocoderDeps {
  return { db: rpc, fetch, settings, mode: 'interactive', maxWaitMs: 20_000, ...over };
}

const STREET: GeocodeInput = {
  address1: 'ул. Иван Вазов 12',
  address2: 'ет. 3',
  city: 'Пловдив',
  zip: '4000',
};

beforeAll(async () => {
  db = await pgClient();
});
afterAll(async () => {
  await resetCourierData(db);
  await db.end();
});
beforeEach(async () => {
  await resetCourierData(db);
});

describe('T4-03: cache', () => {
  it('the second time the same address is answered from the cache, without a request', async () => {
    const nominatim = fakeNominatim({
      'ул. Иван Вазов 12, 4000 Пловдив': [result(42.145, 24.748, 'road', 26)],
    });
    const first = await geocodeAddress(STREET, deps(nominatim.fetch));
    expect(first).toMatchObject({
      lat: 42.145,
      lng: 24.748,
      precision: 'street',
      cached: false,
      requests: 1,
    });
    expect(nominatim.calls).toHaveLength(1);
    expect(nominatim.calls[0]!.userAgent).toMatch(/^HappyHome-Shipping-Hub\//);

    const second = await geocodeAddress(STREET, deps(nominatim.fetch));
    expect(second).toMatchObject({
      lat: 42.145,
      lng: 24.748,
      precision: 'street',
      cached: true,
      requests: 0,
    });
    // Typed differently, other flat: still the same address.
    const again = await geocodeAddress(
      { address1: 'улица Иван Вазов №12', address2: 'ап. 7', city: 'гр. Пловдив', zip: "'4000" },
      deps(nominatim.fetch),
    );
    expect(again.cached).toBe(true);
    expect(nominatim.calls).toHaveLength(1);
  });

  it('tries the variants in order and caches each query; a later address reuses them', async () => {
    const nominatim = fakeNominatim({
      'ж.к. Тракия, Пловдив': [result(42.14, 24.78, 'suburb', 20)],
    });
    const blockAddress: GeocodeInput = { address1: 'ж.к. Тракия бл. 54, вх. Б', city: 'Пловдив' };
    const out = await geocodeAddress(blockAddress, deps(nominatim.fetch));
    expect(out).toMatchObject({ precision: 'quarter', variant: 'quarter', lat: 42.14 });
    expect(nominatim.calls.map((c) => c.q)).toEqual([
      'ж.к. Тракия бл. 54, Пловдив',
      'zh.k. Trakia bl. 54, Plovdiv',
      'ж.к. Тракия, бл. 54, Пловдив',
      'ж.к. Тракия, Пловдив',
    ]);
    const { rows } = await db.query(
      `select kind, count(*)::int as n from public.geocode_cache group by kind order by kind`,
    );
    expect(rows).toEqual([
      { kind: 'address', n: 1 },
      { kind: 'query', n: 4 },
    ]);

    // Another block in the same ж.к.: the shared quarter query is not asked again.
    nominatim.calls.length = 0;
    await geocodeAddress(
      { address1: 'ж.к. Тракия бл. 60', city: 'Пловдив' },
      deps(nominatim.fetch),
    );
    expect(nominatim.calls.map((c) => c.q)).not.toContain('ж.к. Тракия, Пловдив');
  });

  it('a hit in another town is skipped (a street can share a town name)', async () => {
    // Live case: "ул. София 7, Айдемир" without "ул." was answered with a house in Sofia.
    const nominatim = fakeNominatim({
      'София 7, Айдемир': [result(42.69, 23.32, 'building', 30, 'София')],
      Айдемир: [result(44.05, 27.18, 'village', 19, 'Айдемир')],
    });
    const out = await geocodeAddress(
      { address1: 'ул. София 7', city: 'Айдемир' },
      deps(nominatim.fetch),
    );
    expect(out).toMatchObject({ precision: 'city', variant: 'city', lat: 44.05 });
    expect(nominatim.calls.map((c) => c.q)).toEqual([
      'ул. София 7, Айдемир',
      'София 7, Айдемир',
      'ul. Sofia 7, Aydemir',
      'Айдемир',
    ]);
  });

  it('an address that cannot be found is remembered as failed and not asked again', async () => {
    const nominatim = fakeNominatim({});
    const nowhere: GeocodeInput = { address1: 'ул. Несъществуваща 1', city: 'Измислено' };
    expect(await geocodeAddress(nowhere, deps(nominatim.fetch))).toMatchObject({
      precision: 'failed',
      lat: null,
    });
    const asked = nominatim.calls.length;
    expect(asked).toBeGreaterThan(0);
    expect(await geocodeAddress(nowhere, deps(nominatim.fetch))).toMatchObject({
      precision: 'failed',
      cached: true,
    });
    expect(nominatim.calls).toHaveLength(asked);
  });

  it('nothing is cached when the geocoder is off, the address is abroad, or Nominatim refuses', async () => {
    const nominatim = fakeNominatim({});
    expect(
      await geocodeAddress(
        STREET,
        deps(nominatim.fetch, { settings: { ...settings, enabled: false } }),
      ),
    ).toMatchObject({
      precision: 'failed',
      reason: 'disabled',
    });
    expect(await geocodeAddress({ ...STREET, country: 'RO' }, deps(nominatim.fetch))).toMatchObject(
      {
        reason: 'not_bulgaria',
      },
    );
    expect(nominatim.calls).toEqual([]);

    const refusing = fakeNominatim({}, 429);
    expect(await geocodeAddress(STREET, deps(refusing.fetch))).toMatchObject({
      reason: 'provider_error',
    });
    const { rows } = await db.query('select count(*)::int as n from public.geocode_cache');
    expect(rows[0].n).toBe(0);
  });
});

describe('T4-06: at most 1 request per second', () => {
  it('concurrent callers are spaced by the database, across every caller', async () => {
    const nominatim = fakeNominatim(
      Object.fromEntries(
        [1, 2, 3, 4].map((n) => [
          `ул. Тестова ${n}, 4000 Пловдив`,
          [result(42.1 + n / 100, 24.7, 'road', 26)],
        ]),
      ),
    );
    await Promise.all(
      [1, 2, 3, 4].map((n) =>
        geocodeAddress(
          { address1: `ул. Тестова ${n}`, city: 'Пловдив', zip: '4000' },
          deps(nominatim.fetch),
        ),
      ),
    );
    const times = nominatim.calls.map((c) => c.at).sort((a, b) => a - b);
    expect(times).toHaveLength(4);
    for (let i = 1; i < times.length; i++) {
      expect(times[i]! - times[i - 1]!, `gap ${i}`).toBeGreaterThanOrEqual(1000);
    }
  }, 30_000);

  it('the reservation itself: 1.2 s apart, and "busy" instead of a long wait', async () => {
    const reserve = (bucket: string, interval: number, maxWait: number) =>
      adminClient().rpc('geocoder_reserve', {
        p_bucket: bucket,
        p_interval_ms: interval,
        p_max_wait_ms: maxWait,
      });
    const waits = (
      await Promise.all([1, 2, 3, 4, 5].map(() => reserve('nominatim', 1200, 10_000)))
    ).map((r) => r.data as number);
    waits.sort((a, b) => a - b);
    for (let i = 1; i < waits.length; i++)
      expect(waits[i]! - waits[i - 1]!).toBeGreaterThanOrEqual(1100);
    expect((await reserve('nominatim', 1200, 100)).data).toBeNull();

    // Scheduled jobs (office geocoding): 15 s apart, the policy's 4 per minute.
    const bulk1 = (await reserve('nominatim_bulk', 15_000, 60_000)).data as number;
    const bulk2 = (await reserve('nominatim_bulk', 15_000, 60_000)).data as number;
    expect(bulk2 - bulk1).toBeGreaterThanOrEqual(14_900);
  });

  it('a caller that would have to wait too long answers "busy" and asks nothing', async () => {
    const nominatim = fakeNominatim({});
    await adminClient().rpc('geocoder_reserve', {
      p_bucket: 'nominatim',
      p_interval_ms: 60_000,
      p_max_wait_ms: 0,
    });
    const out = await geocodeAddress(STREET, deps(nominatim.fetch, { maxWaitMs: 500 }));
    expect(out.reason).toBe('busy');
    expect(nominatim.calls).toEqual([]);
  });
});

describe('points without coordinates from the courier', () => {
  async function addPending(id: string, address: string) {
    await db.query(
      `insert into public.courier_offices (carrier, external_id, type, name_bg, city, postcode, address_text, source, geocode_status)
       values ('speedy', $1, 'office', 'ТЕСТ', 'Айтос', '8500', $2, 'test', 'pending')`,
      [id, address],
    );
  }

  it(
    'are geocoded at the scheduled-job pace and marked as Nominatim coordinates',
    { timeout: 30_000 },
    async () => {
      await addPending('G1', 'гр. Айтос [8500] ул. Славянска No 34');
      const nominatim = fakeNominatim({
        'ул. Славянска 34, 8500 Айтос': [result(42.7, 27.25, 'building', 30, 'Айтос')],
      });
      const tried = await geocodePendingPoints(
        {
          db: rpc,
          adapterFor: async () => ({
            ok: false,
            error: { code: 'mode_not_available', message: '' },
          }),
          budgetMs: 10_000,
          leaseSeconds: 60,
          geocoder: { settings, fetch: nominatim.fetch },
        },
        10_000,
      );
      expect(tried).toBe(1);
      const { rows } = await db.query(
        `select lat, lng, coord_source, coord_confidence, geocode_status, geocode_attempts from public.courier_offices where external_id = 'G1'`,
      );
      expect(rows[0]).toEqual({
        lat: 42.7,
        lng: 27.25,
        coord_source: 'nominatim',
        coord_confidence: 2,
        geocode_status: 'done',
        geocode_attempts: 1,
      });
    },
  );

  it('a busy geocoder gives the try back', async () => {
    await addPending('G2', 'гр. Айтос [8500] ул. Друга No 1');
    await adminClient().rpc('geocoder_reserve', {
      p_bucket: 'nominatim_bulk',
      p_interval_ms: 60_000,
      p_max_wait_ms: 0,
    });
    await geocodePendingPoints(
      {
        db: rpc,
        adapterFor: async () => ({ ok: false, error: { code: 'mode_not_available', message: '' } }),
        budgetMs: 1000,
        leaseSeconds: 60,
        geocoder: { settings, fetch: fakeNominatim({}).fetch },
      },
      1000,
    );
    const { rows } = await db.query(
      `select geocode_status, geocode_attempts, geocode_tried_at from public.courier_offices where external_id = 'G2'`,
    );
    expect(rows[0]).toEqual({
      geocode_status: 'pending',
      geocode_attempts: 0,
      geocode_tried_at: null,
    });
  });
});

describe('geocode Edge Function', () => {
  // The function would call the real Nominatim on a cache miss: switch the geocoder off here.
  beforeEach(async () => {
    await db.query(
      `update public.settings set value = jsonb_set(value, '{enabled}', 'false') where key = 'geocoder'`,
    );
  });
  afterAll(async () => {
    await db.query(
      `update public.settings set value = jsonb_set(value, '{enabled}', 'true') where key = 'geocoder'`,
    );
  });

  it('a packer gets a cached address; a miss with the geocoder off says so', async () => {
    const nominatim = fakeNominatim({
      'ул. Иван Вазов 12, 4000 Пловдив': [result(42.145, 24.748, 'road', 26)],
    });
    await geocodeAddress(STREET, deps(nominatim.fetch));
    const packer = await signedInClient(TEST_USERS.packer.email, TEST_USERS.packer.password);
    const token = await accessToken(packer);
    const hit = await callFunction('geocode', token, STREET);
    expect(hit).toMatchObject({
      status: 200,
      json: { ok: true, result: { lat: 42.145, precision: 'street', cached: true } },
    });
    const miss = await callFunction('geocode', token, { address1: 'ул. Друга 1', city: 'Пловдив' });
    expect(miss).toMatchObject({
      status: 200,
      json: { result: { precision: 'failed', reason: 'disabled' } },
    });
  });

  it('signed out → 401, outsiders → 403, bad input → 400', async () => {
    expect((await callFunction('geocode', null, STREET)).status).toBe(401);
    const outsider = await signedInClient(TEST_USERS.outsider.email, TEST_USERS.outsider.password);
    expect((await callFunction('geocode', await accessToken(outsider), STREET)).status).toBe(403);
    const owner = await signedInClient(TEST_USERS.owner.email, TEST_USERS.owner.password);
    expect((await callFunction('geocode', await accessToken(owner), { city: 42 })).status).toBe(
      400,
    );
  });
});
