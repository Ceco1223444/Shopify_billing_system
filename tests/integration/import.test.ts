/**
 * Phase 2 import, through the real import-batch Edge Function and database:
 * T2-03 same file twice, T2-04 overlapping exports, T2-05 changed order,
 * T2-06 cancelled order, T2-07 packer rejected, plus what is stored.
 */
import { phoneMatchKey, SHOPIFY_COLUMNS, type SampleOrder } from '@happyhome/core/import';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminClient, anonClient, signedInClient, type Client } from '../support/clients';
import { cleanUpRun, csvOf, payloadOf, postImport, runOrders } from '../support/imports';
import { uniq } from '../support/schema';
import { ensureTestUsers, TEST_USERS } from '../support/users';

const run = uniq('t')
  .replace(/[^a-z0-9]/gi, '')
  .slice(-10);
const O = runOrders(run);
const batchIds: string[] = [];
const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const BOM = String.fromCharCode(0xfeff);

let owner: Client;
let packer: Client;
let outsider: Client;
let ownerId: string;

beforeAll(async () => {
  const ids = await ensureTestUsers();
  ownerId = ids.owner;
  owner = await signedInClient(TEST_USERS.owner.email, TEST_USERS.owner.password);
  packer = await signedInClient(TEST_USERS.packer.email, TEST_USERS.packer.password);
  outsider = await signedInClient(TEST_USERS.outsider.email, TEST_USERS.outsider.password);
});

afterAll(async () => {
  await cleanUpRun(run, batchIds);
});

async function importOk(name: string, orders: SampleOrder[]) {
  const res = await postImport(owner, name, csvOf(orders));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  batchIds.push(res.body.result!.batch_id);
  return res.body.result!;
}

async function orderByName(name: string) {
  const { data, error } = await adminClient()
    .from('orders')
    .select('*, order_lines(*)')
    .eq('name', name)
    .single();
  if (error) throw error;
  return data;
}

/** The shipment the import put the order in (Phase 3 builds one for every shippable order). */
async function shipmentOf(orderId: string): Promise<string> {
  const { data, error } = await adminClient()
    .from('shipment_orders')
    .select('shipment_id')
    .eq('order_id', orderId)
    .single();
  if (error) throw error;
  return data.shipment_id;
}

async function flagsOf(orderId: string) {
  const { data } = await adminClient().from('flags').select('*').eq('order_id', orderId);
  return data ?? [];
}

