import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VISIBLE_COLUMNS,
  archiveName,
  batchView,
  buildBatchWorkbook,
  buildImportPayload,
  buildXlsx,
  cellValue,
  columnCatalog,
  convert,
  firstFreeName,
  hiddenColumnsFor,
  isPastRetention,
  issueKey,
  normalizeVisibleColumns,
  parseBool,
  parseMoneyCents,
  parseNoteAttributes,
  parseQuantity,
  parseShopifyDate,
  safeFileName,
  sampleFiles,
  SHOPIFY_COLUMNS,
  toCSV,
  sampleRows,
  SAMPLE_ORDERS,
  withSuffix,
  xlsxColumnsFor,
  type ImportPayload,
  type StoredOrder,
} from './index';

const enc = new TextEncoder();
const files = sampleFiles();
const bytesOf = (i: number) => enc.encode(files[i]!.text);
const SHA = 'a'.repeat(64);
const EOL = String.fromCharCode(10);

function prepare(name: string, bytes: Uint8Array): ImportPayload {
  const r = buildImportPayload({ name, bytes, sha256: SHA });
  if (!r.ok) throw new Error('not importable');
  return r.payload;
}

/** What the database gives back for a batch (orders.raw + order_lines.raw). */
function asStored(payload: ImportPayload): StoredOrder[] {
  return payload.orders.map((o) => ({
    id: o.name,
    name: o.name,
    first_row: o.first_row,
    raw: o.raw,
    lines: o.lines.map((l) => ({ line_no: l.line_no, source_row: l.source_row, raw: l.raw })),
  }));
}

describe('typed fields', () => {
  it('parses money as integer cents without float errors', () => {
    expect(parseMoneyCents('12.34')).toBe(1234);
    expect(parseMoneyCents(' 0.1 ')).toBe(10);
    expect(parseMoneyCents('1.005')).toBe(101);
    expect(parseMoneyCents('-4.99')).toBe(-499);
    expect(parseMoneyCents('7')).toBe(700);
    expect(parseMoneyCents('')).toBeNull();
    expect(parseMoneyCents('12,34')).toBeNull();
    expect(parseMoneyCents('€5')).toBeNull();
  });

  it('parses Shopify dates with their time zone', () => {
    expect(parseShopifyDate('2026-11-02 09:15:00 +0200')).toBe('2026-11-02T09:15:00+02:00');
    expect(parseShopifyDate('2026-11-02T09:15:00Z')).toBe('2026-11-02T09:15:00Z');
    expect(parseShopifyDate('2026-11-02 09:15 -05:00')).toBe('2026-11-02T09:15:00-05:00');
    expect(parseShopifyDate('2026-11-02 09:15:00')).toBeNull();
    expect(parseShopifyDate('2026-13-02 09:15:00 +0200')).toBeNull();
    expect(parseShopifyDate('')).toBeNull();
  });

  it('parses booleans, quantities and note attributes', () => {
    expect(parseBool('TRUE')).toBe(true);
    expect(parseBool('false')).toBe(false);
    expect(parseBool('')).toBeNull();
    expect(parseQuantity('3')).toBe(3);
    expect(parseQuantity('0')).toBe(0);
    expect(parseQuantity('две')).toBeNull();
    expect(parseQuantity('1.5')).toBeNull();
    expect(parseNoteAttributes('Офис: Еконт Пловдив\nАвтомат: Спиди 123\r\nбез двоеточие')).toEqual(
      [
        { name: 'Офис', value: 'Еконт Пловдив' },
        { name: 'Автомат', value: 'Спиди 123' },
        { name: '', value: 'без двоеточие' },
      ],
    );
  });
});

