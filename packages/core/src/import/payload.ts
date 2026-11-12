/**
 * One Shopify CSV file -> the payload the import Edge Function writes in one
 * transaction: typed order fields, every column as raw text, the lines, and
 * every check result as a flag (bg + en text, reason, source row).
 *
 * The app converts each file on its own (one file = one batch). Orders that
 * appear again in a later file are matched in the database, not here.
 */
import { convert, g, phoneMatchKey, type ConvertResult, type Issue, type Order } from './convert';
import { hashBytes } from './csv';
import {
  parseBool,
  parseMoneyCents,
  parseNoteAttributes,
  parseQuantity,
  parseShopifyDate,
  normalizeEmail,
  textOrNull,
  type NoteAttribute,
} from './fields';
import {
  FLAG_SEVERITY_OF,
  issueReason,
  issueText,
  type IssueCode,
  type IssueParams,
} from './messages';
import { COD_RE } from './convert';
import { KNOWN, col, norm } from './schema';

export const IMPORT_PAYLOAD_VERSION = 1;

export type ImportFlagSeverity = 'red' | 'amber' | 'info';

export interface ImportFlag {
  severity: ImportFlagSeverity;
  code: IssueCode;
  message_bg: string;
  message_en: string;
  reason_bg: string;
  reason_en: string;
  /** same issue on the same order -> same key, across files (row numbers left out) */
  issue_key: string;
  source_row: number | null;
  details: { params: IssueParams; rows: string; seq: number; order: string };
}

export interface ImportLine {
  line_no: number;
  source_row: number;
  name: string;
  sku: string | null;
  quantity: number | null;
  price_cents: number | null;
  requires_shipping: boolean | null;
  raw: Record<string, string>;
}

export interface ImportOrderFields {
  created_at_shopify: string | null;
  email: string | null;
  email_norm: string | null;
  phone_raw: string | null;
  phone_norm: string | null;
  billing_phone: string | null;
  customer_phone: string | null;
  shipping_name: string | null;
  shipping_company: string | null;
  shipping_address1: string | null;
  shipping_address2: string | null;
  shipping_city: string | null;
  shipping_zip: string | null;
  shipping_province: string | null;
  shipping_country: string | null;
  shipping_method: string | null;
  payment_method: string | null;
  is_cod: boolean;
  financial_status: string | null;
  fulfillment_status: string | null;
  currency: string;
  subtotal_cents: number | null;
  shipping_cents: number | null;
  total_cents: number | null;
  outstanding_cents: number | null;
  discount_cents: number | null;
  refunded_cents: number | null;
  notes: string | null;
  note_attributes: NoteAttribute[];
  tags: string | null;
  payment_terms: string | null;
  cancelled_at: string | null;
}

export interface ImportOrder {
  shopify_id: string | null;
  name: string;
  first_row: number;
  fields: ImportOrderFields;
  /** every column of the order's first row, untouched (column name -> text) */
  raw: Record<string, string>;
  lines: ImportLine[];
  flags: ImportFlag[];
}

export type SkipReason = 'no_order_number' | 'orphan_rows' | 'repeated_copy';

export interface SkippedOrder {
  name: string;
  first_row: number;
  reason: SkipReason;
}

export interface ImportFileInfo {
  name: string;
  size: number;
  sha256: string;
  /** legacy FNV-1a hash */
  fnv: string;
  encoding: string;
  delimiter: string;
  row_count: number;
  product_rows: number;
  /** column names in file order (Shopify spelling for known columns) */
  columns: string[];
}

export interface ImportPayload {
  version: typeof IMPORT_PAYLOAD_VERSION;
  file: ImportFileInfo;
  orders: ImportOrder[];
  skipped: SkippedOrder[];
  /** issues about the file itself, and rows that are not an importable order */
  batch_flags: ImportFlag[];
}

export type PrepareResult =
  | { ok: true; payload: ImportPayload; result: ConvertResult }
  /** The file could not be read as a Shopify export: nothing to import. */
  | { ok: false; flags: ImportFlag[]; result: ConvertResult };

/** Column name used in raw maps: the Shopify spelling for known columns, else the heading as written. */
export function canonicalColumn(heading: string): string | null {
  const k = norm(heading);
  if (!k) return null;
  return KNOWN[k] ?? heading.trim();
}

