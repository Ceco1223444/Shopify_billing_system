/**
 * Reading raw CSV bytes: encoding detection, delimiter detection, RFC 4180 parser.
 * Ported from the legacy converter ("Reading files"); behaviour is identical.
 */

export type DecodeErrorCode = 'FILE_EMPTY' | 'FILE_IS_ZIP' | 'FILE_NOT_TEXT';
export type Encoding = 'UTF-8' | 'UTF-16' | 'Windows-1251';

export type DecodeResult =
  | { error: string; code: DecodeErrorCode }
  | { text: string; encoding: Encoding; note: string; error?: undefined };

/** The legacy English texts of the decode errors (shown after "Not processed: "). */
export const DECODE_ERRORS: Readonly<Record<DecodeErrorCode, string>> = {
  FILE_EMPTY: 'The file is empty.',
  FILE_IS_ZIP:
    'This is an Excel/ZIP file, not a CSV. Export the orders from Shopify as a CSV file and import that.',
  FILE_NOT_TEXT: 'This does not look like a text CSV file.',
};

export const WINDOWS_1251_NOTE =
  'The file is not UTF-8, so it was read as Windows-1251 (Cyrillic). Check that Bulgarian text looks right.';

/** UTF-8 BOM, UTF-16 LE/BE BOM, strict UTF-8, else Windows-1251 (Cyrillic). */
export function decode(u8: Uint8Array | null | undefined): DecodeResult {
  if (!u8 || u8.length === 0) return { error: DECODE_ERRORS.FILE_EMPTY, code: 'FILE_EMPTY' };
  if (u8[0] === 0x50 && u8[1] === 0x4b && u8[2] === 0x03 && u8[3] === 0x04)
    return { error: DECODE_ERRORS.FILE_IS_ZIP, code: 'FILE_IS_ZIP' };
  let text: string;
  let encoding: Encoding;
  let note = '';
  if (u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) {
    text = new TextDecoder('utf-8').decode(u8.subarray(3));
    encoding = 'UTF-8';
  } else if (u8[0] === 0xff && u8[1] === 0xfe) {
    text = new TextDecoder('utf-16le').decode(u8.subarray(2));
    encoding = 'UTF-16';
  } else if (u8[0] === 0xfe && u8[1] === 0xff) {
    text = new TextDecoder('utf-16be').decode(u8.subarray(2));
    encoding = 'UTF-16';
  } else {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(u8);
      encoding = 'UTF-8';
    } catch {
      text = new TextDecoder('windows-1251').decode(u8);
      encoding = 'Windows-1251';
      note = WINDOWS_1251_NOTE;
    }
  }
  // eslint-disable-next-line no-control-regex -- legacy behaviour: a NUL byte means binary
  if (/\u0000/.test(text.slice(0, 4000)))
    return { error: DECODE_ERRORS.FILE_NOT_TEXT, code: 'FILE_NOT_TEXT' };
  return { text, encoding, note };
}

export type Delimiter = ',' | ';' | '\t' | '|';
const DELIMITERS: readonly Delimiter[] = [',', ';', '\t', '|'];

/** The most frequent of , ; tab | on the first line (outside quotes). Comma on a tie or none. */
export function detectDelimiter(text: string): Delimiter {
  const counts: Record<Delimiter, number> = { ',': 0, ';': 0, '\t': 0, '|': 0 };
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (inQ && text[i + 1] === '"') {
        i++;
        continue;
      }
      inQ = !inQ;
      continue;
    }
    if (!inQ && (c === '\n' || c === '\r')) break;
    if (!inQ && (c === ',' || c === ';' || c === '\t' || c === '|')) counts[c]++;
  }
  let best: Delimiter = ',';
  let max = 0;
  for (const d of DELIMITERS) {
    if (counts[d] > max) {
      max = counts[d];
      best = d;
    }
  }
  return best;
}

export interface ParsedCsv {
  records: string[][];
  /** the text ended inside a quoted value (file cut off or damaged) */
  unterminated: boolean;
}

/** RFC 4180 parser: quoted fields, doubled quotes, delimiters and line breaks inside quotes, CRLF/LF/CR. */
export function parseCSV(text: string, delim: string): ParsedCsv {
  const records: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQ = false;
  let quoted = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQ = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"' && field === '' && !quoted) {
      inQ = true;
      quoted = true;
      i++;
      continue;
    }
    if (c === delim) {
      row.push(field);
      field = '';
      quoted = false;
      i++;
      continue;
    }
    if (c === '\r' || c === '\n') {
      row.push(field);
      records.push(row);
      row = [];
      field = '';
      quoted = false;
      if (c === '\r' && text[i + 1] === '\n') i++;
      i++;
      continue;
    }
    field += c;
    i++;
  }
  if (field !== '' || quoted || row.length) {
    row.push(field);
    records.push(row);
  }
  return { records, unterminated: inQ };
}

/** FNV-1a + length. Only used to notice the same file imported twice (legacy). */
export function hashBytes(u8: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < u8.length; i++) {
    h ^= u8[i]!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16) + ':' + u8.length;
}

/** SHA-256 as lower-case hex (Web Crypto: browsers, Node, Deno). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
