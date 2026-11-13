/**
 * Helpers for the import tests: synthetic Shopify exports with order numbers that
 * are unique to each test run, and a client for the import-batch Edge Function.
 */
import {
  buildImportPayload,
  sampleRows,
  sha256Hex,
  SAMPLE_ORDERS,
  SHOPIFY_COLUMNS,
  toCSV,
  type CsvRow,
  type ImportPayload,
  type SampleOrder,
} from '@happyhome/core/import';
import pg from 'pg';
import { adminClient, type Client } from './clients';
import { testEnv } from './env';

const enc = new TextEncoder();

/** Three digits from the run id, so each run has its own phone numbers. */
function runDigits(run: string): string {
  let h = 0;
  for (const ch of run) h = (h * 31 + ch.charCodeAt(0)) % 1000;
  return String(h).padStart(3, '0');
}

/**
 * The legacy sample orders with order numbers, Shopify ids, phones, emails and names
 * unique to this run. The relations between the samples stay the same (#2002 and #2007
 * still share an email that differs in case and spaces, #2006 and #2011 a phone…), but
 * shipments never match a customer from another test file (Phase 3 combines customers).
 */
export function runOrders(
  run: string,
  digits = runDigits(run),
): Record<keyof typeof SAMPLE_ORDERS, SampleOrder> {
  const out = {} as Record<keyof typeof SAMPLE_ORDERS, SampleOrder>;
  for (const [key, o] of Object.entries(SAMPLE_ORDERS) as [
    keyof typeof SAMPLE_ORDERS,
    SampleOrder,
  ][]) {
    out[key] = {
      ...o,
      name: `#${run}-${o.name.slice(1)}`,
      id: `${run}${o.id}`,
      phone: o.phone.replace('000', digits),
      email: o.email.replace('@', `+${run}@`),
      recipient: `${o.recipient} ${run}`,
    };
  }
  return out;
}

export function csvOf(
  orders: SampleOrder[],
  columns: readonly string[] = SHOPIFY_COLUMNS,
  delimiter = ',',
  eol = String.fromCharCode(10),
): Uint8Array {
  return enc.encode(
    toCSV(
      columns,
      orders.flatMap((o) => sampleRows(o)),
      delimiter,
      eol,
    ),
  );
}

/** A CSV of hand-edited rows (e.g. a fulfilled order, a prepaid order). */
export function rowsCsv(rows: CsvRow[], columns: readonly string[] = SHOPIFY_COLUMNS): Uint8Array {
  return enc.encode(toCSV(columns, rows, ',', String.fromCharCode(10)));
}

export async function payloadOf(name: string, bytes: Uint8Array): Promise<ImportPayload> {
  const r = buildImportPayload({ name, bytes, sha256: await sha256Hex(bytes) });
  if (!r.ok) throw new Error(`${name} is not importable`);
  return r.payload;
}

export interface ImportResponse {
  status: number;
  body: {
    ok?: boolean;
    error?: string;
    batch?: { id: string; file_name: string; created_at: string } | null;
    result?: {
      batch_id: string;
      new: number;
      updated: number;
      unchanged: number;
      skipped: number;
      to_check: number;
    };
  };
}

/** POSTs a file + its payload to the import-batch Edge Function as the given user. */
export async function postImport(
  client: Client | null,
  name: string,
  bytes: Uint8Array,
  payload?: ImportPayload | Record<string, unknown>,
): Promise<ImportResponse> {
  const env = testEnv();
  const form = new FormData();
  form.append('file', new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'text/csv' }), name);
  form.append('payload', JSON.stringify(payload ?? (await payloadOf(name, bytes))));
  const headers: Record<string, string> = { apikey: env.publishableKey };
  if (client) {
    const { data } = await client.auth.getSession();
    if (data.session) headers.Authorization = `Bearer ${data.session.access_token}`;
  }
  const res = await fetch(`${env.url}/functions/v1/import-batch`, {
    method: 'POST',
    headers,
    body: form,
  });
  const text = await res.text();
  let body: ImportResponse['body'];
  try {
    body = JSON.parse(text) as ImportResponse['body'];
  } catch {
    body = { error: text };
  }
  return { status: res.status, body };
}

/** Removes everything a test run imported (orders by name prefix, batches by id, raw files). */
export async function cleanUpRun(run: string, batchIds: string[]): Promise<void> {
  const admin = adminClient();
  const { data: orders } = await admin.from('orders').select('id').like('name', `#${run}-%`);
  const orderIds = (orders ?? []).map((o) => o.id);
  if (orderIds.length) {
    const { data: links } = await admin
      .from('shipment_orders')
      .select('shipment_id')
      .in('order_id', orderIds);
    const shipmentIds = [...new Set((links ?? []).map((l) => l.shipment_id))];
    if (shipmentIds.length) await admin.from('shipments').delete().in('id', shipmentIds);
    await admin.from('orders').delete().in('id', orderIds);
  }
  if (batchIds.length) {
    const { data: batches } = await admin
      .from('import_batches')
      .select('storage_path')
      .in('id', batchIds);
    const paths = (batches ?? []).flatMap((b) => (b.storage_path ? [b.storage_path] : []));
    if (paths.length) await admin.storage.from('raw-imports').remove(paths);
    await admin.from('import_batches').delete().in('id', batchIds);
  }
}

/** Direct database access (postgres role) for things the API must not allow, e.g. ageing a batch. */
export async function withDb<T>(fn: (db: pg.Client) => Promise<T>): Promise<T> {
  const db = new pg.Client({ connectionString: testEnv().dbUrl });
  await db.connect();
  try {
    return await fn(db);
  } finally {
    await db.end();
  }
}

/** Makes a batch look `days` old (created_at is protected by a trigger, so bypass it here). */
export async function ageBatch(batchId: string, days: number): Promise<void> {
  await withDb(async (db) => {
    await db.query('begin');
    await db.query('alter table public.import_batches disable trigger set_row_meta');
    await db.query(
      `update public.import_batches set created_at = now() - make_interval(days => $2) where id = $1`,
      [batchId, days],
    );
    await db.query('alter table public.import_batches enable trigger set_row_meta');
    await db.query('commit');
  });
}