const UNSTABLE_PARAMS = new Set(['row', 'rows', 'places']);

export function issueKey(code: IssueCode, params: IssueParams): string {
  const stable = Object.fromEntries(
    Object.entries(params).filter(([k]) => !UNSTABLE_PARAMS.has(k)),
  );
  return code + ':' + hashBytes(new TextEncoder().encode(JSON.stringify(stable)));
}

function firstNumber(s: string): number | null {
  const m = /\d+/.exec(s);
  return m ? Number(m[0]) : null;
}

export function flagFromIssue(is: Issue, fallbackRow?: number): ImportFlag {
  const params = is.params as Record<string, unknown>;
  const row =
    typeof params.row === 'number' ? params.row : (firstNumber(is.rows) ?? fallbackRow ?? null);
  return {
    severity: FLAG_SEVERITY_OF[is.sev],
    code: is.code,
    message_bg: issueText(is.code, is.params as never, 'bg'),
    message_en: issueText(is.code, is.params as never, 'en'),
    reason_bg: issueReason(is.code, 'bg'),
    reason_en: issueReason(is.code, 'en'),
    issue_key: issueKey(is.code, is.params),
    source_row: row,
    details: { params: is.params, rows: is.rows, seq: is.i ?? 0, order: is.order },
  };
}

function rawMapper(header: readonly string[]) {
  const seen = new Set<string>();
  const keys = header.map((h) => {
    const key = canonicalColumn(h);
    if (!key || seen.has(norm(h))) return null; // repeated heading: the first one is used
    seen.add(norm(h));
    return key;
  });
  return {
    columns: keys.filter((k): k is string => k !== null),
    raw(cells: readonly string[]): Record<string, string> {
      const out: Record<string, string> = {};
      keys.forEach((k, i) => {
        if (k) out[k] = cells[i] ?? '';
      });
      return out;
    },
  };
}

function orderFields(o: Order, raw: Record<string, string>): ImportOrderFields {
  const t = (name: string) => textOrNull(g(o, name));
  const r = (name: string) => textOrNull(raw[name]);
  const phone = g(o, 'Shipping Phone');
  return {
    created_at_shopify: parseShopifyDate(raw['Created at']),
    email: t('Email'),
    email_norm: normalizeEmail(g(o, 'Email')),
    phone_raw: textOrNull(phone),
    phone_norm: phoneMatchKey(phone) || null,
    billing_phone: t('Billing Phone'),
    customer_phone: t('Phone'),
    shipping_name: t('Shipping Name'),
    shipping_company: t('Shipping Company'),
    shipping_address1: t('Shipping Address1'),
    shipping_address2: t('Shipping Address2'),
    shipping_city: t('Shipping City'),
    shipping_zip: t('Shipping Zip'),
    shipping_province: r('Shipping Province'),
    shipping_country: t('Shipping Country'),
    shipping_method: r('Shipping Method'),
    payment_method: t('Payment Method'),
    is_cod: COD_RE.test(g(o, 'Payment Method')),
    financial_status: t('Financial Status'),
    fulfillment_status: t('Fulfillment Status'),
    currency: g(o, 'Currency') || 'EUR',
    subtotal_cents: parseMoneyCents(g(o, 'Subtotal')),
    shipping_cents: parseMoneyCents(g(o, 'Shipping')),
    total_cents: parseMoneyCents(g(o, 'Total')),
    outstanding_cents: parseMoneyCents(g(o, 'Outstanding Balance')),
    discount_cents: parseMoneyCents(raw['Discount Amount']),
    refunded_cents: parseMoneyCents(raw['Refunded Amount']),
    notes: t('Notes'),
    note_attributes: parseNoteAttributes(g(o, 'Note Attributes')),
    tags: r('Tags'),
    payment_terms: t('Payment Terms Name'),
    cancelled_at: parseShopifyDate(g(o, 'Cancelled at')),
  };
}

function pushUnique(list: ImportFlag[], flag: ImportFlag) {
  if (!list.some((f) => f.issue_key === flag.issue_key)) list.push(flag);
}

