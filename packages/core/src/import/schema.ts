/**
 * Shopify order-export columns and the legacy converter's shipping layout.
 * Ported from the Core module of /legacy/shopify-shipping-converter.html ("Schema").
 * Keep these lists identical to the legacy tool: the parity tests compare them.
 */

/** Reference list of Shopify order-export columns (used to report what was left out on purpose). */
export const SHOPIFY_COLUMNS: readonly string[] = [
  'Name',
  'Email',
  'Financial Status',
  'Paid at',
  'Fulfillment Status',
  'Fulfilled at',
  'Accepts Marketing',
  'Currency',
  'Subtotal',
  'Shipping',
  'Taxes',
  'Total',
  'Discount Code',
  'Discount Amount',
  'Shipping Method',
  'Created at',
  'Lineitem quantity',
  'Lineitem name',
  'Lineitem price',
  'Lineitem compare at price',
  'Lineitem sku',
  'Lineitem requires shipping',
  'Lineitem taxable',
  'Lineitem fulfillment status',
  'Billing Name',
  'Billing Street',
  'Billing Address1',
  'Billing Address2',
  'Billing Company',
  'Billing City',
  'Billing Zip',
  'Billing Province',
  'Billing Country',
  'Billing Phone',
  'Shipping Name',
  'Shipping Street',
  'Shipping Address1',
  'Shipping Address2',
  'Shipping Company',
  'Shipping City',
  'Shipping Zip',
  'Shipping Province',
  'Shipping Country',
  'Shipping Phone',
  'Notes',
  'Note Attributes',
  'Cancelled at',
  'Payment Method',
  'Payment Reference',
  'Refunded Amount',
  'Vendor',
  'Outstanding Balance',
  'Employee',
  'Location',
  'Device ID',
  'Id',
  'Tags',
  'Risk Level',
  'Source',
  'Lineitem discount',
  'Tax 1 Name',
  'Tax 1 Value',
  'Tax 2 Name',
  'Tax 2 Value',
  'Tax 3 Name',
  'Tax 3 Value',
  'Tax 4 Name',
  'Tax 4 Value',
  'Tax 5 Name',
  'Tax 5 Value',
  'Phone',
  'Receipt Number',
  'Duties',
  'Billing Province Name',
  'Shipping Province Name',
  'Payment ID',
  'Payment Terms Name',
  'Next Payment Due At',
  'Payment References',
];

export type ColumnType = 'text' | 'money' | 'int';
/**
 * id = identifier repeated on every product row of the same order;
 * line = value of that product row; order = order detail (only on the order's first row).
 */
export type ColumnScope = 'id' | 'line' | 'order';

export interface OutputColumn {
  /** Shopify column read from the file */
  name: string;
  type: ColumnType;
  scope: ColumnScope;
  required: boolean;
  /** column width in the workbook (characters) */
  width: number;
  /** heading written in the workbook (defaults to name) */
  label: string;
}

function C(
  name: string,
  type: ColumnType,
  scope: ColumnScope,
  required: boolean,
  width: number,
  label?: string,
): OutputColumn {
  return { name, type, scope, required, width, label: label || name };
}

/** The legacy shipping layout: 18 columns, in output order. */
export const OUTPUT: readonly OutputColumn[] = [
  C('Name', 'text', 'id', true, 12, 'order_id'),
  C('Lineitem name', 'text', 'line', true, 36),
  C('Lineitem price', 'money', 'line', false, 11),
  C('Shipping City', 'text', 'order', true, 16),
  C('Shipping Address1', 'text', 'order', true, 30),
  C('Shipping Address2', 'text', 'order', true, 24),
  C('Shipping Name', 'text', 'id', true, 18),
  C('Shipping Phone', 'text', 'order', true, 18),
  C('Shipping Zip', 'text', 'order', true, 11),
  C('Currency', 'text', 'order', true, 12),
  C('Subtotal', 'money', 'order', false, 11),
  C('Shipping', 'money', 'order', false, 11),
  C('Total', 'money', 'order', true, 11),
  C('Email', 'text', 'id', true, 26),
  C('Fulfillment Status', 'text', 'order', true, 13),
  C('Payment Method', 'text', 'order', true, 18),
  C('Lineitem sku', 'text', 'line', true, 22),
  C('Lineitem quantity', 'int', 'line', true, 11),
];
export const NOUT = OUTPUT.length;

/** Read from the file only for warnings, grouping and search — NOT written to the workbook. */
export const CHECK_ONLY: readonly string[] = [
  'Billing Phone',
  'Financial Status',
  'Outstanding Balance',
  'Cancelled at',
  'Shipping Country',
  'Shipping Company',
  'Notes',
  'Note Attributes',
  'Phone',
  'Payment Terms Name',
  'Lineitem requires shipping',
  'Id',
];

/** First NOUT entries = workbook columns. */
export const READ: readonly string[] = OUTPUT.map((c) => c.name).concat(CHECK_ONLY);
export const HOME_COUNTRY = 'BG';
export const PHOTO_HEADER = 'Product Photo';
export const ESSENTIAL: readonly string[] = ['Name', 'Lineitem name', 'Lineitem quantity'];

/** Shopify leaves these blank on the extra product rows of an order; all blank = continuation row. */
export const PROBES: readonly string[] = [
  'Financial Status',
  'Fulfillment Status',
  'Currency',
  'Subtotal',
  'Total',
  'Shipping Method',
  'Shipping Name',
  'Shipping Address1',
  'Shipping City',
  'Billing Name',
  'Payment Method',
  'Outstanding Balance',
  'Id',
  'Accepts Marketing',
  'Source',
  'Risk Level',
];

/** Columns Shopify fills on every product row (not order details). */
export const LINE_LEVEL: readonly string[] = [
  'Name',
  'Email',
  'Created at',
  'Lineitem quantity',
  'Lineitem name',
  'Lineitem price',
  'Lineitem compare at price',
  'Lineitem sku',
  'Lineitem requires shipping',
  'Lineitem taxable',
  'Lineitem fulfillment status',
  'Vendor',
  'Lineitem discount',
];

/** Shopify writes a leading apostrophe so spreadsheets keep these as text. */
export const STRIP_APOSTROPHE: readonly string[] = [
  'Shipping Zip',
  'Shipping Phone',
  'Billing Phone',
  'Phone',
];

const ALIASES: Readonly<Record<string, string>> = {
  canceledat: 'cancelledat',
  paymentterms: 'paymenttermsname',
};

/** Normalized column heading: BOM removed, lower case, letters and digits only, aliases applied. */
export function norm(h: unknown): string {
  const k = String(h == null ? '' : h)
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
  return ALIASES[k] || k;
}

function indexOf(list: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  list.forEach((n, i) => {
    out[n] = i;
  });
  return out;
}

/** Position of each READ column in a line's `out` array. */
export const COL: Readonly<Record<string, number>> = indexOf(READ);

/** normalized heading -> Shopify column name, for every known Shopify column */
export const KNOWN: Readonly<Record<string, string>> = Object.fromEntries(
  SHOPIFY_COLUMNS.map((h) => [norm(h), h]),
);
export const LINE_SET: Readonly<Record<string, true>> = Object.fromEntries(
  LINE_LEVEL.map((h) => [norm(h), true as const]),
);
export const OUT_SET: Readonly<Record<string, true>> = Object.fromEntries(
  OUTPUT.map((c) => [norm(c.name), true as const]),
);

/** Position of a READ column (throws on a typo: these are compile-time constants). */
export function col(name: string): number {
  const i = COL[name];
  if (i === undefined) throw new Error(`Unknown column ${name}`);
  return i;
}
