/**
 * XLSX writer with no libraries (Shipping / Warnings / Notes sheets, yellow rows
 * for multi-order customers and multi-product orders). Ported from the legacy
 * converter. With no options the output is byte-identical to the legacy tool.
 *
 * Options (app only):
 *  - columns: which columns the Shipping sheet has, in which order (the owner's
 *    column setting). Headings stay the Shopify names / "order_id", so the legacy
 *    delivery board can still read the file.
 *  - texts: the Warnings and Notes sheets in the UI language.
 */
import type { ConvertCounts, ExportRow } from './convert';
import type { Severity } from './messages';
import { OUTPUT, PHOTO_HEADER, type ColumnType } from './schema';
import { zip } from './zip';

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NSR = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function cleanText(value: unknown): string {
  let s = String(value)
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex -- legacy behaviour: strips characters Excel cannot store
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '');
  if (s.length > 32767) s = s.slice(0, 32767);
  return s.replace(/_x[0-9A-Fa-f]{4}_/g, (m) => '_x005F' + m);
}
export function colName(i: number): string {
  let s = '';
  let n = i + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

type Side = [string, string];
interface Border {
  left?: Side;
  right?: Side;
  top?: Side;
  bottom?: Side;
}
interface XfOptions {
  bold?: boolean;
  color?: string;
  fill?: string | null;
  border?: Border;
  numFmt?: number;
  valign?: string;
  halign?: string | null;
  wrap?: boolean;
  quote?: boolean;
}

function StyleBook() {
  const fonts: string[] = [];
  const fills = [
    '<fill><patternFill patternType="none"/></fill>',
    '<fill><patternFill patternType="gray125"/></fill>',
  ];
  const borders = ['<border><left/><right/><top/><bottom/><diagonal/></border>'];
  const xfs: string[] = [];
  const maps: Record<'font' | 'fill' | 'border' | 'xf', Record<string, number>> = {
    font: {},
    fill: {},
    border: {},
    xf: {},
  };
  function intern(list: string[], map: Record<string, number>, xml: string): number {
    if (!(xml in map)) {
      map[xml] = list.length;
      list.push(xml);
    }
    return map[xml]!;
  }
  function font(o: XfOptions) {
    return intern(
      fonts,
      maps.font,
      '<font>' +
        (o.bold ? '<b/>' : '') +
        '<sz val="10"/><color rgb="' +
        (o.color || 'FF000000') +
        '"/><name val="Arial"/><family val="2"/></font>',
    );
  }
  function fill(rgb: string | null | undefined) {
    return rgb
      ? intern(
          fills,
          maps.fill,
          '<fill><patternFill patternType="solid"><fgColor rgb="' +
            rgb +
            '"/><bgColor indexed="64"/></patternFill></fill>',
        )
      : 0;
  }
  function side(tag: string, s: Side | undefined) {
    return s
      ? '<' + tag + ' style="' + s[0] + '"><color rgb="' + s[1] + '"/></' + tag + '>'
      : '<' + tag + '/>';
  }
  function border(b: Border | undefined) {
    b = b || {};
    return intern(
      borders,
      maps.border,
      '<border>' +
        side('left', b.left) +
        side('right', b.right) +
        side('top', b.top) +
        side('bottom', b.bottom) +
        '<diagonal/></border>',
    );
  }
  font({});
  function xf(o: XfOptions) {
    const xml =
      '<xf numFmtId="' +
      (o.numFmt || 0) +
      '" fontId="' +
      font(o) +
      '" fillId="' +
      fill(o.fill) +
      '" borderId="' +
      border(o.border) +
      '" xfId="0"' +
      ' applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"' +
      (o.quote ? ' quotePrefix="1"' : '') +
      '>' +
      '<alignment vertical="' +
      (o.valign || 'top') +
      '"' +
      (o.halign ? ' horizontal="' + o.halign + '"' : '') +
      (o.wrap ? ' wrapText="1"' : '') +
      '/></xf>';
    return intern(xfs, maps.xf, xml);
  }
  xf({}); // default style 0
  function xml() {
    return (
      HEAD +
      '<styleSheet xmlns="' +
      NS +
      '">' +
      '<fonts count="' +
      fonts.length +
      '">' +
      fonts.join('') +
      '</fonts>' +
      '<fills count="' +
      fills.length +
      '">' +
      fills.join('') +
      '</fills>' +
      '<borders count="' +
      borders.length +
      '">' +
      borders.join('') +
      '</borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="' +
      xfs.length +
      '">' +
      xfs.join('') +
      '</cellXfs>' +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
      '<dxfs count="0"/><tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/></styleSheet>'
    );
  }
  return { xf, xml };
}

function SharedStrings() {
  const map = new Map<string, number>();
  const list: string[] = [];
  let count = 0;
  return {
    add(s: string) {
      count++;
      let i = map.get(s);
      if (i === undefined) {
        i = list.length;
        list.push(s);
        map.set(s, i);
      }
      return i;
    },
    xml() {
      return (
        HEAD +
        '<sst xmlns="' +
        NS +
        '" count="' +
        count +
        '" uniqueCount="' +
        list.length +
        '">' +
        list.map((s) => '<si><t xml:space="preserve">' + esc(s) + '</t></si>').join('') +
        '</sst>'
      );
    },
  };
}
type Sst = ReturnType<typeof SharedStrings>;

type Cell =
  { k: 'e'; s: number } | { k: 'n'; v: string; s: number } | { k: 's'; v: number; s: number };

const NUM_RE: Record<'money' | 'int', RegExp> = { money: /^-?\d+(\.\d+)?$/, int: /^-?\d+$/ };
const FORMULA_START = /^[=+\-@\t\r]/;
function makeCell(
  raw: unknown,
  type: ColumnType,
  sst: Sst,
  styleFor: (quote: boolean) => number,
): Cell {
  const s = raw == null ? '' : String(raw);
  if (s === '') return { k: 'e', s: styleFor(false) };
  const t = s.trim();
  if ((type === 'money' || type === 'int') && NUM_RE[type].test(t))
    return { k: 'n', v: t.replace(/^(-?)0+(?=\d)/, '$1'), s: styleFor(false) };
  const text = cleanText(s);
  return { k: 's', v: sst.add(text), s: styleFor(FORMULA_START.test(text)) };
}
function cellXml(ref: string, c: Cell): string {
  if (c.k === 'n') return '<c r="' + ref + '" s="' + c.s + '"><v>' + c.v + '</v></c>';
  if (c.k === 's') return '<c r="' + ref + '" s="' + c.s + '" t="s"><v>' + c.v + '</v></c>';
  return '<c r="' + ref + '" s="' + c.s + '"/>';
}

interface SheetRow {
  ht?: number;
  level?: number;
  cells: Cell[];
}
interface Sheet {
  widths: number[];
  rows: SheetRow[];
  freeze?: boolean;
  filter?: boolean;
  maxLevel?: number;
  selected?: boolean;
}
function sheetXml(sh: Sheet): string {
  const ncols = sh.widths.length;
  const nrows = sh.rows.length;
  const last = colName(ncols - 1) + Math.max(nrows, 1);
  let x = HEAD + '<worksheet xmlns="' + NS + '" xmlns:r="' + NSR + '">';
  x += '<sheetPr><outlinePr summaryBelow="0"/></sheetPr>';
  x += '<dimension ref="A1:' + last + '"/>';
  x +=
    '<sheetViews><sheetView workbookViewId="0"' +
    (sh.selected ? ' tabSelected="1"' : '') +
    '>' +
    (sh.freeze
      ? '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/>'
      : '') +
    '</sheetView></sheetViews>';
  x +=
    '<sheetFormatPr defaultRowHeight="12.75"' +
    (sh.maxLevel ? ' outlineLevelRow="' + sh.maxLevel + '"' : '') +
    '/>';
  x +=
    '<cols>' +
    sh.widths
      .map(
        (w, i) =>
          '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>',
      )
      .join('') +
    '</cols>';
  x += '<sheetData>';
  sh.rows.forEach((r, ri) => {
    const rn = ri + 1;
    x +=
      '<row r="' +
      rn +
      '"' +
      (r.ht ? ' ht="' + r.ht + '" customHeight="1"' : '') +
      (r.level ? ' outlineLevel="' + r.level + '"' : '') +
      '>';
    r.cells.forEach((c, ci) => {
      x += cellXml(colName(ci) + rn, c);
    });
    x += '</row>';
  });
  x += '</sheetData>';
  if (sh.filter && nrows > 1) x += '<autoFilter ref="A1:' + last + '"/>';
  x += '<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/>';
  x +=
    '<ignoredErrors><ignoredError sqref="A1:' + last + '" numberStoredAsText="1"/></ignoredErrors>';
  return x + '</worksheet>';
}

/** Square photo cell: ~80 x 80 px (Arial 10: 7 px per character unit; 60 pt row = 80 px). */
export const PHOTO_PX = 80;
export const PHOTO_WIDTH = Math.floor((PHOTO_PX / 7) * 256) / 256;
export const PHOTO_ROW_PT = PHOTO_PX * 0.75;

function estimateHeight(text: string, widthChars: number): number {
  const lines = String(text)
    .split('\n')
    .reduce((a, ln) => a + Math.max(1, Math.ceil(ln.length / Math.max(widthChars - 2, 8))), 0);
  return Math.min(409, Math.max(15, lines * 13 + 3));
}

/** A column of the Shipping sheet. */
export interface XlsxColumn {
  header: string;
  type: ColumnType | 'photo';
  width: number;
  value: (row: ExportRow) => string;
}

/** The legacy layout: Product Photo + the 18 shipping columns. */
export const LEGACY_XLSX_COLUMNS: readonly XlsxColumn[] = [
  { header: PHOTO_HEADER, type: 'photo', width: PHOTO_WIDTH, value: () => '' },
  ...OUTPUT.map((c, i) => ({
    header: c.label,
    type: c.type,
    width: c.width,
    value: (r: ExportRow) => r.values[i + 1] ?? '',
  })),
];

export interface NotesContext {
  stamp: string;
  fileNames: string[];
  counts: ConvertCounts;
  /** the Shipping sheet has the Product Photo column */
  hasPhoto: boolean;
}

export interface XlsxTexts {
  severity: Record<Severity, string>;
  warningHeaders: [string, string, string, string, string, string];
  noWarnings: string;
  /** [text, isTitle] rows of the Notes sheet */
  notes: (ctx: NotesContext) => [string, boolean?][];
}

function legacyNotes(ctx: NotesContext): [string, boolean?][] {
  const c = ctx.counts;
  return [
    ['Shipping workbook', true],
    ['Created ' + ctx.stamp + ' from: ' + ctx.fileNames.join(', ')],
    [
      'Customers: ' +
        c.customers +
        ' · Orders: ' +
        c.orders +
        ' · Product rows: ' +
        c.productRows +
        (c.excludedOrders ? ' · Excluded by you: ' + c.excludedOrders + ' order copies' : '') +
        ' · Errors: ' +
        c.errors +
        ' · Warnings: ' +
        c.warnings,
    ],
    [''],
    ['How to read the Shipping sheet', true],
    [
      '• One row per product. Rows are grouped by customer, then by order number. The same customer = the same email (spaces and capital letters ignored), or the same phone number and the same name. Separate orders are never merged.',
    ],
    [
      '• Yellow rows: a customer with more than one order in this workbook (same email, or same phone number and name), or an order with more than one product (several product rows, or a quantity above 1). White rows: a customer with one order of one product.',
    ],
    [
      "• order_id (the Shopify order number), Email and Shipping Name are repeated on every product row. Other order details (amounts, address, phone, status, payment) appear only on the order's first row, exactly as in Shopify — so Total is counted once per order.",
    ],
    [
      '• Total includes shipping. For unpaid cash-on-delivery orders it is the amount to collect; the Warnings sheet lists orders where the amount still to pay is different.',
    ],
    [
      '• Some Shopify columns are not in this workbook but were still checked: cancelled orders, customer notes, deliveries abroad, company deliveries and payment status are reported on the Warnings sheet.',
    ],
    [
      '• Use the 1 / 2 / 3 buttons at the top left to collapse rows: 1 = first row of each customer, 2 = first row of each order, 3 = all products.',
    ],
    [
      "• Shopify's leading apostrophe on postcodes and phone numbers is removed; these cells are stored as text, so leading zeros and + signs are kept.",
    ],
    ['• Check the Warnings sheet before shipping. Nothing was deleted automatically.'],
    [''],
    ['Adding product photos', true],
    [
      '• Column A (Product Photo) is intentionally empty. Each cell is a square of about 80 × 80 pixels.',
    ],
    [
      '• Crop each photo to a square first (Picture Format → Crop → Aspect Ratio → 1:1, or any photo app).',
    ],
    [
      '• Microsoft 365: select the cell, then Insert → Pictures → Place in Cell. The photo fits the cell and stays with its row when sorting or filtering.',
    ],
    [
      '• Other Excel versions: Insert → Pictures, set height and width to 2.12 cm (0.83 in), place it on the cell, then Format Picture → Properties → Move and size with cells.',
    ],
  ];
}

export const LEGACY_XLSX_TEXTS: XlsxTexts = {
  severity: { error: 'Error', warning: 'Warning', info: 'Info' },
  warningHeaders: ['Severity', 'Order', 'Email', 'Issue', 'File', 'Row(s)'],
  noWarnings: 'No warnings.',
  notes: legacyNotes,
};

/** What buildXlsx needs: the rows, the issues (msg = text to show), the files and the counts. */
export interface XlsxInput {
  rows: readonly ExportRow[];
  issues: readonly {
    sev: Severity;
    order: string;
    email: string;
    msg: string;
    file: string;
    rows: string;
  }[];
  files: readonly { name: string }[];
  counts: ConvertCounts;
}

export interface BuildXlsxOptions {
  now?: Date;
  columns?: readonly XlsxColumn[];
  texts?: XlsxTexts;
}

export function buildXlsx(result: XlsxInput, opts: BuildXlsxOptions = {}): Uint8Array {
  const now = opts.now || new Date();
  const columns = opts.columns || LEGACY_XLSX_COLUMNS;
  const texts = opts.texts || LEGACY_XLSX_TEXTS;
  const st = StyleBook();
  const sst = SharedStrings();
  // Every cell: thin black outline on all four sides. One light yellow for customers with more than one order and for orders with more than one product.
  const C_HEAD = 'FF1F3864';
  const HEAD_FILL = 'FFDCE6F1';
  const MULTI_FILL = 'FFFFF2CC';
  const THIN: Side = ['thin', 'FF000000'];
  const ALL_SIDES: Border = { left: THIN, right: THIN, top: THIN, bottom: THIN };
  const headStyle = st.xf({
    bold: true,
    color: C_HEAD,
    fill: HEAD_FILL,
    wrap: true,
    valign: 'center',
    numFmt: 49,
    border: ALL_SIDES,
  });
  function bodyStyle(type: ColumnType, quote: boolean, multi: boolean) {
    return st.xf({
      border: ALL_SIDES,
      fill: multi ? MULTI_FILL : null,
      wrap: type === 'text',
      numFmt: type === 'money' ? 2 : type === 'int' ? 1 : 49,
      halign: type === 'text' ? null : 'right',
      quote,
    });
  }

  // Sheet 1: Shipping
  const widths = columns.map((c) => c.width);
  const types = columns.map((c) => c.type);
  const hasPhoto = types.includes('photo');
  const srows: SheetRow[] = [
    {
      ht: 30,
      cells: columns.map((c) => ({ k: 's', v: sst.add(c.header), s: headStyle })),
    },
  ];
  let maxLevel = 0;
  result.rows.forEach((r) => {
    maxLevel = Math.max(maxLevel, r.level);
    srows.push({
      // Rows keep the square photo height only when the photo column is there.
      ht: hasPhoto ? PHOTO_ROW_PT : undefined,
      level: r.level,
      cells: columns.map((c, ci) => {
        const t = types[ci]!;
        if (t === 'photo') return { k: 'e', s: bodyStyle('text', false, r.multi) };
        return makeCell(c.value(r), t, sst, (q) => bodyStyle(t, q, r.multi));
      }),
    });
  });

  // Sheet 2: Warnings
  const sevFill: Record<Severity, string> = {
    error: 'FFF8D7DA',
    warning: 'FFFFF3CD',
    info: 'FFDDEBF7',
  };
  const wWidths = [10, 12, 28, 80, 26, 12];
  const wrows: SheetRow[] = [
    {
      ht: 20,
      cells: texts.warningHeaders.map((h) => ({ k: 's', v: sst.add(h), s: headStyle })),
    },
  ];
  const plain = (q: boolean) => st.xf({ wrap: true, numFmt: 49, quote: q });
  if (!result.issues.length)
    wrows.push({
      cells: [
        makeCell('—', 'text', sst, plain),
        makeCell('', 'text', sst, plain),
        makeCell('', 'text', sst, plain),
        makeCell(texts.noWarnings, 'text', sst, plain),
      ],
    });
  result.issues.forEach((is) => {
    const sevStyle = st.xf({ bold: true, fill: sevFill[is.sev], numFmt: 49 });
    wrows.push({
      ht: estimateHeight(is.msg, 80),
      cells: [
        { k: 's', v: sst.add(texts.severity[is.sev]), s: sevStyle },
        makeCell(is.order, 'text', sst, plain),
        makeCell(is.email, 'text', sst, plain),
        makeCell(is.msg, 'text', sst, plain),
        makeCell(is.file, 'text', sst, plain),
        makeCell(is.rows, 'text', sst, plain),
      ],
    });
  });

  // Sheet 3: Notes
  const pad = (n: number) => (n < 10 ? '0' : '') + n;
  const stamp =
    now.getFullYear() +
    '-' +
    pad(now.getMonth() + 1) +
    '-' +
    pad(now.getDate()) +
    ' ' +
    pad(now.getHours()) +
    ':' +
    pad(now.getMinutes());
  const notes = texts.notes({
    stamp,
    fileNames: result.files.map((f) => f.name),
    counts: result.counts,
    hasPhoto,
  });
  const nTitle = st.xf({ bold: true, color: C_HEAD, numFmt: 49 });
  const nrows: SheetRow[] = notes.map((n) => ({
    ht: n[1] ? 18 : estimateHeight(n[0], 110),
    cells: [makeCell(n[0], 'text', sst, (q) => (n[1] ? nTitle : plain(q)))],
  }));

  const sheets: { name: string; xml: string; filterRef?: string | null }[] = [
    {
      name: 'Shipping',
      xml: sheetXml({ widths, rows: srows, freeze: true, filter: true, maxLevel, selected: true }),
      filterRef: srows.length > 1 ? 'A1:' + colName(widths.length - 1) + srows.length : null,
    },
    {
      name: 'Warnings',
      xml: sheetXml({ widths: wWidths, rows: wrows, freeze: true, filter: true }),
      filterRef: wrows.length > 1 ? 'A1:' + colName(wWidths.length - 1) + wrows.length : null,
    },
    { name: 'Notes', xml: sheetXml({ widths: [110], rows: nrows }) },
  ];
  const iso = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const defined = sheets
    .map((s, i) =>
      s.filterRef
        ? '<definedName name="_xlnm._FilterDatabase" localSheetId="' +
          i +
          '" hidden="1">' +
          s.name +
          '!$' +
          s.filterRef.replace(':', ':$').replace(/([A-Z]+)(\d+)/g, '$1$$$2') +
          '</definedName>'
        : '',
    )
    .join('');
  const files: { name: string; data: string | Uint8Array }[] = [
    {
      name: '[Content_Types].xml',
      data:
        HEAD +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        sheets
          .map(
            (_s, i) =>
              '<Override PartName="/xl/worksheets/sheet' +
              (i + 1) +
              '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>',
          )
          .join('') +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' +
        '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
        '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>',
    },
    {
      name: '_rels/.rels',
      data:
        HEAD +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
        '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>',
    },
    {
      name: 'docProps/core.xml',
      data:
        HEAD +
        '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
        '<dc:title>Shipping orders</dc:title><dc:creator>Shipping Workbook Converter</dc:creator>' +
        '<dcterms:created xsi:type="dcterms:W3CDTF">' +
        iso +
        '</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">' +
        iso +
        '</dcterms:modified></cp:coreProperties>',
    },
    {
      name: 'docProps/app.xml',
      data:
        HEAD +
        '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Microsoft Excel</Application></Properties>',
    },
    {
      name: 'xl/workbook.xml',
      data:
        HEAD +
        '<workbook xmlns="' +
        NS +
        '" xmlns:r="' +
        NSR +
        '"><bookViews><workbookView xWindow="0" yWindow="0" windowWidth="28800" windowHeight="15000" activeTab="0"/></bookViews><sheets>' +
        sheets
          .map(
            (s, i) =>
              '<sheet name="' + s.name + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>',
          )
          .join('') +
        '</sheets>' +
        (defined ? '<definedNames>' + defined + '</definedNames>' : '') +
        '</workbook>',
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data:
        HEAD +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        sheets
          .map(
            (_s, i) =>
              '<Relationship Id="rId' +
              (i + 1) +
              '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' +
              (i + 1) +
              '.xml"/>',
          )
          .join('') +
        '<Relationship Id="rId' +
        (sheets.length + 1) +
        '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
        '<Relationship Id="rId' +
        (sheets.length + 2) +
        '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>',
    },
  ];
  sheets.forEach((s, i) => {
    files.push({ name: 'xl/worksheets/sheet' + (i + 1) + '.xml', data: s.xml });
  });
  files.push({ name: 'xl/styles.xml', data: st.xml() });
  files.push({ name: 'xl/sharedStrings.xml', data: sst.xml() });
  return zip(files, now);
}
