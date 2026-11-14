/**
 * Phase 5 against the real database: imported orders → detection (packages/core) with the real
 * office queries and a fake Nominatim → the decision on the shipment, the "Обадете се" / "Грешка"
 * flag and the status; the call outcomes (owner AND packers, owner decision 14 Nov 2026); a value
 * chosen by hand is never overwritten (T5-11); address edits trigger a new detection (P5-18).
 */
import type { SampleOrder } from '@happyhome/core/import';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runDetection, type DeliveryJobDeps } from '../../supabase/functions/_shared/delivery';
import { adminClient, signedInClient, type Client } from '../support/clients';
import { accessToken, callFunction, pgClient, resetCourierData, rpcDb } from '../support/couriers';
import { cleanUpRun, csvOf, postImport } from '../support/imports';
import { uniq } from '../support/schema';
import { ensureTestUsers, TEST_USERS } from '../support/users';

const run = uniq('d')
  .replace(/[^a-z0-9]/gi, '')
  .slice(-10);
const runNum = String([...run].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 1000, 0)).padStart(
  3,
  '0',
);
const batchIds: string[] = [];

let db: pg.Client;
let owner: Client;
let packer: Client;
let outsider: Client;

// --- offices (real, public data) -------------------------------------------------------------
const OFFICES = [
  [
    'econt',
    '4064',
    'office',
    'Пловдив Капана',
    'Пловдив',
    '4000',
    'Пловдив ул. Стефан Веркович №3',
    42.150058,
    24.749258,
  ],
  [
    'econt',
    '4068',
    'locker',
    'Пловдив 24/7 Еконтомат - Тракия',
    'Пловдив',
    '4000',
    'Пловдив ж.к. Тракия бул. Съединение №43',
    42.13232,
    24.79506,
  ],
  [
    'speedy',
    '202',
    'office',
    'РУСЕ - БУРОВ',
    'Русе',
    null,
    'гр. Русе ул. Буров No 2',
    43.846591,
    25.951992,
  ],
  [
    'speedy',
    '737',
    'office',
    'РУСЕ - БОРИСОВА',
    'Русе',
    null,
    'гр. Русе ул. Борисова No 113',
    43.835456,
    25.956028,
  ],
] as const;
const officeId: Record<string, string> = {};

// --- a fake Nominatim: answers by query text --------------------------------------------------
const hit = (
  lat: number,
  lng: number,
  addresstype: string,
  category: string,
  rank: number,
  town: string,
) => ({
  lat: String(lat),
  lon: String(lng),
  display_name: `${addresstype}, ${town}, България`,
  addresstype,
  category,
  type: addresstype,
  place_rank: rank,
  address: { country_code: 'bg', city: town },
});
const NOMINATIM: Record<string, unknown[]> = {
  Русе: [hit(43.8475, 25.9532, 'city', 'place', 16, 'Русе')],
  'ул. Борисова 100, 7000 Русе': [hit(43.8361, 25.9566, 'road', 'highway', 26, 'Русе')],
};
const nominatimCalls: string[] = [];
const fakeFetch = (async (input: RequestInfo | URL) => {
  const q = new URL(String(input)).searchParams.get('q') ?? '';
  nominatimCalls.push(q);
  return new Response(JSON.stringify(NOMINATIM[q] ?? []), {
    headers: { 'Content-Type': 'application/json' },
  });
}) as typeof fetch;

const jobDeps = (): DeliveryJobDeps => ({
  db: rpcDb(adminClient()),
  fetch: fakeFetch,
  geocoder: { provider: 'nominatim', url: 'https://nominatim.test', enabled: true, email: null },
  geocodeMaxWaitMs: 20_000,
});

// --- orders: one customer each, unique to this run -------------------------------------------
let seq = 0;
function order(key: string, over: Partial<SampleOrder>): SampleOrder {
  seq += 1;
  return {
    name: `#${run}-${key}`,
    id: `${run}7${String(seq).padStart(5, '0')}`,
    email: `${key}.${run}@example.com`,
    created: '2026-11-14 10:00:00 +0200',
    recipient: `Клиент ${run} ${key}`,
    a1: '',
    city: '',
    zip: '',
    phone: `0888${runNum}${String(seq).padStart(3, '0')}`,
    lines: [{ title: 'Спален комплект - Син', sku: `SKU-${run}`, price: 40, qty: 1 }],
    ...over,
  };
}

