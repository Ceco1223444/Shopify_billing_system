/**
 * Every issue the import checks can raise: a machine code, the legacy English
 * text (byte-identical to /legacy/shopify-shipping-converter.html, so the parity
 * tests and the English Excel export match the old tool), plain Bulgarian text
 * for a non-technical reader, and the reason behind it in both languages.
 *
 * `legacy` texts talk about "the workbook" because the old tool only made an
 * Excel file. Where that is wrong inside the app, `en` overrides it.
 */
import type { AppLocale } from '../locale';

export type Severity = 'error' | 'warning' | 'info';

export type PhoneProblem = 'non_digits' | 'bg_missing_zero' | 'bg_length' | 'length';

export const PHONE_PROBLEM_EN: Readonly<Record<PhoneProblem, string>> = {
  non_digits: 'contains characters other than digits',
  bg_missing_zero: 'looks like a Bulgarian mobile number without its leading 0',
  bg_length: 'does not have a usual Bulgarian number length',
  length: 'has an unusual length',
};

const PHONE_PROBLEM_BG: Readonly<Record<PhoneProblem, string>> = {
  non_digits: 'съдържа знаци, които не са цифри',
  bg_missing_zero: 'прилича на български мобилен номер без 0 отпред',
  bg_length: 'няма обичайната дължина на български номер',
  length: 'има необичайна дължина',
};

const PAYMENT_STATUS_BG: Readonly<Record<string, string>> = {
  paid: 'платена',
  partially_paid: 'частично платена',
  partially_refunded: 'частично върнати пари',
  refunded: 'върнати пари',
};

/** A place in a file: file name + first row. */
export interface Place {
  file: string;
  row: number;
}

/** Parameters of each issue code. */
export interface IssueParamMap {
  FILE_EMPTY: Record<string, never>;
  FILE_IS_ZIP: Record<string, never>;
  FILE_NOT_TEXT: Record<string, never>;
  ENCODING_FALLBACK: Record<string, never>;
  UNTERMINATED_QUOTE: Record<string, never>;
  NO_HEADER: Record<string, never>;
  NO_COLUMNS: Record<string, never>;
  DUPLICATE_HEADINGS: { columns: string[] };
  NOT_SHOPIFY_EXPORT: { columns: string[] };
  MISSING_REQUIRED_COLUMNS: { columns: string[] };
  MISSING_OPTIONAL_COLUMNS: { columns: string[] };
  CHECKS_SKIPPED: { columns: string[] };
  UNKNOWN_COLUMNS: { columns: string[] };
  BLANK_ROWS: { count: number };
  EXTRA_VALUES: { rows: number[] };
  SHORT_ROWS: { rows: number[] };
  CONTROL_CHARS: { rows: number[] };
  NO_ORDER_ROWS: Record<string, never>;
  APOSTROPHES_REMOVED: { count: number };
  SAME_FILE: { other: string };
  ID_VALUE_DIFFERS: { row: number; line: number; column: string; value: string; base: string };
  NO_ORDER_NUMBER: { row: number };
  ORPHAN_ROWS: { rows: number[]; order: string };
  MISSING_RECIPIENT: Record<string, never>;
  MISSING_ADDRESS: Record<string, never>;
  MISSING_CITY: Record<string, never>;
  MISSING_ZIP: Record<string, never>;
  COUNTRY_EMPTY: Record<string, never>;
  SHIPS_ABROAD: { country: string };
  COMPANY_DELIVERY: { company: string };
  CUSTOMER_NOTE: { note: string };
  NOTE_ATTRIBUTES: { text: string };
  NO_SHIPPING_PHONE: { alternatives: string[] };
  PHONE_CHECK: { phone: string; problem: PhoneProblem };
  ZIP_NOT_4_DIGITS: { zip: string };
  CANCELLED: { cancelledAt: string };
  FULFILLED: Record<string, never>;
  PARTIALLY_FULFILLED: Record<string, never>;
  OUTSTANDING_DIFFERS: { owed: string; total: string };
  PAYMENT_STATUS: { status: string };
  COD_TOTAL_EMPTY: Record<string, never>;
  PAYMENT_TERMS: { terms: string };
  NO_EMAIL: Record<string, never>;
  LINE_BAD_QUANTITY: { row: number; line: number; quantity: string };
  LINE_NO_NAME: { row: number; line: number };
  LINE_NO_SHIPPING: { row: number; line: number };
  REPEATED_IDENTICAL: { order: string; count: number; places: Place[] };
  REPEATED_CONFLICT: { order: string; count: number; places: Place[] };
  GROUP_DIFFERENT_EMAILS: { emails: string[] };
  GROUP_EMAIL_VARIANTS: { emails: string[] };
  GROUP_DIFFERENT_RECIPIENT: { variants: { orders: string[]; details: string[] }[] };
  GROUP_SAME_PRODUCTS: { orders: string[] };
  EXCLUDED: Record<string, never>;
  /** App only: the last order of a file that ends inside a quoted value. */
  FILE_TRUNCATED_ORDER: Record<string, never>;
}

