/**
 * Synthetic sample data (invented people, example.com emails). Ported from the
 * legacy converter: the parity tests and the import tests use these files.
 */
import { SHOPIFY_COLUMNS } from './schema';

export type CsvRow = Record<string, string>;

export function toCSV(
  header: readonly string[],
  rows: readonly CsvRow[],
  delim: string,
  eol: string,
): string {
  function q(value: unknown): string {
    const v = value == null ? '' : String(value);
    return /["\r\n]/.test(v) || v.indexOf(delim) >= 0 ? '"' + v.replace(/"/g, '""') + '"' : v;
  }
  return (
    [header.map(q).join(delim)]
      .concat(rows.map((r) => header.map((h) => q(r[h])).join(delim)))
      .join(eol) + eol
  );
}

export interface SampleLine {
  title: string;
  sku: string;
  price: number;
  qty: number;
}

export interface SampleOrder {
  name: string;
  id: string;
  email: string;
  created: string;
  recipient: string;
  a1: string;
  a2?: string;
  city: string;
  zip: string;
  province?: string;
  country?: string;
  phone: string;
  notes?: string;
  tags?: string;
  cancelled?: string;
  ship?: number;
  lines: SampleLine[];
}

export function sampleRows(o: SampleOrder): CsvRow[] {
  const sub = o.lines.reduce((a, l) => a + l.price * l.qty, 0);
  const ship = o.ship == null ? (sub >= 60 ? 0 : 4.99) : o.ship;
  const street = o.a1 + (o.a2 ? ', ' + o.a2 : '');
  const base: CsvRow = {
    Name: o.name,
    Email: o.email,
    'Financial Status': 'pending',
    'Fulfillment Status': 'unfulfilled',
    'Accepts Marketing': 'no',
    Currency: 'EUR',
    Subtotal: sub.toFixed(2),
    Shipping: ship.toFixed(2),
    Taxes: '0.00',
    Total: (sub + ship).toFixed(2),
    'Discount Amount': '0.00',
    'Shipping Method': ship ? 'Стандартна доставка' : 'Безплатна доставка',
    'Created at': o.created,
    'Billing Name': o.recipient,
    'Billing Street': street,
    'Billing Address1': o.a1,
    'Billing Address2': o.a2 || '',
    'Billing City': o.city,
    'Billing Zip': "'" + o.zip,
    'Billing Province': o.province || '',
    'Billing Country': o.country || 'BG',
    'Billing Phone': o.phone,
    'Shipping Name': o.recipient,
    'Shipping Street': street,
    'Shipping Address1': o.a1,
    'Shipping Address2': o.a2 || '',
    'Shipping City': o.city,
    'Shipping Zip': "'" + o.zip,
    'Shipping Province': o.province || '',
    'Shipping Country': o.country || 'BG',
    'Shipping Phone': o.phone,
    Notes: o.notes || '',
    'Cancelled at': o.cancelled || '',
    'Payment Method': 'Cash on Delivery (COD)',
    'Refunded Amount': '0.00',
    'Outstanding Balance': (sub + ship).toFixed(2),
    Id: o.id,
    Tags: o.tags || '',
    'Risk Level': 'Low',
    Source: 'web',
    'Payment ID': 'demo-' + o.id,
    'Payment References': 'demo-' + o.id,
  };
  return o.lines.map((l, i) => {
    const r: CsvRow =
      i === 0 ? Object.assign({}, base) : { Name: o.name, Email: o.email, 'Created at': o.created };
    Object.assign(r, {
      'Lineitem quantity': String(l.qty),
      'Lineitem name': l.title,
      'Lineitem price': l.price.toFixed(2),
      'Lineitem compare at price': (l.price + 10).toFixed(2),
      'Lineitem sku': l.sku,
      'Lineitem requires shipping': 'true',
      'Lineitem taxable': 'true',
      'Lineitem fulfillment status': 'pending',
      Vendor: 'DemoStore',
      'Lineitem discount': '0.00',
    });
    return r;
  });
}

export const SAMPLE_PRODUCTS = {
  blue: {
    title: 'Спално бельо Памук – Синьо - Комплект 6 части',
    sku: 'DEMO-BED-BLUE-S6',
    price: 32.99,
  },
  rose: {
    title: 'Спално бельо Сатен – Пепел от рози - Комплект 4 части',
    sku: 'DEMO-BED-ROSE-D4',
    price: 39.99,
  },
  duvet: { title: 'Олекотена завивка - 200×220 см', sku: 'DEMO-DUVET-200X220', price: 31.99 },
  pillow: {
    title: 'Комплект 2 възглавници „Облак“ - 50×70 см',
    sku: 'DEMO-PILLOW-50X70',
    price: 19.99,
  },
  towel: { title: 'Хавлиена кърпа Бамбук – Бяла', sku: 'DEMO-TOWEL-W', price: 12.5 },
} as const;
const P = SAMPLE_PRODUCTS;

export function sampleLine(
  p: { title: string; sku: string; price: number },
  qty?: number,
): SampleLine {
  return { title: p.title, sku: p.sku, price: p.price, qty: qty || 1 };
}
const L = sampleLine;

export const SAMPLE_ORDERS = {
  o2001: {
    name: '#2001',
    id: '9000000002001',
    email: 'ivan.testov@example.com',
    created: '2026-11-02 09:15:00 +0200',
    recipient: 'Иван Тестов',
    a1: 'ул. Примерна 12',
    a2: 'вх. Б\nет. 3, ап. 12',
    city: 'София',
    zip: '1000',
    phone: '0888000101',
    lines: [L(P.blue), L(P.pillow, 2), L(P.towel, 3)],
  },
  o2002: {
    name: '#2002',
    id: '9000000002002',
    email: 'Maria.Testova@Example.com',
    created: '2026-11-02 11:40:00 +0200',
    recipient: 'Мария Тестова',
    a1: 'Офис Еконт – Пловдив Тест',
    city: 'Пловдив',
    zip: '4000',
    phone: '+359888000102',
    notes: 'Моля, обадете се преди доставка.\nСлед 17:00 ч.',
    lines: [L(P.rose)],
  },
  o2003: {
    name: '#2003',
    id: '9000000002003',
    email: 'georgi@example.org',
    created: '2026-11-03 08:05:00 +0200',
    recipient: 'Георги Примеров',
    a1: 'ж.к. Тестов, бл. 5',
    a2: 'ет. 2',
    city: 'Варна',
    zip: '9000',
    phone: '0888000103',
    lines: [L(P.duvet), L(P.pillow)],
  },
  o2004: {
    name: '#2004',
    id: '9000000002004',
    email: 'elena.probna@example.com',
    created: '2026-11-03 13:30:00 +0200',
    recipient: 'Елена Пробна',
    a1: 'бул. Демо 7',
    city: 'Бургас',
    zip: '8000',
    phone: '0888000104',
    notes: '=2+2 (must stay plain text, "not a formula")',
    tags: '@vip',
    lines: [L(P.blue)],
  },
  o2005: {
    name: '#2005',
    id: '9000000002005',
    email: 'lucia@example.com',
    created: '2026-11-04 10:00:00 +0200',
    recipient: 'Lucia Esempio',
    a1: 'Via di Prova 3',
    city: 'Roma',
    zip: '00184',
    province: 'RM',
    country: 'IT',
    phone: '+390612345678',
    ship: 9.99,
    lines: [L(P.rose, 2)],
  },
  o2006: {
    name: '#2006',
    id: '9000000002006',
    email: '',
    created: '2026-11-04 16:20:00 +0200',
    recipient: 'Петър Демов',
    a1: 'ул. Опитна 21',
    city: 'Русе',
    zip: '7000',
    phone: '888000106',
    lines: [L(P.towel, 2)],
  },
  o2007: {
    name: '#2007',
    id: '9000000002007',
    email: ' maria.testova@example.com ',
    created: '2026-11-05 09:00:00 +0200',
    recipient: 'Мария Тестова',
    a1: 'Офис Еконт – Пловдив Тест',
    city: 'Пловдив',
    zip: '4000',
    phone: '+359888000102',
    lines: [L(P.duvet), L(P.towel)],
  },
  o2008: {
    name: '#2008',
    id: '9000000002008',
    email: 'georgi@example.org',
    created: '2026-11-05 12:10:00 +0200',
    recipient: 'Георги Примеров',
    a1: 'Офис Спиди – София Тест',
    city: 'София',
    zip: '1000',
    phone: '0888000103',
    lines: [L(P.blue)],
  },
  o2009: {
    name: '#2009',
    id: '9000000002009',
    email: '',
    created: '2026-11-06 07:45:00 +0200',
    recipient: 'Анна Образцова',
    a1: 'ул. Пробна 4',
    city: 'Стара Загора',
    zip: '6000',
    phone: '',
    lines: [L(P.rose), L(P.pillow)],
  },
  o2010: {
    name: '#2010',
    id: '9000000002010',
    email: 'stoyan@example.com',
    created: '2026-11-06 10:30:00 +0200',
    recipient: 'Стоян Макетов',
    a1: 'ул. Макетна 9',
    city: 'Плевен',
    zip: '5800',
    phone: '0888000110',
    cancelled: '2026-11-06 11:00:00 +0200',
    lines: [L(P.towel)],
  },
  // Same phone and name as #2006 (which has no email) → same customer.
  o2011: {
    name: '#2011',
    id: '9000000002011',
    email: 'petar.demov@example.com',
    created: '2026-11-07 09:30:00 +0200',
    recipient: 'Петър Демов',
    a1: 'ул. Опитна 21',
    city: 'Русе',
    zip: '7000',
    phone: '888000106',
    lines: [L(P.pillow)],
  },
} satisfies Record<string, SampleOrder>;

export interface SampleFile {
  name: string;
  text: string;
}

export function sampleFiles(): SampleFile[] {
  const O = SAMPLE_ORDERS;
  const o2004b: SampleOrder = Object.assign({}, O.o2004, { phone: '0888000999' });
  const file1 = [O.o2001, O.o2002, O.o2003, O.o2004, O.o2005, O.o2006].reduce<CsvRow[]>(
    (a, o) => a.concat(sampleRows(o)),
    [],
  );
  const file2 = [O.o2007, O.o2001, O.o2008, o2004b, O.o2009, O.o2010, O.o2011].reduce<CsvRow[]>(
    (a, o) => a.concat(sampleRows(o)),
    [],
  );
  const shuffled = SHOPIFY_COLUMNS.slice().reverse(); // second file: columns in a different order
  return [
    { name: 'sample-orders-week-1.csv', text: toCSV(SHOPIFY_COLUMNS, file1, ',', '\n') },
    { name: 'sample-orders-week-2.csv', text: '\uFEFF' + toCSV(shuffled, file2, ';', '\r\n') },
  ];
}
