/**
 * P2-02 / T2-01: the legacy converter and the TypeScript port give identical
 * orders, lines and issues (and an identical workbook) on the legacy samples.
 */
import { describe, expect, it } from 'vitest';
import {
  buildXlsx,
  convert,
  decode,
  detectDelimiter,
  hashBytes,
  parseCSV,
  phoneMatchKey,
  phoneProblem,
  productsKey,
  PHONE_PROBLEM_EN,
  sampleFiles,
  SHOPIFY_COLUMNS,
  OUTPUT,
  COL,
  toCSV,
  zip,
  type ConvertResult,
  type FileInput,
} from '../src/import';
import { loadLegacyCore, type LegacyCore } from './legacy';
import { syntheticFiles } from './synthetic';

const legacy: LegacyCore = loadLegacyCore();
const enc = new TextEncoder();

/** The same input objects for both implementations (the legacy UI encodes samples with TextEncoder). */
function sampleInputs(): FileInput[] {
  return sampleFiles().map((s, i) => ({ id: i + 1, name: s.name, bytes: enc.encode(s.text) }));
}

/** Plain JSON copy (the legacy objects live in another JS realm). */
const plain = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const legacyIssue = (is: Any) => ({
  sev: is.sev,
  msg: is.msg,
  file: is.file,
  order: is.order,
  email: is.email,
  rows: is.rows,
  i: is.i,
});

const projectOrder = (o: Any) => ({
  key: o.key,
  uid: o.uid,
  seq: o.seq,
  kind: o.kind,
  fileId: o.fileId,
  fileName: o.fileName,
  firstRow: o.firstRow,
  name: o.name,
  firstCells: o.firstCells,
  first: o.first,
  lines: o.lines.map((l: Any) => ({ out: l.out, row: l.row, carried: l.carried })),
  issues: o.issues.map(legacyIssue),
  excluded: o.excluded,
  dupIssue: o.dupIssue ? legacyIssue(o.dupIssue) : null,
  dupCount: o.dupCount,
});

const projectFile = (f: Any) => ({
  id: f.id,
  name: f.name,
  issues: f.issues.map(legacyIssue),
  orderKeys: f.orders.map((o: Any) => o.key),
  encoding: f.encoding,
  delimiter: f.delimiter,
  dataRows: f.dataRows,
  productRows: f.productRows,
  blankRows: f.blankRows,
  processed: f.processed,
  missingRequired: f.missingRequired,
  missingOptional: f.missingOptional,
  leftOut: f.leftOut,
  unknown: f.unknown,
  apostrophes: f.apostrophes,
  has: f.has,
});

function project(r: ConvertResult | Any) {
  return plain({
    files: r.files.map(projectFile),
    orders: r.orders.map(projectOrder),
    groups: r.groups.map((g: Any) => ({
      key: g.key,
      email: g.email,
      emails: g.emails,
      orders: g.orders.map((o: Any) => o.key),
      issues: g.issues.map(legacyIssue),
      seq: g.seq,
    })),
    issues: r.issues.map(legacyIssue),
    counts: r.counts,
    rows: r.rows.map((x: Any) => ({
      values: x.values,
      multi: x.multi,
      sameCustomer: x.sameCustomer,
      manyProducts: x.manyProducts,
      sep: x.sep,
      level: x.level,
      order: x.order.key,
      line: x.line.row,
      group: x.group.key,
    })),
  });
}

describe('legacy parity: constants', () => {
  it('has the same column lists', () => {
    expect([...SHOPIFY_COLUMNS]).toEqual(plain(legacy.SHOPIFY_COLUMNS));
    expect(plain(OUTPUT)).toEqual(plain(legacy.OUTPUT));
    expect(plain(COL)).toEqual(plain(legacy.COL));
  });

  it('produces the same sample files', () => {
    expect(sampleFiles()).toEqual(plain(legacy.sampleFiles()));
  });
});