export type IssueCode = keyof IssueParamMap;
export type IssueParams<C extends IssueCode = IssueCode> = IssueParamMap[C];

type Texts = { [C in IssueCode]: (p: IssueParamMap[C]) => string };
type PartialTexts = { [C in IssueCode]?: (p: IssueParamMap[C]) => string };

/** Legacy behaviour: lists of rows longer than 15 are shortened. */
export function listRows(rows: readonly (number | string)[]): string {
  if (rows.length <= 15) return rows.join(', ');
  return rows.slice(0, 15).join(', ') + ' and ' + (rows.length - 15) + ' more';
}

function listRowsBg(rows: readonly (number | string)[]): string {
  if (rows.length <= 15) return rows.join(', ');
  return rows.slice(0, 15).join(', ') + ' и още ' + (rows.length - 15);
}

const s = (n: number) => (n > 1 ? 's' : '');
const where = (p: Place) => '“' + p.file + '” row ' + p.row;
const nn = (cols: string[]) => cols.length > 1;

/** The legacy English text, exactly as the old tool wrote it. */
export const LEGACY_EN: Texts = {
  FILE_EMPTY: () => 'Not processed: The file is empty.',
  FILE_IS_ZIP: () =>
    'Not processed: This is an Excel/ZIP file, not a CSV. Export the orders from Shopify as a CSV file and import that.',
  FILE_NOT_TEXT: () => 'Not processed: This does not look like a text CSV file.',
  ENCODING_FALLBACK: () =>
    'The file is not UTF-8, so it was read as Windows-1251 (Cyrillic). Check that Bulgarian text looks right.',
  UNTERMINATED_QUOTE: () =>
    'The file ends inside a quoted value, so it may be cut off or damaged. Re-export it from Shopify.',
  NO_HEADER: () => 'Not processed: the file has no column headings.',
  NO_COLUMNS: () =>
    'Not processed: the columns could not be separated (unusual delimiter?). Expected a Shopify order export.',
  DUPLICATE_HEADINGS: (p) =>
    'Column heading repeated: ' + p.columns.join(', ') + '. The first one is used.',
  NOT_SHOPIFY_EXPORT: (p) =>
    'Not processed: this does not look like a Shopify order export (missing ' +
    p.columns.join(', ') +
    ').',
  MISSING_REQUIRED_COLUMNS: (p) =>
    'Missing required column' +
    s(p.columns.length) +
    ': ' +
    p.columns.join(', ') +
    '. These cells are left blank in the workbook.',
  MISSING_OPTIONAL_COLUMNS: (p) =>
    'Optional column' +
    s(p.columns.length) +
    ' not in this file (left blank): ' +
    p.columns.join(', ') +
    '.',
  CHECKS_SKIPPED: (p) =>
    'Not in this file, so the related checks are skipped: ' + p.columns.join(', ') + '.',
  UNKNOWN_COLUMNS: (p) =>
    'Columns not in the shipping layout were left out: ' + p.columns.join(', ') + '.',
  BLANK_ROWS: (p) =>
    p.count + ' empty line' + (p.count > 1 ? 's were' : ' was') + ' skipped (no values).',
  EXTRA_VALUES: (p) =>
    'Rows with more values than column headings (the extra values could not be matched to a column — check the file): rows ' +
    listRows(p.rows) +
    '.',
  SHORT_ROWS: (p) =>
    'Rows with fewer values than column headings (missing values treated as blank): rows ' +
    listRows(p.rows) +
    '.',
  CONTROL_CHARS: (p) =>
    'Invisible control characters were removed from rows ' +
    listRows(p.rows) +
    ' (Excel cannot store them).',
  NO_ORDER_ROWS: () => 'The file has column headings but no order rows.',
  APOSTROPHES_REMOVED: (p) =>
    "Removed Shopify's leading apostrophe from " +
    p.count +
    ' postcode/phone value' +
    s(p.count) +
    ' (it only tells spreadsheets to keep them as text; the workbook stores them as text).',
  SAME_FILE: (p) =>
    'Same content as “' + p.other + '”. Its orders are flagged as repeated imports.',
  ID_VALUE_DIFFERS: (p) =>
    'Row ' +
    p.row +
    ': ' +
    p.column +
    ' "' +
    p.value +
    '" differs from the order\'s first row ("' +
    p.base +
    '"). Kept as exported.',
  NO_ORDER_NUMBER: (p) => 'Row ' + p.row + ' has no order number (Name). Kept as its own record.',
  ORPHAN_ROWS: (p) =>
    'Product row' +
    s(p.rows.length) +
    ' ' +
    p.rows.join(', ') +
    ' belong to order ' +
    p.order +
    ", but the order's first row (with its details) is not directly above. Not merged with any other order — check the export.",
  MISSING_RECIPIENT: () => 'Missing recipient name (Shipping Name).',
  MISSING_ADDRESS: () => 'Missing shipping address.',
  MISSING_CITY: () => 'Missing shipping city.',
  MISSING_ZIP: () => 'Missing postcode (Shipping Zip).',
  COUNTRY_EMPTY: () => 'Shipping country is empty — check the address.',
  SHIPS_ABROAD: (p) =>
    'Ships abroad to ' + p.country + ' — the country is not shown in the workbook.',
  COMPANY_DELIVERY: (p) =>
    'Delivery to a company: “' + p.company + '” (company name is not shown in the workbook).',
  CUSTOMER_NOTE: (p) => 'Customer note (not shown in the workbook): “' + p.note + '”',
  NOTE_ATTRIBUTES: (p) =>
    'Order note attributes, e.g. a chosen office or locker (not shown in the workbook): “' +
    p.text +
    '”',
  NO_SHIPPING_PHONE: (p) =>
    'No shipping phone.' +
    (p.alternatives.length
      ? ' A number exists in Phone/Billing Phone (' +
        p.alternatives.join(' / ') +
        ') — confirm before using it.'
      : ''),
  PHONE_CHECK: (p) =>
    'Check phone "' + p.phone + '": it ' + PHONE_PROBLEM_EN[p.problem] + '. Left unchanged.',
  ZIP_NOT_4_DIGITS: (p) => 'Postcode "' + p.zip + '" is not 4 digits (Bulgarian postcodes have 4).',
  CANCELLED: (p) => 'Cancelled (' + p.cancelledAt + ') — do not ship.',
  FULFILLED: () => 'Already fulfilled in Shopify.',
  PARTIALLY_FULFILLED: () => 'Partially fulfilled — check which items still need shipping.',
  OUTSTANDING_DIFFERS: (p) =>
    'Amount still to pay is ' +
    p.owed +
    ', but Total is ' +
    p.total +
    ' (paid, part-paid or refunded). Check the cash-on-delivery amount — the workbook shows Total.',
  PAYMENT_STATUS: (p) =>
    'Payment status is “' +
    p.status +
    '” — check the cash-on-delivery amount; the workbook shows Total.',
  COD_TOTAL_EMPTY: () => 'Cash-on-delivery order, but Total is empty.',
  PAYMENT_TERMS: (p) => 'Has payment terms (' + p.terms + ') — invoiced, not cash on delivery.',
  NO_EMAIL: () => 'No email — grouped by order number.',
  LINE_BAD_QUANTITY: (p) =>
    'Row ' + p.row + ': quantity "' + p.quantity + '" is not a whole number above 0.',
  LINE_NO_NAME: (p) => 'Row ' + p.row + ': product name is empty.',
  LINE_NO_SHIPPING: (p) => 'Row ' + p.row + ': product does not require shipping.',
  REPEATED_IDENTICAL: (p) =>
    'Order ' +
    p.order +
    ' was imported ' +
    p.count +
    ' times with identical details (' +
    p.places.map(where).join('; ') +
    '). All copies are kept — tick “Exclude” on the extra copy if it is a repeated import.',
  REPEATED_CONFLICT: (p) =>
    'Order ' +
    p.order +
    ' appears ' +
    p.count +
    ' times with different details (' +
    p.places.map(where).join('; ') +
    '). All copies are kept — check which one is current.',
  GROUP_DIFFERENT_EMAILS: (p) =>
    'Grouped as one customer (same email, or same phone number and name), but the orders use different emails: ' +
    p.emails.map((k) => k || '(no email)').join(' / ') +
    '.',
  GROUP_EMAIL_VARIANTS: (p) =>
    'Email written in different ways (' +
    p.emails.join(' / ') +
    ') — treated as the same customer.',
  GROUP_DIFFERENT_RECIPIENT: (p) =>
    'Same customer, different recipient or shipping details: ' +
    p.variants.map((v) => v.orders.join(', ') + ' → ' + v.details.join(', ')).join(' | ') +
    '. Orders are kept separate — confirm each address.',
  GROUP_SAME_PRODUCTS: (p) =>
    'Orders ' +
    p.orders.join(' and ') +
    ' have the same products — possible duplicate purchase. Both are kept; confirm with the customer.',
  EXCLUDED: () => 'This copy was excluded from the workbook by you.',
  FILE_TRUNCATED_ORDER: () =>
    'The file is cut off right after this order, so its details may be incomplete. Re-export the file from Shopify.',
};

