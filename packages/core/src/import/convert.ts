/**
 * Shopify CSV → orders, lines and issues. Ported from the legacy converter
 * ("readFile", "Checks", "Main conversion"). The behaviour is identical; the
 * port adds a machine `code` and `params` to every issue (for Bulgarian text and
 * database flags) and keeps each row's original cells (for orders.raw).
 */
import { decode, detectDelimiter, hashBytes, parseCSV, type Encoding } from './csv';
import {
  LEGACY_EN,
  type IssueCode,
  type IssueParamMap,
  type PhoneProblem,
  type Severity,
} from './messages';
import {
  CHECK_ONLY,
  COL,
  ESSENTIAL,
  HOME_COUNTRY,
  KNOWN,
  LINE_SET,
  NOUT,
  OUT_SET,
  OUTPUT,
  PROBES,
  READ,
  STRIP_APOSTROPHE,
  col,
  norm,
} from './schema';

export interface Issue<C extends IssueCode = IssueCode> {
  sev: Severity;
  code: C;
  params: IssueParamMap[C];
  /** legacy English text */
  msg: string;
  file: string;
  order: string;
  email: string;
  rows: string;
  /** position in the collected list (set by convert) */
  i?: number;
}

type IssueExtra = Partial<Pick<Issue, 'file' | 'order' | 'email' | 'rows'>>;

export function issue<C extends IssueCode>(
  sev: Severity,
  code: C,
  params: IssueParamMap[C],
  extra?: IssueExtra,
): Issue<C> {
  const o: Issue<C> = {
    sev,
    code,
    params,
    msg: LEGACY_EN[code](params),
    file: '',
    order: '',
    email: '',
    rows: '',
  };
  if (extra) Object.assign(o, extra);
  return o;
}

export interface FileInput {
  id: number | string;
  name: string;
  bytes: Uint8Array;
}

export interface Line {
  /** every READ field; only the first NOUT go into the workbook */
  out: string[];
  /** 1-based row number in the file */
  row: number;
  /** READ positions copied from the order's first row */
  carried: number[];
  /** the row's original cells (port only: kept for orders.raw) */
  cells: string[];
  /** port only: column name -> value, for lines rebuilt from the database */
  raw?: Record<string, string>;
}

export type OrderKind = 'normal' | 'noid' | 'orphan';

export interface Order {
  key: string;
  uid: number;
  seq: number;
  kind: OrderKind;
  fileId: number | string;
  fileName: string;
  firstRow: number;
  name: string;
  firstCells: string[];
  first: string[];
  lines: Line[];
  issues: Issue[];
  excluded: boolean;
  dupIssue: Issue | null;
  dupCount?: number;
}

export interface FileResult {
  id: number | string;
  name: string;
  issues: Issue[];
  orders: Order[];
  encoding: Encoding | '';
  delimiter: string;
  dataRows: number;
  productRows: number;
  blankRows: number;
  processed: boolean;
  missingRequired: string[];
  missingOptional: string[];
  leftOut: string[];
  unknown: string[];
  apostrophes: number;
  has?: Record<string, boolean>;
  /** port only: the heading row as in the file, and whether the file ends inside quotes */
  header?: string[];
  unterminated?: boolean;
}

export interface ReadContext {
  uid: number;
  seq: number;
}

// eslint-disable-next-line no-control-regex -- legacy behaviour: strips characters Excel cannot store
const INVALID_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/;