describe('import payload', () => {
  const payload = prepare(files[0]!.name, bytesOf(0));
  const order = (name: string) => payload.orders.find((o) => o.name === name)!;

  it('keeps every column untouched in raw and fills the typed columns', () => {
    const o = order('#2002');
    expect(o.shopify_id).toBe('9000000002002');
    expect(o.raw['Shipping Zip']).toBe("'4000");
    expect(Object.keys(o.raw)).toEqual([...SHOPIFY_COLUMNS]);
    expect(o.fields).toMatchObject({
      shipping_zip: '4000',
      phone_raw: '+359888000102',
      phone_norm: '0888000102',
      email: 'Maria.Testova@Example.com',
      email_norm: 'maria.testova@example.com',
      total_cents: 4498,
      outstanding_cents: 4498,
      shipping_cents: 499,
      is_cod: true,
      currency: 'EUR',
      created_at_shopify: '2026-11-02T11:40:00+02:00',
      shipping_method: 'Стандартна доставка',
      cancelled_at: null,
    });
    expect(payload.file).toMatchObject({
      size: bytesOf(0).length,
      sha256: SHA,
      encoding: 'UTF-8',
      delimiter: ',',
    });
  });

  it('stores lines with typed values and their own raw row', () => {
    const lines = order('#2001').lines;
    expect(
      lines.map((l) => [l.line_no, l.sku, l.quantity, l.price_cents, l.requires_shipping]),
    ).toEqual([
      [1, 'DEMO-BED-BLUE-S6', 1, 3299, true],
      [2, 'DEMO-PILLOW-50X70', 2, 1999, true],
      [3, 'DEMO-TOWEL-W', 3, 1250, true],
    ]);
    expect(lines[1]!.raw['Shipping City']).toBe('');
  });

  it('turns every check into a flag with Bulgarian and English text and a reason', () => {
    const abroad = order('#2005').flags.find((f) => f.code === 'SHIPS_ABROAD')!;
    expect(abroad).toMatchObject({
      severity: 'amber',
      message_bg: 'Доставка в чужбина: IT.',
      message_en: 'Ships abroad to IT.',
      source_row: order('#2005').first_row,
    });
    expect(abroad.reason_bg).toMatch(/България/);
    const phone = order('#2006').flags.find((f) => f.code === 'PHONE_CHECK')!;
    expect(phone.severity).toBe('amber');
    expect(phone.message_bg).toContain('без 0 отпред');
    expect(payload.batch_flags.map((f) => f.code)).toContain('APOSTROPHES_REMOVED');
    expect(payload.batch_flags.every((f) => f.severity === 'info')).toBe(true);
  });

  it('marks a cancelled order red', () => {
    const p = prepare(files[1]!.name, bytesOf(1));
    const o = p.orders.find((x) => x.name === '#2010')!;
    expect(o.fields.cancelled_at).toBe('2026-11-06T11:00:00+02:00');
    expect(o.flags.find((f) => f.code === 'CANCELLED')?.severity).toBe('red');
  });

  it('imports one copy of a repeated order and skips the others', () => {
    // Both legacy sample files in ONE file (one batch).
    const O = SAMPLE_ORDERS;
    const o2004b = { ...O.o2004, phone: '0888000999' };
    const orders = [
      O.o2001,
      O.o2002,
      O.o2003,
      O.o2004,
      O.o2005,
      O.o2006,
      O.o2007,
      O.o2001,
      O.o2008,
      o2004b,
      O.o2009,
      O.o2010,
      O.o2011,
    ];
    const csv = toCSV(
      SHOPIFY_COLUMNS,
      orders.flatMap((o) => sampleRows(o)),
      ',',
      EOL,
    );
    const p = prepare('one-batch.csv', enc.encode(csv));
    const names = p.orders.map((o) => o.name);
    expect(new Set(names).size).toBe(names.length);
    expect(
      p.skipped
        .filter((s) => s.reason === 'repeated_copy')
        .map((s) => s.name)
        .sort(),
    ).toEqual(['#2001', '#2004']);
    const o2004 = p.orders.find((o) => o.name === '#2004')!;
    expect(o2004.flags.find((f) => f.code === 'REPEATED_CONFLICT')?.severity).toBe('red');
    const o2001 = p.orders.find((o) => o.name === '#2001')!;
    expect(o2001.flags.find((f) => f.code === 'REPEATED_IDENTICAL')?.severity).toBe('amber');
    // A customer issue goes on each order it is about.
    for (const n of ['#2002', '#2007'])
      expect(p.orders.find((o) => o.name === n)!.flags.map((f) => f.code)).toContain(
        'GROUP_EMAIL_VARIANTS',
      );
  });

  it('flags the last order of a cut-off file', () => {
    const text = toCSV(
      SHOPIFY_COLUMNS,
      [...sampleRows(SAMPLE_ORDERS.o2001), ...sampleRows(SAMPLE_ORDERS.o2002)],
      ',',
      '\n',
    );
    const cut = text.slice(0, text.indexOf('"Моля, обадете') + 12);
    const p = prepare('cut.csv', enc.encode(cut));
    expect(p.batch_flags.find((f) => f.code === 'UNTERMINATED_QUOTE')?.severity).toBe('red');
    expect(p.orders.at(-1)!.flags.find((f) => f.code === 'FILE_TRUNCATED_ORDER')?.severity).toBe(
      'red',
    );
    expect(p.orders[0]!.flags.map((f) => f.code)).not.toContain('FILE_TRUNCATED_ORDER');
  });

  it('refuses a file that is not a Shopify export, with a Bulgarian reason', () => {
    const r = buildImportPayload({
      name: 'x.csv',
      bytes: enc.encode('a,b,c\n1,2,3\n'),
      sha256: SHA,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.flags[0]).toMatchObject({ code: 'NOT_SHOPIFY_EXPORT', severity: 'red' });
    const xlsx = buildImportPayload({
      name: 'x.xlsx',
      bytes: Uint8Array.of(0x50, 0x4b, 3, 4),
      sha256: SHA,
    });
    expect(!xlsx.ok && xlsx.flags[0]!.message_bg).toMatch(/Excel/);
  });

  it('gives the same issue on the same order the same key, whatever its row number', () => {
    const a = issueKey('LINE_BAD_QUANTITY', { row: 5, line: 2, quantity: 'x' });
    const b = issueKey('LINE_BAD_QUANTITY', { row: 40, line: 2, quantity: 'x' });
    const c = issueKey('LINE_BAD_QUANTITY', { row: 5, line: 3, quantity: 'x' });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('batch view rebuilt from stored data', () => {
  for (const i of [0, 1]) {
    it(`gives exactly the legacy rows and workbook for ${files[i]!.name}`, () => {
      const result = convert([{ id: 1, name: files[i]!.name, bytes: bytesOf(i) }]);
      const view = batchView(asStored(prepare(files[i]!.name, bytesOf(i))));
      const shape = (rows: typeof result.rows) =>
        rows.map((r) => ({
          values: r.values,
          multi: r.multi,
          level: r.level,
          sep: r.sep,
          order: r.order.name,
        }));
      expect(shape(view.rows)).toEqual(shape(result.rows));
      const now = new Date(2026, 10, 12, 10, 0, 0);
      const fromDb = buildXlsx({ ...result, rows: view.rows }, { now });
      expect(Buffer.from(fromDb).equals(Buffer.from(buildXlsx(result, { now })))).toBe(true);
    });
  }

  it('follows the column setting: hidden, reordered and extra Shopify columns', () => {
    const view = batchView(asStored(prepare(files[0]!.name, bytesOf(0))));
    const row = view.rows.find((r) => r.order.name === '#2002')!;
    expect(cellValue(row, 'Shipping Zip')).toBe('4000');
    expect(cellValue(row, 'Billing Zip')).toBe('4000');
    expect(cellValue(row, 'Shipping Method')).toBe('Стандартна доставка');
    expect(cellValue(row, 'Notes')).toContain('Моля, обадете се');
    const cols = xlsxColumnsFor(['Created at', 'Name', 'Total']);
    expect(cols.map((c) => c.header)).toEqual(['Created at', 'order_id', 'Total']);
    expect(cols[2]!.type).toBe('money');
  });

  it('builds a workbook from flags in the UI language', () => {
    const payload = prepare(files[0]!.name, bytesOf(0));
    const view = batchView(asStored(payload));
    const flags = [
      ...payload.batch_flags.map((f) => ({ ...f, order_name: null, email: null })),
      ...payload.orders.flatMap((o) =>
        o.flags.map((f) => ({ ...f, order_name: o.name, email: o.fields.email })),
      ),
    ];
    const bytes = buildBatchWorkbook(view, flags, {
      fileName: 'x.csv',
      locale: 'bg',
      visibleColumns: ['Name', 'Shipping City'],
      now: new Date(2026, 10, 12),
    });
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain('Доставка в чужбина: IT.');
    expect(text).toContain('<t xml:space="preserve">order_id</t>');
    expect(text).not.toContain('Product Photo');
    expect(text).toContain('<sheet name="Shipping"');
  });
});

describe('column settings', () => {
  it('shows the legacy 18 columns + photo by default, nothing hidden', () => {
    expect(DEFAULT_VISIBLE_COLUMNS).toHaveLength(19);
    expect(DEFAULT_VISIBLE_COLUMNS[0]).toBe('Product Photo');
    expect(hiddenColumnsFor(DEFAULT_VISIBLE_COLUMNS)).toEqual([]);
    expect(hiddenColumnsFor(['Name'])).toHaveLength(18);
  });

  it('lists every column found in the files, chosen ones first', () => {
    const catalog = columnCatalog(
      [
        ['Name', 'Notes', 'My column'],
        ['Created at', 'Name'],
      ],
      ['Notes', 'Name'],
    );
    expect(catalog.slice(0, 2)).toEqual(['Notes', 'Name']);
    expect(catalog).toContain('Created at');
    expect(catalog).toContain('My column');
    expect(catalog).toContain('Product Photo');
    expect(new Set(catalog).size).toBe(catalog.length);
    expect(catalog.indexOf('Created at')).toBeLessThan(catalog.indexOf('My column'));
  });

  it('cleans a broken setting', () => {
    expect(normalizeVisibleColumns(null)).toEqual([...DEFAULT_VISIBLE_COLUMNS]);
    expect(normalizeVisibleColumns(['Name', 'Name', 3, '', 'Total'])).toEqual(['Name', 'Total']);
  });
});

describe('archive names', () => {
  it('uses <year>/<import date in Bulgarian time>_<original name>.csv', () => {
    expect(archiveName('orders_export.csv', '2026-11-12T10:00:00Z')).toEqual({
      dir: '2026',
      file: '2026-11-12_orders_export.csv',
    });
    // 23:30 UTC on 31 Dec is already 1 Jan in Sofia.
    expect(archiveName('orders.CSV', '2026-12-31T23:30:00Z')).toEqual({
      dir: '2027',
      file: '2027-01-01_orders.csv',
    });
    expect(archiveName('export', '2026-06-01T12:00:00Z').file).toBe('2026-06-01_export.csv');
    expect(safeFileName('a:b?<c>|d*.csv')).toBe('a_b__c__d_.csv');
  });

  it('never overwrites: adds a suffix to the first free name', async () => {
    expect(withSuffix('x.csv', 2)).toBe('x (2).csv');
    expect(withSuffix('noext', 3)).toBe('noext (3)');
    const taken = new Set(['x.csv', 'x (2).csv']);
    expect(await firstFreeName('x.csv', async (n) => taken.has(n))).toBe('x (3).csv');
    expect(await firstFreeName('y.csv', async () => false)).toBe('y.csv');
  });

  it('is due after the retention period', () => {
    const now = new Date('2026-11-12T12:00:00Z');
    expect(isPastRetention('2026-08-13T11:00:00Z', 90, now)).toBe(true);
    expect(isPastRetention('2026-08-15T12:00:00Z', 90, now)).toBe(false);
  });
});