/**
 * English inside the app, where the legacy wording describes the old tool
 * (workbook, "Exclude" tick box) instead of what the app does.
 */
const APP_EN: PartialTexts = {
  MISSING_REQUIRED_COLUMNS: (p) =>
    'Missing required column' +
    s(p.columns.length) +
    ': ' +
    p.columns.join(', ') +
    '. These values are empty.',
  MISSING_OPTIONAL_COLUMNS: (p) =>
    'Optional column' +
    s(p.columns.length) +
    ' not in this file (left empty): ' +
    p.columns.join(', ') +
    '.',
  UNKNOWN_COLUMNS: (p) =>
    'Columns that are not in a standard Shopify export: ' +
    p.columns.join(', ') +
    '. They are stored, but not shown by default.',
  APOSTROPHES_REMOVED: (p) =>
    "Removed Shopify's leading apostrophe from " +
    p.count +
    ' postcode/phone value' +
    s(p.count) +
    ' (it only tells spreadsheets to keep them as text).',
  NO_ORDER_NUMBER: (p) => 'Row ' + p.row + ' has no order number (Name). It was not imported.',
  ORPHAN_ROWS: (p) =>
    'Product row' +
    s(p.rows.length) +
    ' ' +
    p.rows.join(', ') +
    ' belong to order ' +
    p.order +
    ", but the order's first row (with its details) is not directly above. Not imported — check the export.",
  SHIPS_ABROAD: (p) => 'Ships abroad to ' + p.country + '.',
  COMPANY_DELIVERY: (p) => 'Delivery to a company: “' + p.company + '”.',
  CUSTOMER_NOTE: (p) => 'Customer note: “' + p.note + '”',
  NOTE_ATTRIBUTES: (p) => 'Order note attributes, e.g. a chosen office or locker: “' + p.text + '”',
  OUTSTANDING_DIFFERS: (p) =>
    'Amount still to pay is ' +
    p.owed +
    ', but Total is ' +
    p.total +
    ' (paid, part-paid or refunded). Check the cash-on-delivery amount.',
  PAYMENT_STATUS: (p) =>
    'Payment status is “' + p.status + '” — check the cash-on-delivery amount.',
  NO_EMAIL: () => 'No email.',
  REPEATED_IDENTICAL: (p) =>
    'Order ' +
    p.order +
    ' is in the file ' +
    p.count +
    ' times with identical details (' +
    p.places.map(where).join('; ') +
    '). It was imported once.',
  REPEATED_CONFLICT: (p) =>
    'Order ' +
    p.order +
    ' is in the file ' +
    p.count +
    ' times with different details (' +
    p.places.map(where).join('; ') +
    '). The first copy was imported — check which one is current.',
  GROUP_SAME_PRODUCTS: (p) =>
    'Orders ' +
    p.orders.join(' and ') +
    ' have the same products — possible duplicate purchase. Confirm with the customer.',
};