export function readFile(input: FileInput, ctx: ReadContext): FileResult {
  const f: FileResult = {
    id: input.id,
    name: input.name,
    issues: [],
    orders: [],
    encoding: '',
    delimiter: '',
    dataRows: 0,
    productRows: 0,
    blankRows: 0,
    processed: false,
    missingRequired: [],
    missingOptional: [],
    leftOut: [],
    unknown: [],
    apostrophes: 0,
  };
  function fileIssue<C extends IssueCode>(
    sev: Severity,
    code: C,
    params: IssueParamMap[C],
    rows?: string,
  ) {
    f.issues.push(issue(sev, code, params, { file: f.name, rows: rows || '' }));
  }
  const none = {} as Record<string, never>;

  const d = decode(input.bytes);
  if (d.error !== undefined) {
    fileIssue('error', d.code, none);
    return f;
  }
  f.encoding = d.encoding;
  if (d.note) fileIssue('warning', 'ENCODING_FALLBACK', none);
  const delim = detectDelimiter(d.text);
  f.delimiter = delim === '\t' ? 'tab' : delim;
  const parsed = parseCSV(d.text, delim);
  f.unterminated = parsed.unterminated;
  if (parsed.unterminated) fileIssue('error', 'UNTERMINATED_QUOTE', none);

  const recs = parsed.records;
  let h = 0;
  while (h < recs.length && recs[h]!.every((c) => c.trim() === '')) h++;
  if (h >= recs.length) {
    fileIssue('error', 'NO_HEADER', none);
    return f;
  }
  const header = recs[h]!;
  if (header.length < 3) {
    fileIssue('error', 'NO_COLUMNS', none);
    return f;
  }
  f.header = header;

  const idx: Record<string, number> = {};
  const dupHeads: string[] = [];
  header.forEach((name, i) => {
    const k = norm(name);
    if (!k) return;
    if (Object.prototype.hasOwnProperty.call(idx, k)) dupHeads.push(name.trim());
    else idx[k] = i;
  });
  const has = (k: string) => Object.prototype.hasOwnProperty.call(idx, k);
  if (dupHeads.length) fileIssue('warning', 'DUPLICATE_HEADINGS', { columns: dupHeads });
  const missingEssential = ESSENTIAL.filter((c) => !has(norm(c)));
  if (missingEssential.length) {
    fileIssue('error', 'NOT_SHOPIFY_EXPORT', { columns: missingEssential });
    return f;
  }
  f.processed = true;
  OUTPUT.forEach((c) => {
    if (!has(norm(c.name))) (c.required ? f.missingRequired : f.missingOptional).push(c.name);
  });
  if (f.missingRequired.length)
    fileIssue('error', 'MISSING_REQUIRED_COLUMNS', { columns: f.missingRequired });
  if (f.missingOptional.length)
    fileIssue('info', 'MISSING_OPTIONAL_COLUMNS', { columns: f.missingOptional });
  const fileHas: Record<string, boolean> = {};
  READ.forEach((n) => {
    fileHas[n] = has(norm(n));
  });
  f.has = fileHas;
  const missingChecks = CHECK_ONLY.filter((n) => !fileHas[n]);
  if (missingChecks.length) fileIssue('info', 'CHECKS_SKIPPED', { columns: missingChecks });
  header.forEach((name) => {
    const k = norm(name);
    if (!k || OUT_SET[k]) return;
    if (KNOWN[k]) f.leftOut.push(name.trim());
    else f.unknown.push(name.trim());
  });
  if (f.unknown.length) fileIssue('info', 'UNKNOWN_COLUMNS', { columns: f.unknown });

  const readIdx = READ.map((n) => (has(norm(n)) ? idx[norm(n)]! : -1));
  const probeIdx = PROBES.map(norm)
    .filter((k) => has(k))
    .map((k) => idx[k]!);
  const orderLevelIdx: number[] = [];
  Object.keys(idx).forEach((k) => {
    if (KNOWN[k] && !LINE_SET[k]) orderLevelIdx.push(idx[k]!);
  });
  const nameIdx = idx[norm('Name')]!;
  const stripIdx = STRIP_APOSTROPHE.map((n) => col(n));
  const idCols: number[] = [];
  OUTPUT.forEach((c, i) => {
    if (c.scope === 'id') idCols.push(i);
  });

  const cell = (cells: string[], i: number) => (i < 0 || cells[i] == null ? '' : cells[i]!);
  function isContinuation(cells: string[]): boolean | null {
    if (!probeIdx.length) return null;
    return probeIdx.every((i) => cell(cells, i).trim() === '');
  }
  function sameOrderDetails(cells: string[], firstCells: string[]) {
    return orderLevelIdx.every((i) => cell(cells, i).trim() === cell(firstCells, i).trim());
  }

  const extraRows: number[] = [];
  const shortRows: number[] = [];
  const badChars: number[] = [];
  let cur: Order | null = null;
  function makeLine(cells: string[], rowNo: number): Line {
    const out = readIdx.map((i) => cell(cells, i));
    stripIdx.forEach((i) => {
      if (out[i]!.charAt(0) === "'") {
        out[i] = out[i]!.slice(1);
        f.apostrophes++;
      }
    });
    if (out.slice(0, NOUT).some((v) => INVALID_CHARS.test(v))) badChars.push(rowNo);
    return { out, row: rowNo, carried: [], cells };
  }
  function startOrder(kind: OrderKind, cells: string[], rowNo: number): Order {
    const line = makeLine(cells, rowNo);
    const o: Order = {
      key: f.id + ':' + rowNo,
      uid: ++ctx.uid,
      seq: ++ctx.seq,
      kind,
      fileId: f.id,
      fileName: f.name,
      firstRow: rowNo,
      name: cell(cells, nameIdx).trim(),
      firstCells: cells,
      first: line.out,
      lines: [line],
      issues: [],
      excluded: false,
      dupIssue: null,
    };
    f.orders.push(o);
    return o;
  }
  function addLine(o: Order, cells: string[], rowNo: number) {
    const line = makeLine(cells, rowNo);
    idCols.forEach((ci) => {
      const v = line.out[ci]!.trim();
      const base = o.first[ci]!.trim();
      if (o.kind !== 'normal') return; // carry forward only inside a confirmed order
      if (!v && base) {
        line.out[ci] = o.first[ci]!;
        line.carried.push(ci);
      } else if (v && base && v.toLowerCase() !== base.toLowerCase())
        o.issues.push(
          issue('warning', 'ID_VALUE_DIFFERS', {
            row: rowNo,
            line: o.lines.length + 1,
            column: OUTPUT[ci]!.name,
            value: v,
            base,
          }),
        );
    });
    o.lines.push(line);
  }

  for (let r = h + 1; r < recs.length; r++) {
    const cells = recs[r]!;
    const rowNo = r + 1;
    if (cells.every((c) => c.trim() === '')) {
      f.blankRows++;
      continue;
    }
    f.dataRows++;
    if (cells.length > header.length && cells.slice(header.length).some((c) => c.trim() !== ''))
      extraRows.push(rowNo);
    else if (cells.length < header.length) shortRows.push(rowNo);
    const name = cell(cells, nameIdx).trim();
    const cont = isContinuation(cells);
    if (!name) {
      startOrder('noid', cells, rowNo);
      cur = null;
      continue;
    }
    if (cur && cur.name === name && cur.kind !== 'noid') {
      if (cont !== false || sameOrderDetails(cells, cur.firstCells)) {
        addLine(cur, cells, rowNo);
        continue;
      }
      cur = startOrder('normal', cells, rowNo);
      continue;
    }
    cur = startOrder(cont === true ? 'orphan' : 'normal', cells, rowNo);
  }
  f.productRows = f.orders.reduce((a, o) => a + o.lines.length, 0);
  if (f.blankRows) fileIssue('info', 'BLANK_ROWS', { count: f.blankRows });
  if (extraRows.length)
    fileIssue('error', 'EXTRA_VALUES', { rows: extraRows }, listRowsOf(extraRows));
  if (shortRows.length)
    fileIssue('warning', 'SHORT_ROWS', { rows: shortRows }, listRowsOf(shortRows));
  if (badChars.length)
    fileIssue('warning', 'CONTROL_CHARS', { rows: badChars }, listRowsOf(badChars));
  if (f.dataRows === 0) fileIssue('warning', 'NO_ORDER_ROWS', none);
  if (f.apostrophes) fileIssue('info', 'APOSTROPHES_REMOVED', { count: f.apostrophes });
  return f;
}

