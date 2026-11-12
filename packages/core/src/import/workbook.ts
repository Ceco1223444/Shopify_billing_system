/**
 * "Изтегли Excel" for one batch (P2-13): the legacy workbook structure (Shipping /
 * Warnings / Notes, yellow rows, outline levels), built from what the database
 * stores, with the owner's column setting and the UI language.
 */
import type { AppLocale } from '../locale';
import { DEFAULT_VISIBLE_COLUMNS, xlsxColumnsFor } from './columns';
import type { Severity } from './messages';
import type { BatchView } from './stored';
import { buildXlsx, LEGACY_XLSX_TEXTS, type NotesContext, type XlsxTexts } from './xlsx';

export interface StoredFlag {
  severity: 'red' | 'amber' | 'info';
  code: string;
  message_bg: string;
  message_en: string;
  /** order number, or null for an issue about the file */
  order_name: string | null;
  email: string | null;
  source_row: number | null;
  details: { rows?: string; seq?: number; order?: string } | null;
}

const SEV: Record<StoredFlag['severity'], Severity> = {
  red: 'error',
  amber: 'warning',
  info: 'info',
};
const RANK: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

function bgNotes(ctx: NotesContext): [string, boolean?][] {
  const c = ctx.counts;
  const notes: [string, boolean?][] = [
    ['Поръчки за изпращане', true],
    ['Създадено ' + ctx.stamp + ' от: ' + ctx.fileNames.join(', ')],
    [
      'Клиенти: ' +
        c.customers +
        ' · Поръчки: ' +
        c.orders +
        ' · Редове с продукти: ' +
        c.productRows +
        ' · Грешки: ' +
        c.errors +
        ' · Предупреждения: ' +
        c.warnings,
    ],
    [''],
    ['Как се чете листът Shipping', true],
    [
      '• Един ред = един продукт. Редовете са подредени по клиент, после по номер на поръчка. Един клиент = същият имейл или същите телефон и име. Отделните поръчки никога не се сливат.',
    ],
    [
      '• Жълти редове: клиент с повече от една поръчка или поръчка с повече от един продукт. Бели редове: клиент с една поръчка с един продукт.',
    ],
    [
      '• order_id, Email и Shipping Name са на всеки ред. Останалите данни (суми, адрес, телефон, плащане) са само на първия ред на поръчката, както в Shopify — така Total се брои веднъж.',
    ],
    [
      '• Total включва доставката. При наложен платеж това е сумата за събиране, освен ако листът Warnings не казва друго.',
    ],
    [
      '• С бутоните 1 / 2 / 3 горе вляво: 1 = първият ред на всеки клиент, 2 = първият ред на всяка поръчка, 3 = всички продукти.',
    ],
    [
      '• Колоните са според Настройки → Колони. Данните в приложението не се променят от този избор.',
    ],
    ['• Преди изпращане прегледайте листа Warnings. Нищо не е изтрито автоматично.'],
  ];
  if (ctx.hasPhoto)
    notes.push(
      [''],
      ['Снимки на продуктите', true],
      [
        '• Колоната Product Photo е празна нарочно. Всяка клетка е квадрат от около 80 × 80 пиксела.',
      ],
      ['• Microsoft 365: изберете клетката, после Insert → Pictures → Place in Cell.'],
    );
  return notes;
}

export const BG_XLSX_TEXTS: XlsxTexts = {
  severity: { error: 'Грешка', warning: 'Внимание', info: 'Бележка' },
  warningHeaders: ['Важност', 'Поръчка', 'Имейл', 'Проблем', 'Файл', 'Ред(ове)'],
  noWarnings: 'Няма предупреждения.',
  notes: bgNotes,
};

/** The app's English: the legacy texts, minus the photo notes when the photo column is hidden. */
export const EN_XLSX_TEXTS: XlsxTexts = {
  ...LEGACY_XLSX_TEXTS,
  notes: (ctx) => {
    const notes = LEGACY_XLSX_TEXTS.notes(ctx);
    if (ctx.hasPhoto) return notes;
    const i = notes.findIndex((n) => n[0] === 'Adding product photos');
    return i > 0 ? notes.slice(0, i - 1) : notes;
  },
};

export interface BatchWorkbookOptions {
  fileName: string;
  locale: AppLocale;
  visibleColumns: readonly string[];
  now?: Date;
}

/** Warnings in legacy order: errors, warnings, info; file issues first, then by customer and order. */
export function workbookIssues(
  view: BatchView,
  flags: readonly StoredFlag[],
  locale: AppLocale,
  fileName: string,
) {
  const position = new Map<string, number>();
  view.rows.forEach((r, i) => {
    if (!position.has(r.order.name)) position.set(r.order.name, i);
  });
  const seen = new Set<string>();
  const list = flags
    .map((f) => ({
      sev: SEV[f.severity],
      order: f.details?.order || f.order_name || '',
      email: f.email ?? '',
      msg: locale === 'bg' ? f.message_bg : f.message_en,
      file: fileName,
      rows: f.details?.rows || (f.source_row != null ? String(f.source_row) : ''),
      pos: f.order_name == null ? -1 : (position.get(f.order_name) ?? Number.MAX_SAFE_INTEGER),
      seq: f.details?.seq ?? 0,
    }))
    .filter((x) => {
      // A customer issue is stored on each of its orders; list it once.
      const key = [x.sev, x.msg, x.order, x.rows].join('|');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  list.sort((a, b) => RANK[a.sev] - RANK[b.sev] || a.pos - b.pos || a.seq - b.seq);
  return list.map(({ sev, order, email, msg, file, rows }) => ({
    sev,
    order,
    email,
    msg,
    file,
    rows,
  }));
}

export function buildBatchWorkbook(
  view: BatchView,
  flags: readonly StoredFlag[],
  opts: BatchWorkbookOptions,
): Uint8Array {
  const issues = workbookIssues(view, flags, opts.locale, opts.fileName);
  return buildXlsx(
    {
      rows: view.rows,
      issues,
      files: [{ name: opts.fileName }],
      counts: {
        ...view.counts,
        excludedOrders: 0,
        inputRows: view.counts.productRows,
        errors: issues.filter((i) => i.sev === 'error').length,
        warnings: issues.filter((i) => i.sev === 'warning').length,
        infos: issues.filter((i) => i.sev === 'info').length,
      },
    },
    {
      now: opts.now,
      // An empty choice would make a sheet without columns: fall back to the default set.
      columns: xlsxColumnsFor(
        opts.visibleColumns.length ? opts.visibleColumns : DEFAULT_VISIBLE_COLUMNS,
      ),
      texts: opts.locale === 'bg' ? BG_XLSX_TEXTS : EN_XLSX_TEXTS,
    },
  );
}
