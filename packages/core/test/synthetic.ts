/**
 * Synthetic test files for T2-02, built from the legacy sample orders:
 * Windows-1251, semicolon-separated, UTF-16 (LE and BE), columns in a different
 * order, a file cut off in the middle of a quoted value, plus edge cases
 * (orphan rows, rows without an order number, short / long rows, blank lines,
 * repeated and aliased headings, not a CSV at all).
 */
import {
  SAMPLE_ORDERS,
  SAMPLE_PRODUCTS,
  SHOPIFY_COLUMNS,
  sampleLine,
  sampleRows,
  toCSV,
  type CsvRow,
  type SampleOrder,
} from '../src/import';

export interface SyntheticFile {
  name: string;
  bytes: Uint8Array;
}

const enc = new TextEncoder();

/** Windows-1251 encoder built from the platform decoder (throws on characters it cannot store). */
function encode1251(text: string): Uint8Array {
  const dec = new TextDecoder('windows-1251');
  const map = new Map<string, number>();
  for (let b = 0; b < 256; b++) map.set(dec.decode(Uint8Array.of(b)), b);
  return Uint8Array.from([...text], (ch) => {
    const b = map.get(ch);
    if (b === undefined) throw new Error(`Not in Windows-1251: ${ch}`);
    return b;
  });
}

function encodeUtf16(text: string, littleEndian: boolean): Uint8Array {
  const out = new Uint8Array(2 + text.length * 2);
  const view = new DataView(out.buffer);
  view.setUint16(0, 0xfeff, littleEndian); // BOM
  for (let i = 0; i < text.length; i++) view.setUint16(2 + i * 2, text.charCodeAt(i), littleEndian);
  return out;
}

const O = SAMPLE_ORDERS;
const P = SAMPLE_PRODUCTS;
const rows = (orders: SampleOrder[]) => orders.flatMap((o) => sampleRows(o));

/** Only characters Windows-1251 can store (no × in the product names). */
const cyrillicOrders: SampleOrder[] = [
  { ...O.o2002, lines: [sampleLine(P.rose)] },
  { ...O.o2006, lines: [sampleLine(P.towel, 2), sampleLine(P.blue)] },
  { ...O.o2010 },
];

function rotate<T>(list: readonly T[], by: number): T[] {
  return list.slice(by).concat(list.slice(0, by));
}

export function syntheticFiles(): SyntheticFile[] {
  const base = rows([O.o2001, O.o2002, O.o2003, O.o2006, O.o2011]);
  const comma = toCSV(SHOPIFY_COLUMNS, base, ',', '\n');

  // Cut off inside the quoted, multi-line Notes of #2002.
  const cutAt = comma.indexOf('"Моля, обадете') + 12;

  // Orphan rows (continuation rows whose first row is missing), a row without an
  // order number, short and long rows, blank lines and control characters.
  const messy: CsvRow[] = [
    ...sampleRows(O.o2003),
    { Name: '#2099', 'Lineitem name': 'Сирак', 'Lineitem quantity': '1' },
    { ...sampleRows(O.o2004)[0]!, Name: '' },
    ...sampleRows({ ...O.o2001, lines: [sampleLine(P.blue, 0), sampleLine(P.towel, 1)] }),
    {
      ...sampleRows(O.o2008)[0]!,
      'Lineitem name': 'Кърпа\u0007 с камбанка',
      'Lineitem quantity': 'две',
    },
  ];
  let messyText = toCSV(SHOPIFY_COLUMNS, messy, ',', '\r\n');
  const messyLines = messyText.split('\r\n');
  messyLines.splice(3, 0, '', ',,,', '');
  messyLines.push('#3000,short,row');
  messyLines.push(messyLines[1] + ',extra,values');
  messyText = messyLines.join('\r\n');

  // Repeated and aliased headings ("Canceled at" is an alias of "Cancelled at").
  const aliasHeader = SHOPIFY_COLUMNS.map((h) => (h === 'Cancelled at' ? 'Canceled at' : h)).concat(
    ['Email', 'My own column'],
  );
  const aliasRows = rows([O.o2010, O.o2004]).map((r) => ({
    ...r,
    'Canceled at': r['Cancelled at'] ?? '',
    'My own column': 'x',
  }));

  // Only the legacy shipping columns, plus partial-payment and fulfilment cases.
  const reduced = [
    'Name',
    'Email',
    'Lineitem name',
    'Lineitem quantity',
    'Lineitem sku',
    'Shipping Name',
    'Shipping City',
    'Total',
  ];
  const partial = rows([O.o2005, O.o2007]).map((r, i) => ({
    ...r,
    'Outstanding Balance': i === 0 ? '10.00' : (r['Outstanding Balance'] ?? ''),
    'Financial Status': i === 0 ? 'partially_paid' : 'paid',
    'Fulfillment Status': i === 0 ? 'partial' : 'fulfilled',
    'Shipping Company': i === 0 ? 'Тест ЕООД' : '',
    'Payment Terms Name': i === 0 ? 'Net 30' : '',
    'Lineitem requires shipping': 'false',
  }));
  const noOutstanding = SHOPIFY_COLUMNS.filter((h) => h !== 'Outstanding Balance');

  return [
    {
      name: 'windows-1251.csv',
      bytes: encode1251(toCSV(SHOPIFY_COLUMNS, rows(cyrillicOrders), ',', '\r\n')),
    },
    { name: 'semicolon.csv', bytes: enc.encode(toCSV(SHOPIFY_COLUMNS, base, ';', '\n')) },
    { name: 'utf-16le.csv', bytes: encodeUtf16(toCSV(SHOPIFY_COLUMNS, base, '\t', '\r\n'), true) },
    { name: 'utf-16be.csv', bytes: encodeUtf16(toCSV(SHOPIFY_COLUMNS, base, ',', '\n'), false) },
    {
      name: 'columns-reordered.csv',
      bytes: enc.encode(toCSV(rotate(SHOPIFY_COLUMNS, 17), base, ',', '\n')),
    },
    { name: 'cut-off.csv', bytes: enc.encode(comma.slice(0, cutAt)) },
    {
      name: 'utf-8-bom-pipe.csv',
      bytes: enc.encode('\uFEFF' + toCSV(SHOPIFY_COLUMNS, base, '|', '\r')),
    },
    { name: 'messy.csv', bytes: enc.encode(messyText) },
    { name: 'alias-headings.csv', bytes: enc.encode(toCSV(aliasHeader, aliasRows, ',', '\n')) },
    { name: 'reduced-columns.csv', bytes: enc.encode(toCSV(reduced, base, ',', '\n')) },
    { name: 'partial-payments.csv', bytes: enc.encode(toCSV(SHOPIFY_COLUMNS, partial, ',', '\n')) },
    { name: 'no-outstanding.csv', bytes: enc.encode(toCSV(noOutstanding, partial, ',', '\n')) },
    { name: 'header-only.csv', bytes: enc.encode(SHOPIFY_COLUMNS.join(',') + '\n\n') },
    { name: 'not-shopify.csv', bytes: enc.encode('a,b,c,d\n1,2,3,4\n') },
    { name: 'two-columns.csv', bytes: enc.encode('Name;Total\n#1;2\n') },
    { name: 'blank.csv', bytes: enc.encode('\n\n  \n') },
    { name: 'empty.csv', bytes: new Uint8Array() },
    { name: 'excel.xlsx', bytes: Uint8Array.of(0x50, 0x4b, 0x03, 0x04, 1, 2, 3) },
    { name: 'binary.csv', bytes: Uint8Array.of(0x41, 0x00, 0x42, 0x00, 0x43) },
  ];
}
