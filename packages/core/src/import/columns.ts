/**
 * Which columns the batch view and the Excel export show (P2-09 … P2-13).
 * Only the view and the export follow this setting; what is stored and what the
 * app's logic uses never change.
 */
import type { ExportRow } from './convert';
import { LEGACY_XLSX_COLUMNS, PHOTO_WIDTH, type XlsxColumn } from './xlsx';
import { OUTPUT, PHOTO_HEADER, SHOPIFY_COLUMNS, norm, type ColumnType } from './schema';

/** Default set: Product Photo + the legacy 18 shipping columns, in the legacy order. Nothing hidden. */
export const DEFAULT_VISIBLE_COLUMNS: readonly string[] = [
  PHOTO_HEADER,
  ...OUTPUT.map((c) => c.name),
];

const OUTPUT_INDEX = new Map(OUTPUT.map((c, i) => [c.name, i]));

const MONEY_COLUMNS = new Set([
  'Subtotal',
  'Shipping',
  'Taxes',
  'Total',
  'Discount Amount',
  'Refunded Amount',
  'Outstanding Balance',
  'Lineitem price',
  'Lineitem compare at price',
  'Lineitem discount',
  'Duties',
  'Tax 1 Value',
  'Tax 2 Value',
  'Tax 3 Value',
  'Tax 4 Value',
  'Tax 5 Value',
]);

const WIDE_COLUMNS: Readonly<Record<string, number>> = {
  Notes: 40,
  'Note Attributes': 40,
  Tags: 24,
  'Shipping Method': 22,
  'Created at': 20,
};

/** Heading in the view and the workbook: legacy label (Name -> "order_id"), else the column name. */
export function columnHeader(name: string): string {
  const i = OUTPUT_INDEX.get(name);
  return i === undefined ? name : OUTPUT[i]!.label;
}

export function columnType(name: string): ColumnType | 'photo' {
  if (name === PHOTO_HEADER) return 'photo';
  const i = OUTPUT_INDEX.get(name);
  if (i !== undefined) return OUTPUT[i]!.type;
  return MONEY_COLUMNS.has(name) ? 'money' : 'text';
}

/** The value of one column on one product row (legacy rules for the legacy columns). */
export function cellValue(row: ExportRow, column: string): string {
  if (column === PHOTO_HEADER) return '';
  const i = OUTPUT_INDEX.get(column);
  if (i !== undefined) return row.values[i + 1] ?? '';
  const raw = row.line.raw?.[column] ?? '';
  // Shopify's leading apostrophe only tells spreadsheets "keep as text".
  return /(zip|phone)$/i.test(column) && raw.startsWith("'") ? raw.slice(1) : raw;
}

/** The saved setting, cleaned: strings only, no repeats. Missing or broken -> the default set. */
export function normalizeVisibleColumns(value: unknown): string[] {
  if (!Array.isArray(value)) return [...DEFAULT_VISIBLE_COLUMNS];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of value) {
    if (typeof v !== 'string' || !v.trim() || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/** `hidden_columns` kept for compatibility: the default columns that are not shown. */
export function hiddenColumnsFor(visible: readonly string[]): string[] {
  return DEFAULT_VISIBLE_COLUMNS.filter((c) => !visible.includes(c));
}

/**
 * Every column the owner can choose from: the default set, then every column
 * found in the imported files (Shopify order first, then other headings in the
 * order they were first seen). Columns already chosen come first, in their order.
 */
export function columnCatalog(
  foundInFiles: readonly (readonly string[])[],
  visible: readonly string[] = DEFAULT_VISIBLE_COLUMNS,
): string[] {
  const found = new Set(foundInFiles.flat());
  const known = SHOPIFY_COLUMNS.filter((c) => found.has(c));
  const knownNorm = new Set(SHOPIFY_COLUMNS.map(norm));
  const other = [...found].filter((c) => !knownNorm.has(norm(c)));
  const all = [...visible, ...DEFAULT_VISIBLE_COLUMNS, ...known, ...other];
  return [...new Set(all)];
}

/** Workbook columns for the owner's setting (legacy widths and types where known). */
export function xlsxColumnsFor(visible: readonly string[]): XlsxColumn[] {
  return visible.map((name) => {
    if (name === PHOTO_HEADER) return LEGACY_XLSX_COLUMNS[0]!;
    const i = OUTPUT_INDEX.get(name);
    if (i !== undefined) return LEGACY_XLSX_COLUMNS[i + 1]!;
    const type = columnType(name);
    return {
      header: name,
      type,
      width: WIDE_COLUMNS[name] ?? (type === 'money' ? 11 : 16),
      value: (r: ExportRow) => cellValue(r, name),
    };
  });
}

export { PHOTO_HEADER, PHOTO_WIDTH };