const placesBg = (places: Place[]) => places.map((p) => 'ред ' + p.row).join('; ');
const rowWord = (rows: readonly unknown[]) => (rows.length > 1 ? 'редове' : 'ред');

/** Plain Bulgarian for a non-technical reader. */
export const BG: Texts = {
  FILE_EMPTY: () => 'Файлът е празен. Нищо не е внесено.',
  FILE_IS_ZIP: () =>
    'Това е файл на Excel (или ZIP), а не CSV. В Shopify изтеглете поръчките като CSV файл и качете него.',
  FILE_NOT_TEXT: () => 'Това не прилича на CSV файл с текст. Нищо не е внесено.',
  ENCODING_FALLBACK: () =>
    'Файлът не е записан в UTF-8 и е прочетен като кирилица (Windows-1251). Проверете дали българските букви изглеждат правилно.',
  UNTERMINATED_QUOTE: () =>
    'Файлът свършва по средата на текст в кавички — вероятно е прекъснат или повреден. Изтеглете го отново от Shopify.',
  NO_HEADER: () => 'Във файла няма заглавия на колоните. Нищо не е внесено.',
  NO_COLUMNS: () =>
    'Колоните във файла не могат да се разделят една от друга. Очаква се файл с поръчки от Shopify. Нищо не е внесено.',
  DUPLICATE_HEADINGS: (p) =>
    'Колона се повтаря: ' + p.columns.join(', ') + '. Използвана е първата.',
  NOT_SHOPIFY_EXPORT: (p) =>
    'Това не прилича на файл с поръчки от Shopify (липсва: ' +
    p.columns.join(', ') +
    '). Нищо не е внесено.',
  MISSING_REQUIRED_COLUMNS: (p) =>
    (nn(p.columns) ? 'Във файла липсват важни колони: ' : 'Във файла липсва важна колона: ') +
    p.columns.join(', ') +
    '. Тези данни остават празни.',
  MISSING_OPTIONAL_COLUMNS: (p) =>
    (nn(p.columns) ? 'Във файла няма колоните ' : 'Във файла няма колоната ') +
    p.columns.join(', ') +
    ' (не са задължителни). Остават празни.',
  CHECKS_SKIPPED: (p) =>
    'Във файла няма ' + p.columns.join(', ') + ', затова свързаните проверки са пропуснати.',
  UNKNOWN_COLUMNS: (p) =>
    'Колони, които ги няма в обикновения файл от Shopify: ' +
    p.columns.join(', ') +
    '. Запазени са, но не се показват, докато не ги изберете в Настройки.',
  BLANK_ROWS: (p) =>
    p.count > 1 ? p.count + ' празни реда са пропуснати.' : '1 празен ред е пропуснат.',
  EXTRA_VALUES: (p) =>
    'На ' +
    rowWord(p.rows) +
    ' ' +
    listRowsBg(p.rows) +
    ' има повече стойности, отколкото колони. Излишните стойности не могат да се отнесат към колона — проверете файла.',
  SHORT_ROWS: (p) =>
    'На ' +
    rowWord(p.rows) +
    ' ' +
    listRowsBg(p.rows) +
    ' има по-малко стойности, отколкото колони. Липсващите са оставени празни.',
  CONTROL_CHARS: (p) =>
    'Премахнати са невидими служебни знаци от ' + rowWord(p.rows) + ' ' + listRowsBg(p.rows) + '.',
  NO_ORDER_ROWS: () => 'Файлът има заглавия на колоните, но в него няма нито една поръчка.',
  APOSTROPHES_REMOVED: (p) =>
    "Махнат е апострофът (') пред " +
    p.count +
    (p.count > 1 ? ' пощенски кода и телефона' : ' пощенски код или телефон') +
    '. Shopify го слага само заради Excel.',
  SAME_FILE: (p) => 'Същото съдържание като „' + p.other + '“.',
  ID_VALUE_DIFFERS: (p) =>
    'Ред ' +
    p.row +
    ': ' +
    p.column +
    ' е „' +
    p.value +
    '“, а на първия ред на поръчката е „' +
    p.base +
    '“. Оставено е както е във файла.',
  NO_ORDER_NUMBER: (p) => 'Ред ' + p.row + ' няма номер на поръчка. Не е внесен.',
  ORPHAN_ROWS: (p) =>
    (p.rows.length > 1 ? 'Редове ' : 'Ред ') +
    p.rows.join(', ') +
    ' са продукти от поръчка ' +
    p.order +
    ', но първият ред на поръчката (с адреса и сумите) не е точно над тях. Не са внесени — проверете файла.',
  MISSING_RECIPIENT: () => 'Липсва име на получателя.',
  MISSING_ADDRESS: () => 'Липсва адрес за доставка.',
  MISSING_CITY: () => 'Липсва град за доставка.',
  MISSING_ZIP: () => 'Липсва пощенски код.',
  COUNTRY_EMPTY: () => 'Не е посочена държава — проверете адреса.',
  SHIPS_ABROAD: (p) => 'Доставка в чужбина: ' + p.country + '.',
  COMPANY_DELIVERY: (p) => 'Доставка до фирма: „' + p.company + '“.',
  CUSTOMER_NOTE: (p) => 'Бележка от клиента: „' + p.note + '“',
  NOTE_ATTRIBUTES: (p) =>
    'Допълнителна информация към поръчката (например избран офис или автомат): „' + p.text + '“',
  NO_SHIPPING_PHONE: (p) =>
    'Няма телефон за доставка.' +
    (p.alternatives.length
      ? ' Има друг номер (' +
        p.alternatives.join(' / ') +
        ') — потвърдете с клиента, преди да го използвате.'
      : ''),
  PHONE_CHECK: (p) =>
    'Проверете телефона „' + p.phone + '“: ' + PHONE_PROBLEM_BG[p.problem] + '. Оставен е както е.',
  ZIP_NOT_4_DIGITS: (p) =>
    'Пощенският код „' + p.zip + '“ не е от 4 цифри (българските кодове са от 4 цифри).',
  CANCELLED: (p) => 'Поръчката е отказана в Shopify (' + p.cancelledAt + ') — не я изпращайте.',
  FULFILLED: () => 'В Shopify поръчката вече е отбелязана като изпратена.',
  PARTIALLY_FULFILLED: () => 'Част от поръчката вече е изпратена — проверете кои продукти остават.',
  OUTSTANDING_DIFFERS: (p) =>
    'Остава за плащане ' +
    p.owed +
    ', а общата сума е ' +
    p.total +
    ' (платена, частично платена или с върнати пари). Проверете колко да е наложеният платеж.',
  PAYMENT_STATUS: (p) =>
    'Плащане: „' +
    (PAYMENT_STATUS_BG[p.status] ?? p.status) +
    '“ — проверете колко да е наложеният платеж.',
  COD_TOTAL_EMPTY: () => 'Поръчка с наложен платеж, но общата сума е празна.',
  PAYMENT_TERMS: (p) =>
    'Има условия за плащане (' + p.terms + ') — плаща се по фактура, не с наложен платеж.',
  NO_EMAIL: () => 'Няма имейл.',
  LINE_BAD_QUANTITY: (p) =>
    'Ред ' + p.row + ': количеството „' + p.quantity + '“ не е цяло число над 0.',
  LINE_NO_NAME: (p) => 'Ред ' + p.row + ': липсва име на продукта.',
  LINE_NO_SHIPPING: (p) => 'Ред ' + p.row + ': този продукт не се изпраща (не изисква доставка).',
  REPEATED_IDENTICAL: (p) =>
    'Поръчка ' +
    p.order +
    ' е във файла ' +
    p.count +
    ' пъти с еднакви данни (' +
    placesBg(p.places) +
    '). Внесена е веднъж.',
  REPEATED_CONFLICT: (p) =>
    'Поръчка ' +
    p.order +
    ' е във файла ' +
    p.count +
    ' пъти с различни данни (' +
    placesBg(p.places) +
    '). Внесено е първото копие — проверете кое е вярното.',
  GROUP_DIFFERENT_EMAILS: (p) =>
    'Изглежда като един и същ клиент (същият имейл или същите телефон и име), но поръчките са с различни имейли: ' +
    p.emails.map((k) => k || '(без имейл)').join(' / ') +
    '.',
  GROUP_EMAIL_VARIANTS: (p) =>
    'Имейлът е изписан по различен начин (' +
    p.emails.join(' / ') +
    ') — приет е за един и същ клиент.',
  GROUP_DIFFERENT_RECIPIENT: (p) =>
    'Същият клиент, но с различен получател или адрес: ' +
    p.variants.map((v) => v.orders.join(', ') + ' → ' + v.details.join(', ')).join(' | ') +
    '. Поръчките са отделни — потвърдете всеки адрес.',
  GROUP_SAME_PRODUCTS: (p) =>
    'Поръчки ' +
    p.orders.join(' и ') +
    ' са с едни и същи продукти — може клиентът да е поръчал два пъти по грешка. Потвърдете с клиента.',
  EXCLUDED: () => 'Това копие е изключено от вас.',
  FILE_TRUNCATED_ORDER: () =>
    'Файлът е прекъснат точно след тази поръчка — данните ѝ може да са непълни. Изтеглете файла отново от Shopify.',
};