const ORDERS = {
  a: order('a', { a1: 'Еконт офис Капана', city: 'Пловдив', zip: '4000' }),
  c: order('c', { a1: 'до офис на спиди', city: 'Русе', zip: '7000' }),
  e: order('e', { a1: 'ул. Борисова 100', city: 'Русе', zip: '7000' }),
  b: order('b', { a1: 'ул. Примерна 12, личен адрес', city: 'София', zip: '1000' }),
  f: order('f', { a1: 'BOX NOW Лозенец', city: 'София', zip: '1000' }),
  r: order('r', { a1: 'Еконт', city: 'Пловдив', zip: '4000' }),
};
const shipmentOf: Record<keyof typeof ORDERS, string> = {} as never;

async function overview(id: string) {
  const { data, error } = await adminClient()
    .from('shipment_overview')
    .select('*')
    .eq('id', id)
    .single();
  if (error) throw error;
  return data;
}

async function openDeliveryFlags(id: string) {
  const { rows } = await db.query(
    `select severity, code from public.flags where shipment_id = $1 and issue_key = 'delivery' and resolved_at is null`,
    [id],
  );
  return rows;
}

const rpcError = async (p: PromiseLike<{ error: { message: string; code?: string } | null }>) =>
  (await p).error;

beforeAll(async () => {
  await ensureTestUsers();
  owner = await signedInClient(TEST_USERS.owner.email, TEST_USERS.owner.password);
  packer = await signedInClient(TEST_USERS.packer.email, TEST_USERS.packer.password);
  outsider = await signedInClient(TEST_USERS.outsider.email, TEST_USERS.outsider.password);
  db = await pgClient();
  await resetCourierData(db);
  for (const [carrier, id, type, name, city, postcode, address, lat, lng] of OFFICES) {
    const { rows } = await db.query(
      `insert into public.courier_offices (carrier, external_id, code, type, name_bg, city, postcode, address_text, lat, lng, source, coord_source)
       values ($1, $2, $2, $3, $4, $5, $6, $7, $8, $9, 'test', 'courier') returning id`,
      [carrier, id, type, name, city, postcode, address, lat, lng],
    );
    officeId[`${carrier}-${id}`] = rows[0].id;
  }
  const res = await postImport(owner, `${run}-delivery.csv`, csvOf(Object.values(ORDERS)));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  batchIds.push(res.body.result!.batch_id);
  for (const [key, o] of Object.entries(ORDERS)) {
    const { rows } = await db.query(
      `select so.shipment_id from public.shipment_orders so join public.orders o on o.id = so.order_id where o.name = $1`,
      [o.name],
    );
    shipmentOf[key as keyof typeof ORDERS] = rows[0].shipment_id;
  }
}, 60_000);

afterAll(async () => {
  await cleanUpRun(run, batchIds);
  await resetCourierData(db);
  await db.end();
});

