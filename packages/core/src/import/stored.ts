/**
 * Rebuilds legacy-style orders from what the database stores (orders.raw and
 * order_lines.raw), so the batch view and the Excel export use exactly the
 * legacy grouping, yellow rows and column rules, also after the raw CSV file
 * has been archived and removed from cloud storage.
 */
import {
  exportRows,
  groupCustomers,
  type ConvertCounts,
  type ExportRow,
  type Group,
  type Line,
  type Order,
} from './convert';
import { READ, STRIP_APOSTROPHE, OUTPUT, norm } from './schema';

export interface StoredLine {
  line_no: number;
  source_row: number | null;
  raw: Record<string, string>;
}

export interface StoredOrder {
  id: string;
  name: string;
  /** row of the order in the batch's file */
  first_row: number | null;
  raw: Record<string, string>;
  lines: StoredLine[];
}

const STRIP = new Set(STRIP_APOSTROPHE);
const ID_COLS = OUTPUT.flatMap((c, i) => (c.scope === 'id' ? [i] : []));

function readValues(raw: Record<string, string>): string[] {
  const byNorm = new Map(Object.entries(raw).map(([k, v]) => [norm(k), v]));
  return READ.map((name) => {
    const v = raw[name] ?? byNorm.get(norm(name)) ?? '';
    return STRIP.has(name) && v.charAt(0) === "'" ? v.slice(1) : v;
  });
}

export function rebuildOrders(stored: readonly StoredOrder[]): Order[] {
  const sorted = [...stored].sort(
    (a, b) =>
      (a.first_row ?? Number.MAX_SAFE_INTEGER) - (b.first_row ?? Number.MAX_SAFE_INTEGER) ||
      a.name.localeCompare(b.name),
  );
  return sorted.map((s, idx) => {
    const lines = [...s.lines].sort((a, b) => a.line_no - b.line_no);
    const firstRaw = lines[0]?.raw ?? s.raw;
    const first = readValues({ ...firstRaw, ...s.raw });
    const built: Line[] = lines.map((l, li) => {
      const out = li === 0 ? first.slice() : readValues(l.raw);
      const carried: number[] = [];
      if (li > 0) {
        for (const ci of ID_COLS) {
          if (!out[ci]!.trim() && first[ci]!.trim()) {
            out[ci] = first[ci]!;
            carried.push(ci);
          }
        }
      }
      return { out, row: l.source_row ?? 0, carried, cells: [], raw: l.raw };
    });
    if (!built.length)
      built.push({ out: first.slice(), row: s.first_row ?? 0, carried: [], cells: [], raw: s.raw });
    return {
      key: s.id,
      uid: idx + 1,
      seq: idx + 1,
      kind: 'normal',
      fileId: 'db',
      fileName: '',
      firstRow: s.first_row ?? 0,
      name: s.name,
      firstCells: [],
      first,
      lines: built,
      issues: [],
      excluded: false,
      dupIssue: null,
    } satisfies Order;
  });
}

export interface BatchView {
  orders: Order[];
  groups: Group[];
  rows: ExportRow[];
  counts: Pick<ConvertCounts, 'customers' | 'orders' | 'productRows'>;
}

/** Orders of one batch -> legacy rows (customer -> order -> products, yellow = multi). */
export function batchView(stored: readonly StoredOrder[]): BatchView {
  const orders = rebuildOrders(stored);
  const groups = groupCustomers(orders);
  const rows = exportRows(groups);
  return {
    orders,
    groups,
    rows,
    counts: { customers: groups.length, orders: orders.length, productRows: rows.length },
  };
}