interface Reason {
  bg: string;
  en: string;
}

const R = {
  file: {
    bg: 'Файлът от Shopify трябва да е пълен и неповреден, иначе поръчките може да се внесат грешно.',
    en: 'The Shopify file must be complete and undamaged, otherwise orders may be imported wrongly.',
  },
  columns: {
    bg: 'Без тези колони приложението не може да покаже или провери всичко.',
    en: 'Without these columns the app cannot show or check everything.',
  },
  address: {
    bg: 'Без тези данни куриерът не може да достави пратката. Обадете се на клиента.',
    en: 'The courier cannot deliver without this. Call the customer.',
  },
  phone: {
    bg: 'Куриерът се обажда на получателя. С грешен телефон пратката може да не стигне.',
    en: 'The courier calls the recipient. With a wrong number the parcel may not arrive.',
  },
  money: {
    bg: 'Наложеният платеж трябва да е точно сумата, която клиентът дължи.',
    en: 'The cash-on-delivery amount must be exactly what the customer still owes.',
  },
  lines: {
    bg: 'Трябва да е ясно какво и колко бройки да се опаковат.',
    en: 'It must be clear what to pack and how many.',
  },
  rows: {
    bg: 'Редове без поръчка не могат да се изпратят.',
    en: 'Rows without an order cannot be shipped.',
  },
  customer: {
    bg: 'Поръчки от един клиент може да трябва да тръгнат заедно — или едната да е грешка.',
    en: 'Orders from one customer may need to travel together, or one of them may be a mistake.',
  },
  info: {
    bg: 'За информация — няма нужда от действие.',
    en: 'For information — nothing to do.',
  },
} satisfies Record<string, Reason>;