describe('detection after an import', () => {
  it(
    'new shipments wait for detection; one run decides them all',
    { timeout: 60_000 },
    async () => {
      const ids = Object.values(shipmentOf);
      for (const id of ids) expect((await overview(id)).delivery_dirty).toBe(true);

      const results = await runDetection(jobDeps(), { ids, budgetMs: 50_000 });
      expect(results.map((r) => r.result)).toEqual(ids.map(() => 'applied'));
      for (const id of ids) expect((await overview(id)).delivery_dirty).toBe(false);
      // Only the rules that need a map asked the (fake) geocoder; A, B and F never did.
      expect(
        nominatimCalls.some(
          (q) => q.includes('Капана') || q.includes('Примерна') || q.includes('BOX'),
        ),
      ).toBe(false);
    },
  );

  it('rule A: certain, the office is set, nothing to check → ready', async () => {
    const s = await overview(shipmentOf.a);
    expect(s).toMatchObject({
      delivery_certainty: 'certain',
      delivery_rule: 'A',
      carrier: 'econt',
      delivery_type: 'office',
      office_id: officeId['econt-4064'],
      office_name: 'Пловдив Капана',
      status: 'ready',
    });
    expect(await openDeliveryFlags(shipmentOf.a)).toEqual([]);
  });

  it('rule C: uncertain → amber "Обадете се", the nearest office suggested → needs_check', async () => {
    const s = await overview(shipmentOf.c);
    expect(s).toMatchObject({
      delivery_certainty: 'uncertain',
      delivery_rule: 'C',
      carrier: 'speedy',
      office_id: null,
      status: 'needs_check',
      flags_other: 0,
    });
    expect((s.delivery_suggestion as { id: string }).id).toBe(officeId['speedy-202']);
    expect(await openDeliveryFlags(shipmentOf.c)).toEqual([
      { severity: 'amber', code: 'delivery_call' },
    ]);
  });

  it('rule E: the nearest office within 1 km, with the "looks like home" hint', async () => {
    const s = await overview(shipmentOf.e);
    expect(s).toMatchObject({
      delivery_certainty: 'uncertain',
      delivery_rule: 'E',
      carrier: 'speedy',
    });
    expect((s.delivery_suggestion as { id: string }).id).toBe(officeId['speedy-737']);
    expect((s.delivery_hints as { code: string }[]).map((h) => h.code)).toContain(
      'looks_like_home',
    );
  });

  it('rule B: certain home delivery; carrier = the tie-break setting (econt)', async () => {
    expect(await overview(shipmentOf.b)).toMatchObject({
      delivery_certainty: 'certain',
      delivery_rule: 'B',
      delivery_type: 'address',
      carrier: 'econt',
    });
  });

  it('rule F: error → red "Грешка" flag', async () => {
    const s = await overview(shipmentOf.f);
    expect(s).toMatchObject({
      delivery_certainty: 'error',
      delivery_rule: 'F',
      status: 'needs_check',
    });
    expect(await openDeliveryFlags(shipmentOf.f)).toEqual([
      { severity: 'red', code: 'delivery_error' },
    ]);
  });

  it('every decision stores at least one reason in both languages (T5-09)', async () => {
    for (const id of Object.values(shipmentOf)) {
      const reasons = (await overview(id)).delivery_reasons as { bg: string; en: string }[];
      expect(reasons.length).toBeGreaterThan(0);
      for (const r of reasons) expect(r.bg && r.en).toBeTruthy();
    }
  });
});