describe('importing a file (owner)', () => {
  it('stores the batch, the raw file, typed columns, every raw column and the check flags', async () => {
    const result = await importOk('week-1.csv', [O.o2001, O.o2002, O.o2005, O.o2006]);
    expect(result).toMatchObject({ new: 4, updated: 0, unchanged: 0, skipped: 0 });

    const { data: batch } = await owner
      .from('import_batches')
      .select('*')
      .eq('id', result.batch_id)
      .single();
    expect(batch).toMatchObject({
      file_name: 'week-1.csv',
      uploaded_by: ownerId,
      orders_new: 4,
      status: 'imported',
      archive_state: 'stored',
      encoding: 'UTF-8',
    });
    expect(batch!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(batch!.columns).toContain('Shipping Method');
    const { data: file } = await owner.storage.from('raw-imports').download(batch!.storage_path!);
    expect(file?.size).toBe(batch!.file_size_bytes);

    const o = await orderByName(O.o2002.name);
    expect(o).toMatchObject({
      shopify_id: O.o2002.id,
      phone_raw: O.o2002.phone,
      phone_norm: phoneMatchKey(O.o2002.phone),
      email_norm: O.o2002.email.trim().toLowerCase(),
      total_cents: 4498,
      is_cod: true,
      shipping_zip: '4000',
      first_import_batch_id: result.batch_id,
      updated_by: ownerId,
    });
    expect((o.raw as Record<string, string>)['Shipping Zip']).toBe("'4000");
    expect(Object.keys(o.raw as object)).toHaveLength(79);
    expect(o.order_lines).toHaveLength(1);

    const flags = await flagsOf((await orderByName(O.o2005.name)).id);
    const abroad = flags.find((f) => f.code === 'SHIPS_ABROAD');
    expect(abroad).toMatchObject({
      severity: 'amber',
      message_bg: 'Доставка в чужбина: IT.',
      source_batch_id: result.batch_id,
      origin: 'import_check',
    });
    expect(abroad!.source_row).toBeGreaterThan(1);
    expect(abroad!.reason_bg).toBeTruthy();

    const { data: fileFlags } = await adminClient()
      .from('flags')
      .select('code, severity')
      .eq('import_batch_id', result.batch_id);
    expect(fileFlags?.map((f) => f.code)).toContain('APOSTROPHES_REMOVED');
  });

  it('T2-03: refuses the same file twice', async () => {
    const bytes = csvOf([O.o2003]);
    const first = await postImport(owner, 'same.csv', bytes);
    expect(first.status).toBe(200);
    batchIds.push(first.body.result!.batch_id);
    const again = await postImport(owner, 'renamed-copy.csv', bytes);
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({
      error: 'duplicate_file',
      batch: { id: first.body.result!.batch_id, file_name: 'same.csv' },
    });
    const { count } = await adminClient()
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('name', O.o2003.name);
    expect(count).toBe(1);
  });

  it('T2-04: overlapping exports never duplicate orders and count correctly', async () => {
    // week-1 already has #2001, #2002, #2005, #2006. This file repeats #2001 and #2002
    // (columns in another order, CRLF, semicolons) and adds #2007, #2008.
    const reversed = [...SHOPIFY_COLUMNS].reverse();
    const text = new TextDecoder().decode(
      csvOf([O.o2007, O.o2001, O.o2008, O.o2002], reversed, ';', CR + LF),
    );
    const bytes = new TextEncoder().encode(BOM + text);
    const res = await postImport(owner, 'week-2.csv', bytes);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    batchIds.push(res.body.result!.batch_id);
    expect(res.body.result).toMatchObject({ new: 2, unchanged: 2, updated: 0, skipped: 0 });

    const { data: orders } = await adminClient()
      .from('orders')
      .select('name')
      .like('name', `#${run}-%`);
    const names = (orders ?? []).map((o) => o.name);
    expect(new Set(names).size).toBe(names.length);
    const o2001 = await orderByName(O.o2001.name);
    expect(o2001.order_lines).toHaveLength(3);

    const { data: seen } = await owner
      .from('import_batch_orders')
      .select('outcome, batch_id')
      .eq('order_id', o2001.id)
      .order('created_at');
    expect(seen?.map((s) => s.outcome)).toEqual(['new', 'unchanged']);
    // An unchanged re-import adds no duplicate flags.
    const keys = (await flagsOf(o2001.id)).map((f) => f.issue_key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('T2-05: a changed order is updated, the diff goes to audit_log and an amber flag is created', async () => {
    const before = await orderByName(O.o2006.name);
    const changed: SampleOrder = { ...O.o2006, phone: '0888123456', notes: 'Звънете след 18:00' };
    const result = await importOk('week-3.csv', [changed, O.o2005]);
    expect(result).toMatchObject({ new: 0, updated: 1, unchanged: 1 });

    const after = await orderByName(O.o2006.name);
    expect(after.phone_raw).toBe('0888123456');
    expect(after.notes).toBe('Звънете след 18:00');
    expect(after.version).toBeGreaterThan(before.version);
    expect(after.last_import_batch_id).toBe(result.batch_id);

    const { data: link } = await owner
      .from('import_batch_orders')
      .select('outcome, diff')
      .eq('batch_id', result.batch_id)
      .eq('order_id', after.id)
      .single();
    expect(link!.outcome).toBe('updated');
    const diff = link!.diff as { fields: Record<string, { before: string; after: string }> };
    expect(diff.fields['Shipping Phone']).toEqual({ before: O.o2006.phone, after: '0888123456' });
    expect(Object.keys(diff.fields)).toContain('Notes');

    const { data: audit } = await owner
      .from('audit_log')
      .select('actor, before, after, reason')
      .eq('table_name', 'orders')
      .eq('row_id', after.id)
      .like('reason', 'shopify_reimport%');
    expect(audit).toHaveLength(1);
    expect(audit![0]!.actor).toBe(ownerId);
    expect(audit![0]!.after).toMatchObject({ fields: { 'Shipping Phone': '0888123456' } });

    const flags = await flagsOf(after.id);
    const changedFlag = flags.find((f) => f.code === 'ORDER_CHANGED_AFTER_IMPORT');
    expect(changedFlag).toMatchObject({ severity: 'amber', origin: 'import_change' });
    expect(changedFlag!.message_bg).toContain('Поръчката е променена в Shopify след внасянето');
    expect(changedFlag!.message_bg).toContain('Shipping Phone');
    // The old phone warning no longer applies: resolved, with the reason. The new note is flagged.
    const oldPhone = flags.find((f) => f.code === 'PHONE_CHECK');
    expect(oldPhone?.resolved_at).not.toBeNull();
    expect(oldPhone?.resolution_note).toContain('week-3.csv');
    expect(flags.find((f) => f.code === 'CUSTOMER_NOTE' && f.resolved_at === null)).toBeTruthy();
  });

  it('T2-05: the change flag is red when the order already has a waybill', async () => {
    const admin = adminClient();
    const o = await orderByName(O.o2008.name);
    await admin
      .from('shipments')
      .update({ status: 'waybill_created', carrier: 'econt', waybill_number: `T${run}` })
      .eq('id', await shipmentOf(o.id));

    await importOk('week-4.csv', [
      { ...O.o2008, a1: 'Офис Спиди – Варна Тест', city: 'Варна', zip: '9000' },
    ]);
    const flag = (await flagsOf(o.id)).find((f) => f.code === 'ORDER_CHANGED_AFTER_IMPORT');
    expect(flag?.severity).toBe('red');
    expect(flag?.message_bg).toContain('Вече има товарителница');
  });

  it('T2-06: an order cancelled in a later batch gets a red flag and its shipment is cancelled', async () => {
    const admin = adminClient();
    const o = await orderByName(O.o2007.name);
    // #2007 came in a later file than #2002 (same customer), so it has a shipment of its own.
    const shipment = { id: await shipmentOf(o.id) };

    const cancelled = { ...O.o2007, cancelled: '2026-11-08 10:00:00 +0200' };
    const result = await importOk('week-5.csv', [cancelled]);
    expect(result.updated).toBe(1);

    const after = await orderByName(O.o2007.name);
    expect(after.cancelled_at).not.toBeNull();
    const flags = await flagsOf(o.id);
    expect(flags.find((f) => f.code === 'ORDER_CANCELLED_AFTER_IMPORT')).toMatchObject({
      severity: 'red',
    });
    expect(flags.find((f) => f.code === 'CANCELLED' && f.resolved_at === null)?.severity).toBe(
      'red',
    );
    const { data: s } = await admin
      .from('shipments')
      .select('status, cancelled_at')
      .eq('id', shipment.id)
      .single();
    expect(s).toMatchObject({ status: 'cancelled' });
    expect(s!.cancelled_at).not.toBeNull();
  });

  it('T2-06: a shipment already handed over keeps its status; the red flag says so', async () => {
    const admin = adminClient();
    const o = await orderByName(O.o2001.name);
    const shipment = { id: await shipmentOf(o.id) };
    await admin
      .from('shipments')
      .update({ status: 'handed_over', carrier: 'econt', waybill_number: `H${run}` })
      .eq('id', shipment.id);

    await importOk('week-6.csv', [{ ...O.o2001, cancelled: '2026-11-09 10:00:00 +0200' }]);
    const { data: s } = await admin
      .from('shipments')
      .select('status')
      .eq('id', shipment.id)
      .single();
    expect(s!.status).toBe('handed_over');
    const flag = (await flagsOf(o.id)).find((f) => f.code === 'ORDER_CANCELLED_AFTER_IMPORT');
    expect(flag?.severity).toBe('red');
    expect(flag?.message_bg).toContain('вече е предадена');
  });
});

describe('T2-07: import is owner only', () => {
  it('rejects a packer, an outsider and a signed-out visitor', async () => {
    const bytes = csvOf([O.o2009]);
    expect((await postImport(packer, 'p.csv', bytes)).body).toEqual({ error: 'owner_only' });
    expect((await postImport(packer, 'p.csv', bytes)).status).toBe(403);
    expect((await postImport(outsider, 'p.csv', bytes)).body).toEqual({ error: 'not_a_member' });
    expect((await postImport(null, 'p.csv', bytes)).status).toBe(401);
    const { count } = await adminClient()
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('name', O.o2009.name);
    expect(count).toBe(0);
  });

  it('keeps batches, batch orders and raw files away from packers', async () => {
    const { data: batches } = await packer.from('import_batches').select('id');
    expect(batches).toEqual([]);
    const { data: links } = await packer.from('import_batch_orders').select('id');
    expect(links).toEqual([]);
    const { data: list } = await packer.storage.from('raw-imports').list('');
    expect(list ?? []).toEqual([]);
    const { error: uploadError } = await packer.storage
      .from('raw-imports')
      .upload(`${run}/x.csv`, new Blob(['a,b']), { contentType: 'text/csv' });
    expect(uploadError).not.toBeNull();
    // Packers still see the orders and their flags (they ship them).
    const { data: orders } = await packer.from('orders').select('id').like('name', `#${run}-%`);
    expect(orders?.length).toBeGreaterThan(0);
  });

  it('lets nobody but the Edge Function call import_commit', async () => {
    const payload = await payloadOf('direct.csv', csvOf([O.o2010]));
    for (const client of [owner, packer, anonClient()]) {
      const { error } = await client.rpc('import_commit', {
        p_actor: ownerId,
        p_batch_id: crypto.randomUUID(),
        p_storage_path: 'x',
        p_payload: payload as never,
      });
      expect(error).not.toBeNull();
    }
  });

  it('refuses a payload that does not belong to the uploaded file', async () => {
    const bytes = csvOf([O.o2010]);
    const payload = await payloadOf('x.csv', csvOf([O.o2011]));
    const res = await postImport(owner, 'x.csv', bytes, payload);
    expect(res).toMatchObject({ status: 400, body: { error: 'file_mismatch' } });
  });
});

describe('column setting never touches stored data (T2-08, database side)', () => {
  it('saving visible_columns changes only the setting', async () => {
    const before = await orderByName(O.o2002.name);
    const { data: setting } = await owner
      .from('settings')
      .select('value')
      .eq('key', 'visible_columns')
      .single();
    const { error } = await owner
      .from('settings')
      .update({ value: ['Created at', 'Name', 'Notes'] })
      .eq('key', 'visible_columns');
    expect(error).toBeNull();
    const after = await orderByName(O.o2002.name);
    expect(after.version).toBe(before.version);
    expect(after.raw).toEqual(before.raw);
    await owner.from('settings').update({ value: setting!.value }).eq('key', 'visible_columns');
  });

  it('packers cannot change the column setting', async () => {
    await packer.from('settings').update({ value: [] }).eq('key', 'visible_columns');
    const { data } = await adminClient()
      .from('settings')
      .select('value')
      .eq('key', 'visible_columns')
      .single();
    expect(data!.value).not.toEqual([]);
  });
});
