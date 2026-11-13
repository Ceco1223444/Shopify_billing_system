/**
 * Phase 3: building shipments from imported orders (T3-01 … T3-16), through the real
 * import-batch Edge Function and database. Every customer (phone, email, name) is unique
 * to this run, so nothing here can match another test file's customers.
 */
import {
  sampleLine,
  sampleRows,
  SAMPLE_PRODUCTS as P,
  type CsvRow,
  type SampleOrder,
} from '@happyhome/core/import';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminClient, signedInClient, type Client } from '../support/clients';
import { cleanUpRun, csvOf, postImport, rowsCsv, runOrders } from '../support/imports';
import { uniq } from '../support/schema';
import { ensureTestUsers, TEST_USERS } from '../support/users';

const run = uniq('s')
  .replace(/[^a-z0-9]/gi, '')
  .slice(-10);
const runA = `${run}a`;
const runB = `${run}b`;
const batchIds: string[] = [];
const L = sampleLine;

let owner: Client;
let packer: Client;

beforeAll(async () => {
  await ensureTestUsers();
  owner = await signedInClient(TEST_USERS.owner.email, TEST_USERS.owner.password);
  packer = await signedInClient(TEST_USERS.packer.email, TEST_USERS.packer.password);
});

afterAll(async () => {
  await cleanUpRun(run, batchIds);
  await cleanUpRun(runA, []);
  await cleanUpRun(runB, []);
});

// ---------------------------------------------------------------------------
// Synthetic orders: one "customer" = one key, unique to this run
// ---------------------------------------------------------------------------
let seq = 0;
const runNum = String([...run].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 1000, 0)).padStart(
  3,
  '0',
);

/** A Bulgarian mobile unique to this run and key: 0887 + 3 run digits + 3 key digits. */
const phone = (key: number) => `0887${runNum}${String(key).padStart(3, '0')}`;
const email = (key: string) => `${key}.${run}@example.com`;

function order(over: Partial<SampleOrder> & { name: string }): SampleOrder {
  seq += 1;
  return {
    id: `${run}9${String(seq).padStart(5, '0')}`,
    email: '',
    created: '2026-11-10 10:00:00 +0200',
    recipient: `Клиент ${run} ${seq}`,
    a1: 'ул. Тестова 1',
    city: 'София',
    zip: '1000',
    phone: '',
    lines: [L(P.blue)],
    ...over,
    name: `#${run}-${over.name}`,
  };
}

async function importOk(name: string, bytes: Uint8Array) {
  const res = await postImport(owner, `${run}-${name}`, bytes);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  batchIds.push(res.body.result!.batch_id);
  return res.body.result!;
}
const importOrders = (name: string, orders: SampleOrder[]) => importOk(name, csvOf(orders));

async function orderId(name: string): Promise<string> {
  const { data, error } = await adminClient().from('orders').select('id').eq('name', name).single();
  if (error) throw new Error(`${name}: ${error.message}`);
  return data.id;
}

/** order name -> shipment id (null when the order is in no shipment). */
async function shipmentOf(name: string): Promise<string | null> {
  const { data } = await adminClient()
    .from('shipment_orders')
    .select('shipment_id')
    .eq('order_id', await orderId(name))
    .maybeSingle();
  return data?.shipment_id ?? null;
}

async function shipment(id: string) {
  const { data, error } = await adminClient()
    .from('shipment_overview')
    .select('*')
    .eq('id', id)
    .single();
  if (error) throw error;
  return data;
}

async function orderFlags(name: string) {
  const { data } = await adminClient()
    .from('flags')
    .select('*')
    .eq('order_id', await orderId(name));
  return data ?? [];
}

async function shipmentFlags(id: string) {
  const { data } = await adminClient().from('flags').select('*').eq('shipment_id', id);
  return data ?? [];
}

const PHASE3_CODES = [
  'CUSTOMER_DIFFERENT_ADDRESSES',
  'MERGE_SUGGESTED',
  'CUSTOMER_HAS_WAYBILLED_SHIPMENT',
  'SAME_NAME_DIFFERENT_CUSTOMER',
  'DUPLICATE_ORDER_SUSPECTED',
  'SIMILAR_ORDER_SUSPECTED',
];