describe('calls (owner and packers)', () => {
  it('"Не вдига" only counts the call, with a timestamp', async () => {
    const before = await overview(shipmentOf.c);
    const { error } = await packer.rpc('delivery_call_outcome', {
      p_shipment_id: shipmentOf.c,
      p_outcome: 'no_answer',
    });
    expect(error).toBeNull();
    const after = await overview(shipmentOf.c);
    expect(after).toMatchObject({
      call_attempts: 1,
      delivery_certainty: 'uncertain',
      status: 'needs_check',
    });
    expect(after.last_call_at).not.toBeNull();
    expect(after.version).toBe(before.version);
  });

  it('"Потвърди предложението" by a packer: the suggestion becomes the destination → ready', async () => {
    const { data, error } = await packer.rpc('delivery_call_outcome', {
      p_shipment_id: shipmentOf.c,
      p_outcome: 'confirmed',
    });
    expect(error).toBeNull();
    expect(data).toMatchObject({
      office_id: officeId['speedy-202'],
      delivery_certainty: 'certain',
    });
    const s = await overview(shipmentOf.c);
    expect(s).toMatchObject({ status: 'ready', delivery_rule: 'manual', delivery_type: 'office' });
    expect((s.manual_overrides as Record<string, unknown>).delivery).toBeTruthy();
    expect((s.delivery_reasons as { code: string }[])[0]!.code).toBe('confirmed_by_phone');
    expect(await openDeliveryFlags(shipmentOf.c)).toEqual([]);
  });

  it('T5-11: an address edit after a manual choice → detection runs, the choice stays', async () => {
    const { error } = await packer.rpc('shipment_update_address', {
      p_shipment_id: shipmentOf.c,
      p_address1: 'до офис на спиди Борисова',
      p_address2: '',
      p_city: 'Русе',
      p_zip: '',
    });
    expect(error).toBeNull();
    expect((await overview(shipmentOf.c)).delivery_dirty).toBe(true);
    const [result] = await runDetection(jobDeps(), { ids: [shipmentOf.c], budgetMs: 20_000 });
    expect(result!.result).toBe('manual');
    expect(await overview(shipmentOf.c)).toMatchObject({
      office_id: officeId['speedy-202'],
      delivery_rule: 'manual',
      delivery_dirty: false,
      address1: 'до офис на спиди Борисова',
    });
  });

  it('P5-18: an address edit re-runs the detection (no manual choice)', async () => {
    await owner.rpc('shipment_update_address', {
      p_shipment_id: shipmentOf.e,
      p_address1: 'Еконтомат Тракия',
      p_address2: '',
      p_city: 'Пловдив',
      p_zip: '4000',
    });
    await runDetection(jobDeps(), { budgetMs: 20_000 }); // all pending
    // Offices only (settings.point_types, owner 14 Nov 2026): the locker is recognised, but the
    // decision is a call with the nearest Econt office suggested, never the locker.
    const s = await overview(shipmentOf.e);
    expect(s).toMatchObject({
      delivery_rule: 'C',
      delivery_certainty: 'uncertain',
      delivery_type: 'office',
      office_id: null,
      delivery_dirty: false,
    });
    expect((s.delivery_suggestion as { id: string }).id).toBe(officeId['econt-4064']);
    expect((s.delivery_reasons as { code: string }[])[0]!.code).toBe('point_type_not_used');
  });

  it('"Друг офис" (the picker) on an error, and "Личен адрес"', async () => {
    const picked = await owner.rpc('delivery_call_outcome', {
      p_shipment_id: shipmentOf.f,
      p_outcome: 'other_point',
      p_point_id: officeId['econt-4064'],
    });
    expect(picked.error).toBeNull();
    expect(await overview(shipmentOf.f)).toMatchObject({
      carrier: 'econt',
      office_id: officeId['econt-4064'],
      delivery_certainty: 'certain',
      status: 'ready',
    });
    expect(await openDeliveryFlags(shipmentOf.f)).toEqual([]);

    const home = await packer.rpc('delivery_call_outcome', {
      p_shipment_id: shipmentOf.r,
      p_outcome: 'home_address',
    });
    expect(home.error).toBeNull();
    expect(await overview(shipmentOf.r)).toMatchObject({
      delivery_type: 'address',
      office_id: null,
    });
  });

  it('"Отказва поръчката" needs a reason, then cancels the shipment', async () => {
    const missing = await rpcError(
      packer.rpc('delivery_call_outcome', { p_shipment_id: shipmentOf.b, p_outcome: 'refused' }),
    );
    expect(missing?.message).toMatch(/reason_required/);
    const { error } = await packer.rpc('delivery_call_outcome', {
      p_shipment_id: shipmentOf.b,
      p_outcome: 'refused',
      p_note: 'Не иска вече поръчката',
    });
    expect(error).toBeNull();
    const s = await overview(shipmentOf.b);
    expect(s.status).toBe('cancelled');
    expect((s.manual_overrides as { status: { reason: string } }).status.reason).toBe(
      'Не иска вече поръчката',
    );
    // A cancelled shipment is not detected or called any more.
    const again = await rpcError(
      packer.rpc('delivery_call_outcome', { p_shipment_id: shipmentOf.b, p_outcome: 'no_answer' }),
    );
    expect(again?.message).toMatch(/shipment_locked/);
  });

  it('outsiders and signed-out callers cannot record calls or edit addresses', async () => {
    expect(
      await rpcError(
        outsider.rpc('delivery_call_outcome', {
          p_shipment_id: shipmentOf.a,
          p_outcome: 'no_answer',
        }),
      ),
    ).toMatchObject({ code: '42501' });
    const { createClient } = await import('@supabase/supabase-js');
    const { testEnv } = await import('../support/env');
    const anon = createClient(testEnv().url, testEnv().publishableKey);
    expect(
      await rpcError(
        anon.rpc('shipment_update_address', {
          p_shipment_id: shipmentOf.a,
          p_address1: 'x',
          p_address2: '',
          p_city: 'x',
          p_zip: '',
        }),
      ),
    ).not.toBeNull();
    // Nobody signed in writes shipment_calls directly.
    const direct = await packer
      .from('shipment_calls')
      .insert({ shipment_id: shipmentOf.a, outcome: 'no_answer' });
    expect(direct.error).not.toBeNull();
  });

  it('only the owner hands a manual destination back to the detection', async () => {
    expect(
      await rpcError(packer.rpc('delivery_reset', { p_shipment_id: shipmentOf.c })),
    ).toMatchObject({ code: '42501' });
    expect(await rpcError(owner.rpc('delivery_reset', { p_shipment_id: shipmentOf.c }))).toBeNull();
    const s = await overview(shipmentOf.c);
    expect((s.manual_overrides as Record<string, unknown>).delivery).toBeUndefined();
    expect(s.delivery_dirty).toBe(true);
  });

  it('after a settings change the owner has open shipments decided again, never manual ones', async () => {
    const ids = Object.values(shipmentOf);
    await db.query(`update public.shipments set delivery_dirty = false where id = any($1)`, [ids]);
    expect(await rpcError(packer.rpc('delivery_redetect_open'))).toMatchObject({ code: '42501' });
    const { data, error } = await owner.rpc('delivery_redetect_open');
    expect(error).toBeNull();
    expect(data).toBeGreaterThan(0);
    const { rows } = await db.query(
      `select delivery_dirty, status, manual_overrides ? 'delivery' as manual
       from public.shipments where id = any($1)`,
      [ids],
    );
    expect(rows.some((r) => r.manual)).toBe(true);
    for (const r of rows) {
      const open = ['imported', 'needs_check', 'ready'].includes(r.status);
      expect(r.delivery_dirty).toBe(open && !r.manual);
    }
  });
});

