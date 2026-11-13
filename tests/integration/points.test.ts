/**
 * Courier point queries (P4-17 … P4-19, P4-26): nearest_points, points_in_city, search_points,
 * courier_points_stats — with the callers' rights (RLS on courier_offices).
 */
import { haversineKm, latinKey } from '@happyhome/core/geo';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { anonClient, signedInClient, type Client } from '../support/clients';
import { pgClient, resetCourierData } from '../support/couriers';
import { TEST_USERS } from '../support/users';

let db: pg.Client;
let packer: Client;
let outsider: Client;

/** Plovdiv, pl. Stefan Stambolov */
const CENTER = { lat: 42.1475, lng: 24.7495 };
/** n km north (1° of latitude ≈ 111.13 km here). */
const north = (km: number) => ({ lat: CENTER.lat + km / 111.13, lng: CENTER.lng });

interface Seed {
  carrier: 'econt' | 'speedy';
  id: string;
  type: 'office' | 'locker' | 'mobile';
  name: string;
  city: string;
  postcode: string | null;
  address: string;
  at: { lat: number; lng: number } | null;
  active?: boolean;
}

const SEED: Seed[] = [
  {
    carrier: 'econt',
    id: 'E-CENTER',
    type: 'office',
    name: 'Пловдив Център',
    city: 'Пловдив',
    postcode: '4000',
    address: 'ул. Иван Вазов 1',
    at: north(0.1),
  },
  {
    carrier: 'econt',
    id: 'E-LOCKER',
    type: 'locker',
    name: 'Пловдив 24/7 Еконтомат - Тракия',
    city: 'Пловдив',
    postcode: '4000',
    address: 'ж.к. Тракия',
    at: north(0.5),
  },
  {
    carrier: 'speedy',
    id: 'S-OFFICE',
    type: 'office',
    name: 'ПЛОВДИВ - ТРАКИЯ',
    city: 'Пловдив',
    postcode: null,
    address: 'гр. Пловдив жк Тракия бл. 12',
    at: north(1),
  },
  {
    carrier: 'speedy',
    id: 'S-LOCKER',
    type: 'locker',
    name: 'ПЛОВДИВ - КАПАНА (АВТОМАТ)',
    city: 'Пловдив',
    postcode: null,
    address: 'гр. Пловдив ул. Райко Даскалов No 5',
    at: north(3),
  },
  {
    carrier: 'econt',
    id: 'E-FAR',
    type: 'office',
    name: 'Пловдив Север',
    city: 'Пловдив',
    postcode: '4003',
    address: 'ул. Далечна 1',
    at: north(8),
  },
  {
    carrier: 'econt',
    id: 'E-CLOSED',
    type: 'office',
    name: 'Пловдив Закрит',
    city: 'Пловдив',
    postcode: '4000',
    address: 'ул. Стара 1',
    at: north(0.2),
    active: false,
  },
  {
    carrier: 'speedy',
    id: 'S-NOCOORDS',
    type: 'office',
    name: 'ПЛОВДИВ - БЕЗ КООРДИНАТИ',
    city: 'Пловдив',
    postcode: null,
    address: 'гр. Пловдив ул. Нова 3',
    at: null,
  },
  {
    carrier: 'econt',
    id: 'E-SOFIA',
    type: 'office',
    name: 'София Център',
    city: 'София',
    postcode: '1000',
    address: 'бул. Витоша 1',
    at: { lat: 42.6977, lng: 23.3219 },
  },
  {
    carrier: 'econt',
    id: 'E-MOBILE',
    type: 'mobile',
    name: 'Мобилен офис Белозем',
    city: 'Белозем',
    postcode: '4130',
    address: 'с. Белозем',
    at: { lat: 42.2, lng: 25.0 },
  },
];

beforeAll(async () => {
  db = await pgClient();
  await resetCourierData(db);
  for (const s of SEED) {
    await db.query(
      `insert into public.courier_offices
         (carrier, external_id, code, type, name_bg, city, postcode, address_text, lat, lng,
          coord_confidence, coord_source, active, source)
       values ($1, $2, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'test')`,
      [
        s.carrier,
        s.id,
        s.type,
        s.name,
        s.city,
        s.postcode,
        s.address,
        s.at?.lat ?? null,
        s.at?.lng ?? null,
        s.at ? 3 : null,
        s.at ? 'courier' : null,
        s.active ?? true,
      ],
    );
  }
  packer = await signedInClient(TEST_USERS.packer.email, TEST_USERS.packer.password);
  outsider = await signedInClient(TEST_USERS.outsider.email, TEST_USERS.outsider.password);
});

afterAll(async () => {
  await resetCourierData(db);
  await db.end();
});

async function nearest(args: Record<string, unknown>, client: Client = packer) {
  const { data, error } = await client.rpc('nearest_points', {
    p_lat: CENTER.lat,
    p_lng: CENTER.lng,
    ...args,
  } as never);
  if (error) throw error;
  return data as { external_id: string; distance_km: number; lat: number; lng: number }[];
}