function listRowsOf(rows: number[]): string {
  if (rows.length <= 15) return rows.join(', ');
  return rows.slice(0, 15).join(', ') + ' and ' + (rows.length - 15) + ' more';
}

/* ---------------- Checks ---------------- */

/** A READ field of the order's first row, trimmed. */
export function g(o: Pick<Order, 'first'>, name: string): string {
  return (o.first[col(name)] || '').trim();
}
function num(s: string): number | null {
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : null;
}
export function clip(s: string): string {
  s = s.replace(/\s+/g, ' ');
  return s.length > 300 ? s.slice(0, 300) + '…' : s;
}

/** Why a phone number looks wrong (null = fine). Country '' is treated as Bulgaria. */
export function phoneProblem(raw: string, country: string): PhoneProblem | null {
  const compact = raw.replace(/[\s\-()./]/g, '');
  if (!/^\+?\d+$/.test(compact)) return 'non_digits';
  const c = country.toUpperCase();
  if (c === 'BG' || c === '') {
    if (/^0\d{7,9}$/.test(compact) || /^(\+|00)359\d{7,9}$/.test(compact)) return null;
    if (/^[89]\d{8}$/.test(compact)) return 'bg_missing_zero';
    return 'bg_length';
  }
  const digits = compact.replace(/\D/g, '');
  return digits.length < 7 || digits.length > 15 ? 'length' : null;
}