describe('the decision store and the function', () => {
  it('a decision for an older version of the shipment is not stored', async () => {
    const { data } = await adminClient().rpc('delivery_apply', {
      p_shipment_id: shipmentOf.a,
      p_version: 1,
      p_decision: { certainty: 'error', rule: 'F', reasons: [] },
    });
    expect(data).toBe('stale');
    expect((await overview(shipmentOf.a)).delivery_certainty).toBe('certain');
  });

  it('detect-delivery: members may run it for given shipments; signed out → 401', async () => {
    const token = await accessToken(packer);
    const res = await callFunction('detect-delivery', token, {
      action: 'ids',
      shipment_ids: [shipmentOf.a],
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.shipments).toEqual([
      expect.objectContaining({ id: shipmentOf.a, result: 'applied' }),
    ]);
    expect((await callFunction('detect-delivery', null, { action: 'pending' })).status).toBe(401);
    expect(
      (await callFunction('detect-delivery', token, { action: 'ids', shipment_ids: ['x'] })).status,
    ).toBe(400);
  });

  it('the 2-minute tick calls the function only when configured and something waits', async () => {
    await db.query(`delete from private.app_config where key = 'functions_url'`);
    expect((await db.query('select private.delivery_detect_tick() as r')).rows[0].r).toBe(
      'not_configured',
    );
    await db.query(
      `insert into private.app_config (key, value) values ('functions_url', 'http://127.0.0.1:9/functions/v1')
       on conflict (key) do update set value = excluded.value`,
    );
    await db.query(`update public.shipments set delivery_dirty = false`);
    expect((await db.query('select private.delivery_detect_tick() as r')).rows[0].r).toBe('idle');
    await db.query(`update public.shipments set delivery_dirty = true where id = $1`, [
      shipmentOf.a,
    ]);
    expect((await db.query('select private.delivery_detect_tick() as r')).rows[0].r).toBe(
      'pending',
    );
    await db.query(`delete from private.app_config where key = 'functions_url'`);
  });
});