describe('legacy parity: sampleFiles()', () => {
  it('gives identical orders, lines, groups, issues, counts and rows (both files together)', () => {
    const inputs = sampleInputs();
    expect(project(convert(inputs))).toEqual(project(legacy.convert(inputs)));
  });

  it('is identical for each sample file on its own (how the app imports them)', () => {
    for (const input of sampleInputs()) {
      expect(project(convert([input]))).toEqual(project(legacy.convert([input])));
    }
  });

  it('is identical when the user excludes a copy', () => {
    const inputs = sampleInputs();
    const ours = convert(inputs);
    const key = ours.orders.find((o) => o.dupIssue)!.key;
    expect(project(convert(inputs, { [key]: true }))).toEqual(
      project(legacy.convert(inputs, { [key]: true })),
    );
  });

  it('really exercises the checks (sanity check on the fixture)', () => {
    const r = convert(sampleInputs());
    expect(r.counts.orders).toBe(13);
    expect(r.counts.errors).toBeGreaterThan(0);
    expect(r.counts.warnings).toBeGreaterThan(0);
    const codes = new Set(r.issues.map((i) => i.code));
    for (const code of [
      'CANCELLED',
      'SHIPS_ABROAD',
      'PHONE_CHECK',
      'NO_SHIPPING_PHONE',
      'CUSTOMER_NOTE',
      'REPEATED_IDENTICAL',
      'REPEATED_CONFLICT',
      'GROUP_EMAIL_VARIANTS',
      'GROUP_DIFFERENT_RECIPIENT',
      'APOSTROPHES_REMOVED',
    ]) {
      expect(codes, code).toContain(code);
    }
  });

  it('builds a byte-identical workbook', () => {
    const inputs = sampleInputs();
    const now = new Date(2026, 10, 12, 14, 5, 7);
    const ours = buildXlsx(convert(inputs), { now });
    const theirs = legacy.buildXlsx(legacy.convert(inputs), { now });
    expect(Buffer.from(ours).equals(Buffer.from(theirs))).toBe(true);
  });
});

describe('legacy parity: synthetic files (T2-02)', () => {
  for (const file of syntheticFiles()) {
    it(`handles "${file.name}" exactly like the legacy tool`, () => {
      const input = { id: 1, name: file.name, bytes: file.bytes };
      expect(project(convert([input]))).toEqual(project(legacy.convert([input])));
      const now = new Date(2026, 10, 12, 9, 0, 0);
      const ours = buildXlsx(convert([input]), { now });
      const theirs = legacy.buildXlsx(legacy.convert([input]), { now });
      expect(Buffer.from(ours).equals(Buffer.from(theirs))).toBe(true);
    });
  }
});

describe('legacy parity: single functions', () => {
  const phones = [
    '',
    '0888000101',
    '+359888000102',
    '00359 888 000 102',
    '359888000102',
    '888000106',
    '988000106',
    '+359 (88) 800-0102',
    '0888 000 10',
    '12345',
    '+390612345678',
    'abc 123',
    '088800010a',
    '02 123 4567',
    '+44 20 7946 0958',
    '0035988800010211',
  ];

  it('phoneMatchKey', () => {
    for (const p of phones) expect(phoneMatchKey(p), p).toBe(legacy.phoneMatchKey(p));
  });

  it('phoneProblem (codes map to the legacy texts)', () => {
    for (const p of phones.filter(Boolean)) {
      for (const country of ['BG', 'bg', '', 'IT', 'NL']) {
        const ours = phoneProblem(p, country);
        expect(ours ? PHONE_PROBLEM_EN[ours] : null, `${p} ${country}`).toBe(
          legacy.phoneProblem(p, country),
        );
      }
    }
  });

  it('productsKey', () => {
    const r = convert(sampleInputs());
    const l = legacy.convert(sampleInputs());
    r.orders.forEach((o, i) => expect(productsKey(o)).toBe(legacy.productsKey(l.orders[i])));
  });

  it('decode, detectDelimiter, parseCSV, hashBytes', () => {
    const texts = [
      'a,b,c\n1,2,3',
      'a;b;c\r\n"x;y";2;3\r\n',
      'a\tb\tc\n1\t2\t3',
      'a|b|c\r1|2|3',
      '"a,""q""",b\n"line\nbreak",2',
      '"unterminated,a,b\n1,2',
      '',
      ',,,\n',
    ];
    for (const t of texts) {
      expect(detectDelimiter(t), t).toBe(legacy.detectDelimiter(t));
      for (const d of [',', ';', '\t', '|'])
        expect(parseCSV(t, d)).toEqual(plain(legacy.parseCSV(t, d)));
      const bytes = enc.encode(t);
      expect(hashBytes(bytes)).toBe(legacy.hashBytes(bytes));
    }
    for (const file of syntheticFiles()) {
      const ours = decode(file.bytes);
      const theirs = legacy.decode(file.bytes);
      expect(ours.error ? { error: ours.error } : ours).toEqual(plain(theirs));
    }
  });

  it('zip and toCSV', () => {
    const now = new Date(2026, 0, 2, 3, 4, 5);
    const entries = [
      { name: 'a.txt', data: 'hello' },
      { name: 'папка/б.csv', data: enc.encode('x,y\n1,2') },
    ];
    expect(Buffer.from(zip(entries, now)).equals(Buffer.from(legacy.zip(entries, now)))).toBe(true);
    const rows: Record<string, string>[] = [{ a: '1', b: 'x;"y"' }, { a: 'line\nbreak' }];
    expect(toCSV(['a', 'b'], rows, ';', '\r\n')).toBe(legacy.toCSV(['a', 'b'], rows, ';', '\r\n'));
  });
});