/** Why each issue matters, in plain words. */
export const REASONS: Readonly<Record<IssueCode, Reason>> = {
  FILE_EMPTY: R.file,
  FILE_IS_ZIP: R.file,
  FILE_NOT_TEXT: R.file,
  ENCODING_FALLBACK: {
    bg: 'Ако буквите са грешни, адресите и имената също ще са грешни.',
    en: 'If the letters are wrong, the names and addresses are wrong too.',
  },
  UNTERMINATED_QUOTE: R.file,
  NO_HEADER: R.file,
  NO_COLUMNS: R.file,
  DUPLICATE_HEADINGS: R.file,
  NOT_SHOPIFY_EXPORT: R.file,
  MISSING_REQUIRED_COLUMNS: R.columns,
  MISSING_OPTIONAL_COLUMNS: R.info,
  CHECKS_SKIPPED: R.columns,
  UNKNOWN_COLUMNS: R.info,
  BLANK_ROWS: R.info,
  EXTRA_VALUES: R.file,
  SHORT_ROWS: R.file,
  CONTROL_CHARS: R.info,
  NO_ORDER_ROWS: R.file,
  APOSTROPHES_REMOVED: R.info,
  SAME_FILE: R.file,
  ID_VALUE_DIFFERS: {
    bg: 'Всички редове на една поръчка трябва да са за един и същ клиент.',
    en: 'All rows of one order must be for the same customer.',
  },
  NO_ORDER_NUMBER: R.rows,
  ORPHAN_ROWS: R.rows,
  MISSING_RECIPIENT: R.address,
  MISSING_ADDRESS: R.address,
  MISSING_CITY: R.address,
  MISSING_ZIP: R.address,
  COUNTRY_EMPTY: {
    bg: 'Държавата помага да се провери дали адресът е верен.',
    en: 'The country helps to check that the address is right.',
  },
  SHIPS_ABROAD: {
    bg: 'Приложението изпраща само в България (Еконт и Спиди).',
    en: 'The app only ships within Bulgaria (Econt and Speedy).',
  },
  COMPANY_DELIVERY: {
    bg: 'Името на фирмата трябва да е на етикета, за да намери куриерът получателя.',
    en: 'The company name must be on the label so the courier finds the recipient.',
  },
  CUSTOMER_NOTE: {
    bg: 'Клиентът може да е написал нещо важно за доставката.',
    en: 'The customer may have written something important for the delivery.',
  },
  NOTE_ATTRIBUTES: {
    bg: 'Тук често пише избраният офис или автомат.',
    en: 'This often holds the chosen office or locker.',
  },
  NO_SHIPPING_PHONE: R.phone,
  PHONE_CHECK: R.phone,
  ZIP_NOT_4_DIGITS: {
    bg: 'Грешен пощенски код може да прати пратката на грешно място.',
    en: 'A wrong postcode can send the parcel to the wrong place.',
  },
  CANCELLED: {
    bg: 'Отказана поръчка не се изпраща.',
    en: 'A cancelled order is never shipped.',
  },
  FULFILLED: {
    bg: 'Може вече да е изпратена — не я изпращайте втори път.',
    en: 'It may already have been sent — do not send it twice.',
  },
  PARTIALLY_FULFILLED: {
    bg: 'Някои продукти може вече да са изпратени.',
    en: 'Some products may already have been sent.',
  },
  OUTSTANDING_DIFFERS: R.money,
  PAYMENT_STATUS: R.money,
  COD_TOTAL_EMPTY: R.money,
  PAYMENT_TERMS: {
    bg: 'Тази поръчка не се плаща при доставката.',
    en: 'This order is not paid on delivery.',
  },
  NO_EMAIL: {
    bg: 'Клиентът се разпознава по телефона и името.',
    en: 'The customer is recognised by phone and name instead.',
  },
  LINE_BAD_QUANTITY: R.lines,
  LINE_NO_NAME: R.lines,
  LINE_NO_SHIPPING: {
    bg: 'Този продукт не се слага в пратката (например подарък или услуга).',
    en: 'This product does not go into the parcel (for example a gift card or a service).',
  },
  REPEATED_IDENTICAL: {
    bg: 'Една поръчка се изпраща само веднъж.',
    en: 'An order is shipped only once.',
  },
  REPEATED_CONFLICT: {
    bg: 'Не е ясно кои данни са верни — проверете в Shopify преди изпращане.',
    en: 'It is not clear which details are right — check in Shopify before shipping.',
  },
  GROUP_DIFFERENT_EMAILS: R.customer,
  GROUP_EMAIL_VARIANTS: R.info,
  GROUP_DIFFERENT_RECIPIENT: R.customer,
  GROUP_SAME_PRODUCTS: R.customer,
  EXCLUDED: R.info,
  FILE_TRUNCATED_ORDER: R.file,
};

/** The text of an issue inside the app, in the given language. */
export function issueText<C extends IssueCode>(
  code: C,
  params: IssueParamMap[C],
  locale: AppLocale,
): string {
  if (locale === 'bg') return BG[code](params);
  const override = APP_EN[code] as ((p: IssueParamMap[C]) => string) | undefined;
  return override ? override(params) : LEGACY_EN[code](params);
}

export function issueReason(code: IssueCode, locale: AppLocale): string {
  return REASONS[code][locale];
}

/** Legacy severity → flag severity (brief: error = red, warning = amber, info = grey). */
export const FLAG_SEVERITY_OF = { error: 'red', warning: 'amber', info: 'info' } as const;