// ---------------------------------------------------------------------------
describe('same customer (T3-01, T3-02)', () => {
  it.each([
    {
      id: 'T3-01',
      what: 'phone written three ways',
      key: 101,
      variants: (k: number) => [
        { phone: `+359 887 ${runNum} ${String(k).padStart(3, '0')}` },
        { phone: phone(k) },
        { phone: phone(k).slice(1) },
      ],
      by: ['phone'],
    },
    {
      id: 'T3-02',
      what: 'email in different case and with spaces',
      key: 102,
      variants: () => [
        { email: `Ana.Test.${run}@Example.com`, phone: phone(201) },
        { email: `  ana.test.${run}@example.com `, phone: phone(202) },
        { email: `ANA.TEST.${run}@EXAMPLE.COM`, phone: phone(203) },
      ],
      by: ['email'],
    },
  ])('$id: $what -> one shipment', async ({ id, key, variants, by }) => {
    const lines = [[L(P.blue)], [L(P.rose)], [L(P.towel)]];
    const orders = variants(key).map((v, i) =>
      order({
        name: `${id}-${i + 1}`,
        created: `2026-11-1${i} 10:00:00 +0200`, // three days apart: no duplicate check
        lines: lines[i]!,
        ...v,
      }),
    );
    await importOrders(`${id}.csv`, orders);
    const ids = await Promise.all(orders.map((o) => shipmentOf(o.name)));
    expect(new Set(ids).size).toBe(1);
    const s = await shipment(ids[0]!);
    expect(s.order_count).toBe(3);
    expect(s.combined_by).toEqual(by);
    expect(s.reference).toBe(orders.map((o) => o.name).join(' + '));
    // The recipient comes from the earliest order.
    expect(s.recipient_name).toBe(orders[0]!.recipient);
    expect(s.recipient_phone_raw).toBe(orders[0]!.phone);
  });

  it('the differences between combined orders become grey flags (recipient from the earliest)', async () => {
    const id = (await shipmentOf(`#${run}-T3-02-1`))!;
    const flags = await shipmentFlags(id);
    const differs = flags.filter((f) => f.code === 'SHIPMENT_RECIPIENT_DIFFERS');
    // Names and phones differ; the emails differ only in case and spaces, so they are the same.
    expect(differs.map((f) => (f.details as { field: string }).field).sort()).toEqual([
      'name',
      'phone',
    ]);
    expect(differs.every((f) => f.severity === 'info')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('what is combined, and what is not', () => {
  it('T3-03: same customer, same batch, different destination -> two shipments, amber on both', async () => {
    const a = order({ name: 'T3-03-a', phone: phone(301), a1: 'ул. Първа 1', lines: [L(P.blue)] });
    const b = order({
      name: 'T3-03-b',
      phone: phone(301),
      a1: 'Офис Еконт – Варна Тест',
      city: 'Варна',
      zip: '9000',
      created: '2026-11-13 10:00:00 +0200',
      lines: [L(P.duvet)],
    });
    await importOrders('T3-03.csv', [a, b]);
    const [sa, sb] = [await shipmentOf(a.name), await shipmentOf(b.name)];
    expect(sa).not.toBe(sb);
    for (const [self, other] of [
      [a, b],
      [b, a],
    ] as const) {
      const flag = (await orderFlags(self.name)).find(
        (f) => f.code === 'CUSTOMER_DIFFERENT_ADDRESSES',
      );
      expect(flag).toMatchObject({ severity: 'amber', origin: 'shipments' });
      expect(flag!.message_bg).toBe('Един клиент, различни адреси — обадете се');
      expect(
        (flag!.details as { related: { order: string }[] }).related.map((r) => r.order),
      ).toEqual([other.name]);
    }
    expect((await shipment(sa!)).status).toBe('needs_check');
    expect((await shipment(sb!)).status).toBe('needs_check');
  });

  it('T3-04: same customer + destination, different batches, not waybilled -> merge suggestion on both', async () => {
    const a = order({ name: 'T3-04-a', phone: phone(401), lines: [L(P.blue)] });
    const b = order({
      name: 'T3-04-b',
      phone: phone(401),
      created: '2026-11-14 10:00:00 +0200',
      lines: [L(P.towel)],
    });
    await importOrders('T3-04-1.csv', [a]);
    await importOrders('T3-04-2.csv', [b]);
    const [sa, sb] = [(await shipmentOf(a.name))!, (await shipmentOf(b.name))!];
    expect(sa).not.toBe(sb);
    const fa = (await shipmentFlags(sa)).find((f) => f.code === 'MERGE_SUGGESTED');
    const fb = (await shipmentFlags(sb)).find((f) => f.code === 'MERGE_SUGGESTED');
    expect(fa?.message_bg).toBe(
      `Същият клиент има неизпратена пратка от друго внасяне (${b.name}) — да ги обединим?`,
    );
    expect(fb?.message_bg).toContain(`(${a.name})`);
    expect(fa?.details).toMatchObject({ other_shipment_id: sb });
    expect(fb?.details).toMatchObject({ other_shipment_id: sa });
    expect((await shipment(sa)).status).toBe('needs_check');
  });

  it('T3-05: the same name only -> separate, grey flag only', async () => {
    const recipient = `Иван Иванов ${run}`;
    const a = order({ name: 'T3-05-a', recipient, phone: phone(501), email: email('t305a') });
    const b = order({
      name: 'T3-05-b',
      recipient,
      phone: phone(502),
      email: email('t305b'),
      lines: [L(P.rose)],
    });
    await importOrders('T3-05.csv', [a, b]);
    expect(await shipmentOf(a.name)).not.toBe(await shipmentOf(b.name));
    for (const [self, other] of [
      [a, b],
      [b, a],
    ] as const) {
      const flags = await orderFlags(self.name);
      const same = flags.filter((f) => f.code === 'SAME_NAME_DIFFERENT_CUSTOMER');
      expect(same).toHaveLength(1);
      expect(same[0]).toMatchObject({
        severity: 'info',
        message_bg: `Същото име като поръчка ${other.name} — вероятно различни хора`,
      });
      expect(flags.filter((f) => PHASE3_CODES.includes(f.code) && f.severity !== 'info')).toEqual(
        [],
      );
    }
  });

  it('P3-14: a shipment without red/amber flags is ready, one with them needs checking', async () => {
    const id = (await shipmentOf(`#${run}-T3-05-a`))!;
    const s = await shipment(id);
    expect((s.flags_red ?? 0) + (s.flags_amber ?? 0)).toBe(0);
    expect(s.status).toBe('ready');
  });

  it('T3-06: a new order for a waybilled shipment gets its own shipment; the old one is untouched', async () => {
    const a = order({ name: 'T3-06-a', phone: phone(601) });
    await importOrders('T3-06-1.csv', [a]);
    const sa = (await shipmentOf(a.name))!;
    await adminClient()
      .from('shipments')
      .update({ status: 'waybill_created', carrier: 'econt', waybill_number: `W${run}` })
      .eq('id', sa);
    const before = await shipment(sa);

    const b = order({
      name: 'T3-06-b',
      phone: phone(601),
      created: '2026-11-15 10:00:00 +0200',
      lines: [L(P.pillow)],
    });
    await importOrders('T3-06-2.csv', [b]);
    const sb = (await shipmentOf(b.name))!;
    expect(sb).not.toBe(sa);
    const flag = (await shipmentFlags(sb)).find(
      (f) => f.code === 'CUSTOMER_HAS_WAYBILLED_SHIPMENT',
    );
    expect(flag?.message_bg).toBe(`Вече има създадена пратка за този клиент (${a.name})`);
    const after = await shipment(sa);
    expect(after).toMatchObject({
      status: 'waybill_created',
      order_count: 1,
      version: before.version,
      reference: a.name,
    });
  });

  it('T3-07: cancelled, fulfilled and nothing-to-ship orders get no shipment, each with a flag', async () => {
    const cancelled = order({
      name: 'T3-07-c',
      phone: phone(701),
      cancelled: '2026-11-10 11:00:00 +0200',
    });
    const fulfilled = order({ name: 'T3-07-f', phone: phone(702) });
    const digital = order({ name: 'T3-07-d', phone: phone(703) });
    const rows: CsvRow[] = [
      ...sampleRows(cancelled),
      ...sampleRows(fulfilled).map((r, i) =>
        i === 0 ? { ...r, 'Fulfillment Status': 'fulfilled' } : r,
      ),
      ...sampleRows(digital).map((r) => ({ ...r, 'Lineitem requires shipping': 'false' })),
    ];
    await importOk('T3-07.csv', rowsCsv(rows));
    for (const [o, code] of [
      [cancelled, 'SHIPMENT_EXCLUDED_CANCELLED'],
      [fulfilled, 'SHIPMENT_EXCLUDED_FULFILLED'],
      [digital, 'SHIPMENT_EXCLUDED_NO_SHIPPING'],
    ] as const) {
      expect(await shipmentOf(o.name), o.name).toBeNull();
      const flag = (await orderFlags(o.name)).find((f) => f.code === code);
      expect(flag, code).toBeTruthy();
      expect(flag!.message_bg).toMatch(/^Не е включена в пратка/);
    }
  });
});

// ---------------------------------------------------------------------------
describe('duplicate-mistake detector (T3-08, T3-09)', () => {
  it.each([
    {
      id: 'T3-08 inside 48 h, same file',
      key: 801,
      gap: 23,
      sameFile: true,
      code: 'DUPLICATE_ORDER_SUSPECTED',
      severity: 'red',
    },
    {
      id: 'T3-08 inside 48 h, two files',
      key: 802,
      gap: 47,
      sameFile: false,
      code: 'DUPLICATE_ORDER_SUSPECTED',
      severity: 'red',
    },
    { id: 'T3-08 outside 48 h', key: 803, gap: 72, sameFile: true, code: null, severity: null },
    {
      id: 'T3-09 overlapping products',
      key: 804,
      gap: 5,
      sameFile: true,
      code: 'SIMILAR_ORDER_SUSPECTED',
      severity: 'amber',
      overlap: true,
    },
  ])('$id', async ({ id, key, gap, sameFile, code, severity, overlap }) => {
    const base = new Date('2026-11-20T08:00:00Z');
    const fmt = (d: Date) => d.toISOString().replace('T', ' ').slice(0, 19) + ' +0000';
    const tag = id.replace(/[^A-Za-z0-9]/g, '');
    const a = order({
      name: `${tag}-a`,
      phone: phone(key),
      created: fmt(base),
      lines: [L(P.blue), L(P.pillow, 2)],
    });
    const b = order({
      name: `${tag}-b`,
      phone: phone(key),
      created: fmt(new Date(base.getTime() + gap * 3600_000)),
      lines: overlap ? [L(P.blue)] : [L(P.pillow, 2), L(P.blue)], // same set, other line order
    });
    if (sameFile) await importOrders(`${tag}.csv`, [a, b]);
    else {
      await importOrders(`${tag}-1.csv`, [a]);
      await importOrders(`${tag}-2.csv`, [b]);
    }
    for (const [self, other] of [
      [a, b],
      [b, a],
    ] as const) {
      const found = (await orderFlags(self.name)).filter((f) =>
        ['DUPLICATE_ORDER_SUSPECTED', 'SIMILAR_ORDER_SUSPECTED'].includes(f.code),
      );
      if (!code) {
        expect(found).toEqual([]);
        continue;
      }
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ code, severity });
      // Both orders side by side.
      const shown = (found[0]!.details as { orders: { order: string }[] }).orders.map(
        (o) => o.order,
      );
      expect(shown).toEqual([self.name, other.name]);
    }
    if (code === 'DUPLICATE_ORDER_SUSPECTED') {
      expect((await orderFlags(a.name)).find((f) => f.code === code)!.message_bg).toBe(
        'Възможна грешка: две еднакви поръчки една след друга — обадете се преди изпращане',
      );
      expect((await shipment((await shipmentOf(b.name))!)).status).toBe('needs_check');
    }
  });
});

// ---------------------------------------------------------------------------
describe('combined values, cancellation, manual controls (T3-10 … T3-13)', () => {
  let combined: string;
  const x = order({ name: 'T3-10-x', phone: phone(901), lines: [L(P.blue)] });
  const y = order({
    name: 'T3-10-y',
    phone: phone(901),
    created: '2026-11-13 12:00:00 +0200',
    lines: [L(P.towel, 2)],
  });
  const z = order({
    name: 'T3-10-z',
    phone: phone(901),
    created: '2026-11-16 12:00:00 +0200',
    lines: [L(P.duvet)],
  });

  it('COD = sum of the COD orders (Outstanding Balance, fallback Total); prepaid adds 0, with a breakdown', async () => {
    const rows: CsvRow[] = [
      ...sampleRows(x),
      ...sampleRows(y).map((r, i) =>
        i === 0
          ? {
              ...r,
              'Payment Method': 'Bank Deposit',
              'Financial Status': 'paid',
              'Outstanding Balance': '0.00',
            }
          : r,
      ),
      ...sampleRows(z).map((r, i) => (i === 0 ? { ...r, 'Outstanding Balance': '' } : r)),
    ];
    await importOk('T3-10-1.csv', rowsCsv(rows));
    combined = (await shipmentOf(x.name))!;
    expect(await shipmentOf(y.name)).toBe(combined);
    expect(await shipmentOf(z.name)).toBe(combined);
    const s = await shipment(combined);
    // x: 32.99 + 4.99 shipping (outstanding); y prepaid; z: 31.99 + 4.99 (no outstanding -> total)
    expect(s.cod_breakdown).toEqual([
      expect.objectContaining({
        order: x.name,
        cod: true,
        amount_cents: 3798,
        source: 'outstanding',
      }),
      expect.objectContaining({ order: y.name, cod: false, amount_cents: 0, source: 'prepaid' }),
      expect.objectContaining({ order: z.name, cod: true, amount_cents: 3698, source: 'total' }),
    ]);
    expect(s.cod_cents).toBe(3798 + 3698);
    expect(s.reference).toBe(`${x.name} + ${y.name} + ${z.name}`);
    expect((s.contents as { order: string }[]).map((c) => c.order)).toEqual([
      x.name,
      y.name,
      z.name,
    ]);
  });

  it('T3-10: an order cancelled in a later batch is taken out of its shipment, with a flag', async () => {
    await importOrders('T3-10-2.csv', [{ ...z, cancelled: '2026-11-17 09:00:00 +0200' }]);
    expect(await shipmentOf(z.name)).toBeNull();
    const s = await shipment(combined);
    expect(s.order_count).toBe(2);
    expect(s.reference).toBe(`${x.name} + ${y.name}`);
    expect(s.cod_cents).toBe(3798);
    const flag = (await orderFlags(z.name)).find((f) => f.code === 'ORDER_CANCELLED_AFTER_IMPORT');
    expect(flag?.severity).toBe('red');
    expect(flag?.message_bg).toContain(`Махната е от пратка ${x.name} + ${y.name} + ${z.name}`);
  });

  it('T3-12: a packer can neither split nor merge, also not through the tables', async () => {
    const split = await packer.rpc('shipment_split', { p_order_id: await orderId(y.name) });
    expect(split.error?.code).toBe('42501');
    const other = (await shipmentOf(`#${run}-T3-05-a`))!;
    const merge = await packer.rpc('shipment_merge', { p_target: combined, p_source: other });
    expect(merge.error?.code).toBe('42501');

    const { data: moved } = await packer
      .from('shipment_orders')
      .update({ shipment_id: other })
      .eq('order_id', await orderId(y.name))
      .select();
    expect(moved).toEqual([]);
    const { error: insertError } = await packer.from('shipments').insert({ status: 'ready' });
    expect(insertError?.code).toBe('42501');
    expect(await shipmentOf(y.name)).toBe(combined);
  });

  it('T3-11: the owner splits an order out and merges it back; both are audited', async () => {
    const { data: newId, error } = await owner.rpc('shipment_split', {
      p_order_id: await orderId(y.name),
    });
    expect(error).toBeNull();
    expect(await shipmentOf(y.name)).toBe(newId);
    expect((await shipment(combined)).order_count).toBe(1);
    expect((await shipment(newId!)).manual_overrides).toMatchObject({ orders: true });

    const { data: splitAudit } = await adminClient()
      .from('audit_log')
      .select('reason, actor')
      .eq('reason', 'manual_split')
      .eq('row_id', await orderId(y.name));
    expect(splitAudit).toHaveLength(1);

    const { error: mergeError } = await owner.rpc('shipment_merge', {
      p_target: combined,
      p_source: newId!,
    });
    expect(mergeError).toBeNull();
    expect(await shipmentOf(y.name)).toBe(combined);
    const s = await shipment(combined);
    expect(s.order_count).toBe(2);
    expect(s.combined_by).toEqual(['phone', 'manual']);
    const { count } = await adminClient()
      .from('shipments')
      .select('id', { count: 'exact', head: true })
      .eq('id', newId!);
    expect(count).toBe(0);
    const { data: mergeAudit } = await adminClient()
      .from('audit_log')
      .select('reason')
      .eq('reason', 'manual_merge')
      .eq('row_id', combined);
    expect(mergeAudit).toHaveLength(1);
  });

  it('T3-13: a re-import after a manual split keeps the decision', async () => {
    const { data: newId } = await owner.rpc('shipment_split', {
      p_order_id: await orderId(y.name),
    });
    // The same orders again (y changed), plus the cancelled z: nothing moves back.
    await importOrders('T3-13.csv', [x, { ...y, notes: 'Звъннете преди доставка' }]);
    expect(await shipmentOf(x.name)).toBe(combined);
    expect(await shipmentOf(y.name)).toBe(newId);
    const suggestions = [
      ...(await shipmentFlags(combined)),
      ...(await shipmentFlags(newId!)),
    ].filter((f) => f.code === 'MERGE_SUGGESTED');
    expect(suggestions).toEqual([]);
  });

  it('a merge suggestion is answered with one click: merge, or keep apart (remembered)', async () => {
    const a = (await shipmentOf(`#${run}-T3-04-a`))!;
    const b = (await shipmentOf(`#${run}-T3-04-b`))!;
    const { error } = await owner.rpc('shipment_keep_apart', { p_shipment_a: a, p_shipment_b: b });
    expect(error).toBeNull();
    const open = [...(await shipmentFlags(a)), ...(await shipmentFlags(b))].filter(
      (f) => f.code === 'MERGE_SUGGESTED' && f.resolved_at === null,
    );
    expect(open).toEqual([]);
    expect((await shipment(a)).status).toBe('ready');

    const { error: mergeError } = await owner.rpc('shipment_merge', { p_target: a, p_source: b });
    expect(mergeError).toBeNull();
    expect(await shipmentOf(`#${run}-T3-04-b`)).toBe(a);
  });
});

// ---------------------------------------------------------------------------
describe('legacy samples (T3-14 … T3-16)', () => {
  /** The two legacy sample files, as runOrders() gives them (week 2 has #2004 with another phone). */
  function legacyFiles(prefix: string, digits: string) {
    const O = runOrders(prefix, digits);
    const o2004b: SampleOrder = { ...O.o2004, phone: O.o2004.phone.replace(/\d{3}$/, '999') };
    return {
      O,
      week1: [O.o2001, O.o2002, O.o2003, O.o2004, O.o2005, O.o2006],
      week2: [O.o2007, O.o2001, O.o2008, o2004b, O.o2009, O.o2010, O.o2011],
    };
  }

  it('T3-14: both files in ONE batch -> #2002 + #2007 and #2006 + #2011 combined', async () => {
    const { O, week1, week2 } = legacyFiles(runA, '714');
    const res = await postImport(owner, `${runA}-both.csv`, csvOf([...week1, ...week2]));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    batchIds.push(res.body.result!.batch_id);

    const s27 = (await shipmentOf(O.o2002.name))!;
    expect(await shipmentOf(O.o2007.name)).toBe(s27);
    expect((await shipment(s27)).combined_by).toContain('email');
    const s611 = (await shipmentOf(O.o2006.name))!;
    expect(await shipmentOf(O.o2011.name)).toBe(s611);
    expect((await shipment(s611)).combined_by).toEqual(['phone']);
    expect((await shipment(s611)).reference).toBe(`${O.o2006.name} + ${O.o2011.name}`);

    // #2003 (Варна) and #2008 (Speedy office in София): one customer, two destinations.
    expect(await shipmentOf(O.o2003.name)).not.toBe(await shipmentOf(O.o2008.name));
    expect(
      (await orderFlags(O.o2008.name)).some((f) => f.code === 'CUSTOMER_DIFFERENT_ADDRESSES'),
    ).toBe(true);
    // #2010 is cancelled: no shipment. #2001 twice in the file: one order, one shipment.
    expect(await shipmentOf(O.o2010.name)).toBeNull();
    const { count } = await adminClient()
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('name', O.o2001.name);
    expect(count).toBe(1);
  });

  it('T3-15 + T3-16: as TWO batches -> not combined, merge suggestion on both pairs; #2001 stays one order', async () => {
    const { O, week1, week2 } = legacyFiles(runB, '715');
    for (const [i, file] of [week1, week2].entries()) {
      const res = await postImport(owner, `${runB}-week-${i + 1}.csv`, csvOf(file));
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      batchIds.push(res.body.result!.batch_id);
    }
    for (const [first, second] of [
      [O.o2002, O.o2007],
      [O.o2006, O.o2011],
    ] as const) {
      const s1 = (await shipmentOf(first.name))!;
      const s2 = (await shipmentOf(second.name))!;
      expect(s1).not.toBe(s2);
      const f1 = (await shipmentFlags(s1)).find((f) => f.code === 'MERGE_SUGGESTED');
      const f2 = (await shipmentFlags(s2)).find((f) => f.code === 'MERGE_SUGGESTED');
      expect(f1?.details).toMatchObject({ other_shipment_id: s2 });
      expect(f2?.details).toMatchObject({ other_shipment_id: s1 });
    }
    const { data: o2001 } = await adminClient()
      .from('orders')
      .select('id, import_batch_orders(outcome)')
      .eq('name', O.o2001.name);
    expect(o2001).toHaveLength(1);
    expect(o2001![0]!.import_batch_orders.map((b) => b.outcome).sort()).toEqual([
      'new',
      'unchanged',
    ]);
    expect(await shipmentOf(O.o2001.name)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('Пратки list (P3-16, P3-17)', () => {
  it('lists shipments with order numbers, recipient, city, COD, status and flag counts', async () => {
    const id = (await shipmentOf(`#${run}-T3-01-1`))!;
    const { data, error } = await owner
      .from('shipment_overview')
      .select(
        'reference, recipient_name, city, cod_cents, status, flags_red, flags_amber, flags_info, combined_by, orders, order_count',
      )
      .eq('id', id)
      .single();
    expect(error).toBeNull();
    expect(data).toMatchObject({ order_count: 3, city: 'София', combined_by: ['phone'] });
    expect((data!.orders as { name: string }[]).map((o) => o.name)).toEqual([
      `#${run}-T3-01-1`,
      `#${run}-T3-01-2`,
      `#${run}-T3-01-3`,
    ]);
    expect(data!.cod_cents).toBeGreaterThan(0);
    expect(typeof data!.flags_amber).toBe('number');
  });
});