export function validateOrder(o: Order, has: (name: string) => boolean): void {
  const add = <C extends IssueCode>(sev: Severity, code: C, params: IssueParamMap[C]) => {
    o.issues.push(issue(sev, code, params));
  };
  const none = {} as Record<string, never>;
  if (o.kind === 'noid') {
    add('error', 'NO_ORDER_NUMBER', { row: o.firstRow });
    return;
  }
  if (o.kind === 'orphan') {
    add('error', 'ORPHAN_ROWS', { rows: o.lines.map((l) => l.row), order: o.name });
    return;
  }
  const country = g(o, 'Shipping Country');
  if (has('Shipping Name') && !g(o, 'Shipping Name')) add('error', 'MISSING_RECIPIENT', none);
  if (has('Shipping Address1') && !g(o, 'Shipping Address1') && !g(o, 'Shipping Address2'))
    add('error', 'MISSING_ADDRESS', none);
  if (has('Shipping City') && !g(o, 'Shipping City')) add('error', 'MISSING_CITY', none);
  if (has('Shipping Zip') && !g(o, 'Shipping Zip')) add('error', 'MISSING_ZIP', none);
  if (has('Shipping Country') && !country) add('warning', 'COUNTRY_EMPTY', none);
  if (country && country.toUpperCase() !== HOME_COUNTRY)
    add('warning', 'SHIPS_ABROAD', { country });
  if (g(o, 'Shipping Company'))
    add('info', 'COMPANY_DELIVERY', { company: clip(g(o, 'Shipping Company')) });
  if (g(o, 'Notes')) add('warning', 'CUSTOMER_NOTE', { note: clip(g(o, 'Notes')) });
  if (g(o, 'Note Attributes'))
    add('warning', 'NOTE_ATTRIBUTES', { text: clip(g(o, 'Note Attributes')) });
  if (has('Shipping Phone')) {
    const ph = g(o, 'Shipping Phone');
    if (!ph) {
      const alternatives = [g(o, 'Phone'), g(o, 'Billing Phone')].filter(Boolean);
      add('error', 'NO_SHIPPING_PHONE', { alternatives });
    } else {
      const problem = phoneProblem(ph, country);
      if (problem) add('warning', 'PHONE_CHECK', { phone: ph, problem });
    }
  }
  const zip = g(o, 'Shipping Zip');
  if (zip && country.toUpperCase() === 'BG' && !/^\d{4}$/.test(zip))
    add('warning', 'ZIP_NOT_4_DIGITS', { zip });
  const cancelled = g(o, 'Cancelled at');
  if (cancelled) add('error', 'CANCELLED', { cancelledAt: cancelled });
  const fs = g(o, 'Fulfillment Status').toLowerCase();
  if (fs === 'fulfilled') add('info', 'FULFILLED', none);
  else if (fs === 'partial') add('warning', 'PARTIALLY_FULFILLED', none);
  // The workbook shows Total. Warn when the amount still to pay is different (paid, part-paid or refunded).
  const pm = g(o, 'Payment Method').toLowerCase();
  const isCOD = COD_RE.test(pm);
  const total = num(g(o, 'Total'));
  const owed = num(g(o, 'Outstanding Balance'));
  const pay = g(o, 'Financial Status').toLowerCase();
  if (total != null && owed != null && Math.abs(total - owed) > 0.004)
    add('warning', 'OUTSTANDING_DIFFERS', {
      owed: g(o, 'Outstanding Balance'),
      total: g(o, 'Total'),
    });
  else if (owed == null && /^(paid|partially_paid|partially_refunded|refunded)$/.test(pay))
    add('warning', 'PAYMENT_STATUS', { status: pay });
  if (isCOD && has('Total') && !g(o, 'Total')) add('warning', 'COD_TOTAL_EMPTY', none);
  if (g(o, 'Payment Terms Name'))
    add('info', 'PAYMENT_TERMS', { terms: g(o, 'Payment Terms Name') });
  if (has('Email') && !g(o, 'Email')) add('info', 'NO_EMAIL', none);
  o.lines.forEach((l, li) => {
    const q = (l.out[col('Lineitem quantity')] || '').trim();
    if (!/^\d+$/.test(q) || Number(q) === 0)
      add('warning', 'LINE_BAD_QUANTITY', { row: l.row, line: li + 1, quantity: q });
    if (!(l.out[col('Lineitem name')] || '').trim())
      add('warning', 'LINE_NO_NAME', { row: l.row, line: li + 1 });
    if ((l.out[col('Lineitem requires shipping')] || '').trim().toLowerCase() === 'false')
      add('info', 'LINE_NO_SHIPPING', { row: l.row, line: li + 1 });
  });
}