describe('nearest_points (P4-17)', () => {
  it('active points with coordinates within 5 km, nearest first', async () => {
    const rows = await nearest({});
    expect(rows.map((r) => r.external_id)).toEqual([
      'E-CENTER',
      'E-LOCKER',
      'S-OFFICE',
      'S-LOCKER',
    ]);
  });

  it('distances agree with the haversine formula within 0.5 % (T4-02, database side)', async () => {
    for (const r of await nearest({})) {
      const expected = haversineKm(CENTER, { lat: r.lat, lng: r.lng });
      expect(Math.abs(r.distance_km - expected) / expected, r.external_id).toBeLessThan(0.005);
    }
  });

  it('filters by courier, type, distance and count', async () => {
    expect((await nearest({ p_carriers: ['speedy'] })).map((r) => r.external_id)).toEqual([
      'S-OFFICE',
      'S-LOCKER',
    ]);
    expect((await nearest({ p_types: ['locker'] })).map((r) => r.external_id)).toEqual([
      'E-LOCKER',
      'S-LOCKER',
    ]);
    expect((await nearest({ p_max_km: 10 })).map((r) => r.external_id)).toContain('E-FAR');
    expect(await nearest({ p_max_km: 0.05 })).toEqual([]);
    expect(await nearest({ p_limit: 2 })).toHaveLength(2);
  });

  it('people who are not members get nothing; signed-out visitors may not call it', async () => {
    expect(await nearest({}, outsider)).toEqual([]);
    const { error } = await anonClient().rpc('nearest_points', { p_lat: 42, p_lng: 24 } as never);
    expect(error?.code).toBe('42501');
  });
});

describe('points_in_city (P4-18)', () => {
  async function inCity(query: string) {
    const { data, error } = await packer.rpc('points_in_city', { p_query: query });
    if (error) throw error;
    return (data as { external_id: string }[]).map((r) => r.external_id).sort();
  }
  const plovdiv = ['E-CENTER', 'E-FAR', 'E-LOCKER', 'S-LOCKER', 'S-NOCOORDS', 'S-OFFICE'];

  it('by city name, in Cyrillic or Latin, with or without "гр."', async () => {
    expect(await inCity('Пловдив')).toEqual(plovdiv);
    expect(await inCity('plovdiv')).toEqual(plovdiv);
    expect(await inCity('гр. Пловдив')).toEqual(plovdiv);
    expect(await inCity('Sofia')).toEqual(['E-SOFIA']);
    expect(await inCity('с. Белозем')).toEqual(['E-MOBILE']);
  });

  it('by postcode: also the points of that city that have no postcode (Speedy)', async () => {
    expect(await inCity('4000')).toEqual(plovdiv);
    expect(await inCity('9999')).toEqual([]);
  });
});

describe('search_points (P4-19)', () => {
  async function search(query: string, extra: Record<string, unknown> = {}) {
    const { data, error } = await packer.rpc('search_points', {
      p_query: query,
      ...extra,
    } as never);
    if (error) throw error;
    return (data as { external_id: string }[]).map((r) => r.external_id);
  }

  it('finds the same points in Cyrillic and in Latin', async () => {
    const cyr = await search('тракия');
    expect(cyr).toEqual(expect.arrayContaining(['E-LOCKER', 'S-OFFICE']));
    expect(await search('trakia')).toEqual(expect.arrayContaining(['E-LOCKER', 'S-OFFICE']));
    expect((await search('пловдив тракия'))[0]).toMatch(/E-LOCKER|S-OFFICE/);
    expect(await search('Еконтомат')).toEqual(['E-LOCKER']);
    expect(await search('ekontomat')).toEqual(['E-LOCKER']);
  });

  it('tolerates small spelling differences', async () => {
    expect(await search('Kapana')).toEqual(['S-LOCKER']);
    expect(await search('plovdiv kapanna')).toContain('S-LOCKER');
  });

  it('skips inactive points and respects the filters', async () => {
    expect(await search('Закрит')).toEqual([]);
    expect(await search('тракия', { p_carriers: ['econt'] })).toEqual(['E-LOCKER']);
    expect(await search('x')).toEqual([]);
  });

  it('the database transliteration matches packages/core', async () => {
    const samples = [
      'Пловдив',
      'София',
      'Велико Търново',
      'ж.к. Тракия бл. 12',
      'Щастливеца',
      'Юлия и Мария',
      'Република България',
      'Ѝ',
      'бул. Цар Борис III 5',
    ];
    const { rows } = await db.query(
      'select private.bg_latin(t) as l from unnest($1::text[]) as t',
      [samples],
    );
    expect(rows.map((r: { l: string }) => r.l)).toEqual(samples.map(latinKey));
  });
});

describe('courier_points_stats (P4-26)', () => {
  it('counts per carrier, type and active, with coordinates', async () => {
    const { data, error } = await packer.rpc('courier_points_stats');
    if (error) throw error;
    expect(data).toEqual(
      expect.arrayContaining([
        { carrier: 'econt', type: 'office', active: true, total: 3, with_coords: 3 },
        { carrier: 'econt', type: 'office', active: false, total: 1, with_coords: 1 },
        { carrier: 'speedy', type: 'office', active: true, total: 2, with_coords: 1 },
        { carrier: 'econt', type: 'mobile', active: true, total: 1, with_coords: 1 },
      ]),
    );
  });
});