/** Converts one file with the legacy logic and builds the import payload. */
export function buildImportPayload(file: {
  name: string;
  bytes: Uint8Array;
  sha256: string;
}): PrepareResult {
  const result = convert([{ id: 1, name: file.name, bytes: file.bytes }]);
  const f = result.files[0]!;
  if (!f.processed || !f.header) {
    return { ok: false, flags: f.issues.map((is) => flagFromIssue(is)), result };
  }
  const mapper = rawMapper(f.header);

  // The importable copy of each order number: the first "normal" one in the file.
  const imported = new Map<Order, ImportOrder>();
  const byName = new Map<string, ImportOrder>();
  const skipped: SkippedOrder[] = [];
  const batchFlags: ImportFlag[] = f.issues.map((is) => flagFromIssue(is));

  for (const o of result.orders) {
    if (o.kind === 'noid' || o.kind === 'orphan') {
      skipped.push({
        name: o.name,
        first_row: o.firstRow,
        reason: o.kind === 'noid' ? 'no_order_number' : 'orphan_rows',
      });
      o.issues.forEach((is) => batchFlags.push(flagFromIssue(is, o.firstRow)));
      continue;
    }
    if (byName.has(o.name)) {
      skipped.push({ name: o.name, first_row: o.firstRow, reason: 'repeated_copy' });
      continue;
    }
    const raw = mapper.raw(o.firstCells);
    const order: ImportOrder = {
      shopify_id: textOrNull(g(o, 'Id')),
      name: o.name,
      first_row: o.firstRow,
      fields: orderFields(o, raw),
      raw,
      lines: o.lines.map((l, i) => ({
        line_no: i + 1,
        source_row: l.row,
        name: (l.out[col('Lineitem name')] ?? '').trim(),
        sku: textOrNull(l.out[col('Lineitem sku')]),
        quantity: parseQuantity(l.out[col('Lineitem quantity')]),
        price_cents: parseMoneyCents(l.out[col('Lineitem price')]),
        requires_shipping: parseBool(l.out[col('Lineitem requires shipping')]),
        raw: mapper.raw(l.cells),
      })),
      flags: [],
    };
    o.issues.forEach((is) => pushUnique(order.flags, flagFromIssue(is, o.firstRow)));
    if (o.dupIssue) pushUnique(order.flags, flagFromIssue(o.dupIssue, o.firstRow));
    imported.set(o, order);
    byName.set(o.name, order);
  }

  // Customer-group issues go on every imported order they are about.
  for (const grp of result.groups) {
    for (const is of grp.issues) {
      const named = is.order ? is.order.split(', ') : null;
      for (const o of grp.orders) {
        const order = imported.get(o);
        if (!order || (named && !named.includes(o.name))) continue;
        pushUnique(order.flags, flagFromIssue(is, o.firstRow));
      }
    }
  }

  const orders = [...imported.values()];
  // A file that ends inside quotes: its last order may be cut off.
  const lastOrder = result.orders.at(-1);
  if (f.unterminated && lastOrder && imported.has(lastOrder)) {
    const order = imported.get(lastOrder)!;
    const params = {} as Record<string, never>;
    pushUnique(order.flags, {
      severity: 'red',
      code: 'FILE_TRUNCATED_ORDER',
      message_bg: issueText('FILE_TRUNCATED_ORDER', params, 'bg'),
      message_en: issueText('FILE_TRUNCATED_ORDER', params, 'en'),
      reason_bg: issueReason('FILE_TRUNCATED_ORDER', 'bg'),
      reason_en: issueReason('FILE_TRUNCATED_ORDER', 'en'),
      issue_key: issueKey('FILE_TRUNCATED_ORDER', params),
      source_row: order.first_row,
      details: { params, rows: String(order.first_row), seq: -1, order: order.name },
    });
  }

  return {
    ok: true,
    result,
    payload: {
      version: IMPORT_PAYLOAD_VERSION,
      file: {
        name: file.name,
        size: file.bytes.length,
        sha256: file.sha256,
        fnv: hashBytes(file.bytes),
        encoding: f.encoding,
        delimiter: f.delimiter,
        row_count: f.dataRows,
        product_rows: f.productRows,
        columns: mapper.columns,
      },
      orders,
      skipped,
      batch_flags: batchFlags,
    },
  };
}