/** Cash-on-delivery payment method (brief: /cash on delivery|\bcod\b|наложен/i). */
export const COD_RE = /cash on delivery|\bcod\b|наложен/i;

export function simple(s: unknown): string {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/**
 * Phone used only for matching customers (the value itself is never changed):
 * +359 / 00359 / 359 → 0, and a 9-digit Bulgarian mobile written without its
 * leading 0 is matched as 0 + number. Too-short numbers are ignored ('').
 */
export function phoneMatchKey(s: unknown): string {
  let d = String(s || '')
    .replace(/[^\d+]/g, '')
    .replace(/^(\+|00)359/, '0')
    .replace(/^359(?=\d{8,9}$)/, '0');
  if (/^[89]\d{8}$/.test(d)) d = '0' + d;
  return d.replace(/\D/g, '').length >= 6 ? d : '';
}

export function recipientKey(o: Pick<Order, 'first'>): string {
  return (
    [
      'Shipping Name',
      'Shipping Company',
      'Shipping Address1',
      'Shipping Address2',
      'Shipping City',
      'Shipping Zip',
      'Shipping Country',
    ]
      .map((n) => simple(g(o, n)))
      .join('|') +
    '|' +
    phoneMatchKey(g(o, 'Shipping Phone'))
  );
}

/** The product set of an order (SKU, else name, × quantity), ignoring line order. */
export function productsKey(o: Pick<Order, 'lines'>): string {
  return o.lines
    .map(
      (l) =>
        simple(l.out[col('Lineitem sku')] || l.out[col('Lineitem name')]) +
        '×' +
        simple(l.out[col('Lineitem quantity')]),
    )
    .sort()
    .join(';');
}

function orderLabel(o: Order): string {
  return o.name || 'row ' + o.firstRow;
}

/* ---------------- Main conversion ---------------- */

export interface Group {
  key: string;
  email: string;
  emails: string[];
  orders: Order[];
  issues: Issue[];
  seq: number;
}

export interface ExportRow {
  values: string[];
  multi: boolean;
  sameCustomer: boolean;
  manyProducts: boolean;
  sep: 'group' | 'order' | '';
  level: 0 | 1 | 2;
  order: Order;
  line: Line;
  group: Group;
}

export interface ConvertCounts {
  customers: number;
  orders: number;
  productRows: number;
  excludedOrders: number;
  inputRows: number;
  errors: number;
  warnings: number;
  infos: number;
}

export interface ConvertResult {
  files: FileResult[];
  orders: Order[];
  groups: Group[];
  issues: Issue[];
  counts: ConvertCounts;
  rows: ExportRow[];
}

export function convert(
  inputs: readonly FileInput[],
  excluded: Readonly<Record<string, boolean>> = {},
): ConvertResult {
  const ctx: ReadContext = { uid: 0, seq: 0 };
  const files: FileResult[] = [];
  const orders: Order[] = [];
  const seen: Record<string, string> = {};
  inputs.forEach((inp) => {
    const f = readFile(inp, ctx);
    const hsh = hashBytes(inp.bytes);
    if (seen[hsh])
      f.issues.push(issue('warning', 'SAME_FILE', { other: seen[hsh]! }, { file: f.name }));
    else seen[hsh] = f.name;
    files.push(f);
    f.orders.forEach((o) => {
      validateOrder(o, (n) => !!(f.has && f.has[n]));
      orders.push(o);
    });
  });

  markRepeatedOrders(orders);
  const groups = groupCustomers(orders);

  // Exclusions chosen by the user (never automatic).
  orders.forEach((o) => {
    o.excluded = !!excluded[o.key];
  });

  // Collect all issues in display order.
  let all: Issue[] = [];
  files.forEach((f) => {
    all = all.concat(f.issues);
  });
  const dupDone: Record<string, 1> = {};
  groups.forEach((grp) => {
    grp.issues.forEach((is) => all.push(is));
    grp.orders.forEach((o) => {
      o.issues.forEach((is) => {
        is.file = o.fileName;
        is.order = orderLabel(o);
        is.email = g(o, 'Email');
        is.rows = is.rows || String(o.firstRow);
        all.push(is);
      });
      if (o.dupIssue && !dupDone[o.name]) {
        dupDone[o.name] = 1;
        o.dupIssue.email = g(o, 'Email');
        all.push(o.dupIssue);
      }
      if (o.excluded)
        all.push(
          issue('info', 'EXCLUDED', {} as Record<string, never>, {
            order: orderLabel(o),
            email: g(o, 'Email'),
            file: o.fileName,
            rows: String(o.firstRow),
          }),
        );
    });
  });
  sortIssues(all);

  const rows = exportRows(groups);
  const counts: ConvertCounts = {
    customers: groups.filter((grp) => grp.orders.some((o) => !o.excluded)).length,
    orders: orders.filter((o) => !o.excluded).length,
    productRows: rows.length,
    excludedOrders: orders.filter((o) => o.excluded).length,
    inputRows: files.reduce((a, f) => a + f.dataRows, 0),
    errors: all.filter((x) => x.sev === 'error').length,
    warnings: all.filter((x) => x.sev === 'warning').length,
    infos: all.filter((x) => x.sev === 'info').length,
  };
  return { files, orders, groups, issues: all, counts, rows };
}

const RANK: Readonly<Record<Severity, number>> = { error: 0, warning: 1, info: 2 };

/** Errors first, then warnings, then info; otherwise in the order they were found. */
export function sortIssues(all: Issue[]): void {
  all.forEach((is, i) => {
    is.i = i;
  });
  all.sort((a, b) => RANK[a.sev] - RANK[b.sev] || a.i! - b.i!);
}

/** Repeated order numbers (repeated imports or conflicting copies). Nothing is removed. */
export function markRepeatedOrders(orders: readonly Order[]): void {
  const byName: Record<string, Order[]> = {};
  orders.forEach((o) => {
    if (o.name && o.kind === 'normal') (byName[o.name] = byName[o.name] || []).push(o);
  });
  Object.keys(byName).forEach((n) => {
    const copies = byName[n]!;
    if (copies.length < 2) return;
    const sig = (o: Order) => JSON.stringify(o.lines.map((l) => l.out));
    const identical = copies.every((o) => sig(o) === sig(copies[0]!));
    const params = {
      order: n,
      count: copies.length,
      places: copies.map((o) => ({ file: o.fileName, row: o.firstRow })),
    };
    const is = identical
      ? issue('warning', 'REPEATED_IDENTICAL', params, { order: n })
      : issue('error', 'REPEATED_CONFLICT', params, { order: n });
    copies.forEach((o) => {
      o.dupIssue = is;
      o.dupCount = copies.length;
    });
  });
}

/**
 * Customer groups: the same customer = same email (spaces/capitals ignored) OR
 * same phone number and same recipient name. Copies of the same order number
 * always stay together. Orders with no email and no phone+name are never combined.
 */
export function groupCustomers(orders: readonly Order[]): Group[] {
  const parent = orders.map((_, i) => i);
  function find(i: number): number {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  }
  function link(map: Record<string, number>, key: string, i: number) {
    if (!key) return;
    if (Object.prototype.hasOwnProperty.call(map, key)) {
      const a = find(map[key]!);
      const b = find(i);
      if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
    } else map[key] = i;
  }
  const byEmail: Record<string, number> = {};
  const byPhoneName: Record<string, number> = {};
  const byOrderNo: Record<string, number> = {};
  orders.forEach((o, i) => {
    link(byEmail, g(o, 'Email').toLowerCase(), i);
    const p = phoneMatchKey(g(o, 'Shipping Phone'));
    const n = simple(g(o, 'Shipping Name'));
    link(byPhoneName, p && n ? p + '|' + n : '', i);
    link(byOrderNo, o.name, i);
  });
  const groups: Group[] = [];
  const gmap: Record<number, Group> = {};
  orders.forEach((o, i) => {
    const root = find(i);
    let grp = gmap[root];
    if (!grp) {
      grp = gmap[root] = {
        key: 'g:' + orders[root]!.key,
        email: '',
        emails: [],
        orders: [],
        issues: [],
        seq: orders[root]!.seq,
      };
      groups.push(grp);
    }
    grp.orders.push(o);
    const email = g(o, 'Email');
    if (email && grp.emails.indexOf(email) < 0) grp.emails.push(email);
    if (!grp.email && email) grp.email = email;
  });
  groups.forEach((grp) => {
    const firstSeq: Record<string, number> = {};
    const k = (o: Order) => o.name || '#' + o.uid;
    grp.orders.forEach((o) => {
      if (!(k(o) in firstSeq)) firstSeq[k(o)] = o.seq;
    });
    grp.orders.sort((a, b) => firstSeq[k(a)]! - firstSeq[k(b)]! || a.seq - b.seq);
    const emailKeys: string[] = [];
    grp.orders.forEach((o) => {
      const e = g(o, 'Email').toLowerCase();
      if (emailKeys.indexOf(e) < 0) emailKeys.push(e);
    });
    const unique = (v: string, i: number, a: string[]) => a.indexOf(v) === i;
    if (emailKeys.length > 1)
      grp.issues.push(
        issue(
          'info',
          'GROUP_DIFFERENT_EMAILS',
          { emails: emailKeys },
          { email: grp.email, order: grp.orders.map(orderLabel).filter(unique).join(', ') },
        ),
      );
    else if (grp.emails.length > 1)
      grp.issues.push(
        issue('info', 'GROUP_EMAIL_VARIANTS', { emails: grp.emails.slice() }, { email: grp.email }),
      );
    const distinct: Order[] = [];
    const seenN: Record<string, 1> = {};
    grp.orders.forEach((o) => {
      if (o.kind === 'normal' && o.name && !seenN[o.name]) {
        seenN[o.name] = 1;
        distinct.push(o);
      }
    });
    if (distinct.length > 1) {
      const rk: Record<string, Order[]> = {};
      distinct.forEach((o) => {
        (rk[recipientKey(o)] = rk[recipientKey(o)] || []).push(o);
      });
      const keys = Object.keys(rk);
      if (keys.length > 1) {
        const variants = keys.map((key) => {
          const first = rk[key]![0]!;
          return {
            orders: rk[key]!.map(orderLabel),
            details: [
              g(first, 'Shipping Name'),
              g(first, 'Shipping Address1'),
              g(first, 'Shipping City'),
              g(first, 'Shipping Phone'),
            ].filter(Boolean),
          };
        });
        grp.issues.push(
          issue(
            'warning',
            'GROUP_DIFFERENT_RECIPIENT',
            { variants },
            { email: grp.email, order: distinct.map(orderLabel).join(', ') },
          ),
        );
      }
      const pk: Record<string, Order[]> = {};
      distinct.forEach((o) => {
        (pk[productsKey(o)] = pk[productsKey(o)] || []).push(o);
      });
      Object.keys(pk).forEach((key) => {
        const same = pk[key]!;
        if (same.length > 1)
          grp.issues.push(
            issue(
              'warning',
              'GROUP_SAME_PRODUCTS',
              { orders: same.map(orderLabel) },
              { email: grp.email, order: same.map(orderLabel).join(', ') },
            ),
          );
      });
    }
  });
  groups.sort((a, b) => a.seq - b.seq);
  return groups;
}

/**
 * Products in one order = the sum of its quantities (a product row without a
 * numeric quantity counts as 1).
 */
export function pieceCount(o: Pick<Order, 'lines'>): number {
  return o.lines.reduce((a, l) => {
    const q = Number(String(l.out[col('Lineitem quantity')] || '').trim());
    return a + (q >= 1 ? q : 1);
  }, 0);
}

export function manyProducts(o: Pick<Order, 'lines'>): boolean {
  return o.lines.length > 1 || pieceCount(o) > 1;
}

/** One row per product, grouped: customer → order → products. Shared by the preview and the workbook. */
export function exportRows(groups: readonly Group[]): ExportRow[] {
  const rows: ExportRow[] = [];
  groups.forEach((grp) => {
    const inc = grp.orders.filter((o) => !o.excluded);
    if (!inc.length) return;
    const sameCustomer = inc.length > 1; // same customer with more than one order in the workbook
    inc.forEach((o, oi) => {
      const many = manyProducts(o); // one order with more than one product
      o.lines.forEach((l, li) => {
        rows.push({
          values: [''].concat(l.out.slice(0, NOUT)),
          multi: sameCustomer || many,
          sameCustomer,
          manyProducts: many,
          sep: oi === 0 && li === 0 ? 'group' : li === 0 ? 'order' : '',
          level: li > 0 ? 2 : oi > 0 ? 1 : 0,
          order: o,
          line: l,
          group: grp,
        });
      });
    });
  });
  return rows;
}

export { COL };
