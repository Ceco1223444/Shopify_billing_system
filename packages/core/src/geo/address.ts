/**
 * Shopify shipping address → geocoder queries and a cache key (Phase 4, P4-20 … P4-25).
 *
 * Bulgarian addresses mix a street ("ул. Иван Вазов 12"), a housing estate ("ж.к. Тракия"),
 * a block ("бл. 54") and flat details ("вх. А, ет. 3, ап. 9"). The geocoder never needs the
 * flat details, so they are removed from the queries AND from the cache key: two flats in the
 * same block share one cache entry, and less personal detail leaves the database.
 */
import { hasCyrillic, transliterateBg } from './translit.ts';

/** The Shopify CSV address fields (Shipping Address1, Address2, City, Zip, Province, Country). */
export interface GeocodeInput {
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  zip?: string | null;
  province?: string | null;
  country?: string | null;
}

export const GEOCODE_PRECISIONS = ['street', 'block', 'quarter', 'city', 'failed'] as const;
export type GeocodePrecision = (typeof GEOCODE_PRECISIONS)[number];

/** Which variant a query is (P4-21), most precise first. */
export type QueryVariantKind =
  | 'original'
  | 'original_no_zip'
  | 'latin'
  | 'street_only'
  | 'quarter_block'
  | 'quarter'
  | 'city_zip'
  | 'city';

export interface QueryVariant {
  kind: QueryVariantKind;
  /** Free-form query text sent to the geocoder (country is restricted separately). */
  q: string;
}

export interface ParsedAddress {
  /** Address1 + Address2 without flat details (entrance, floor, apartment). */
  line: string;
  streetType: string | null;
  street: string | null;
  number: string | null;
  quarter: string | null;
  block: string | null;
  city: string | null;
  zip: string | null;
}

// Word boundaries that also work for Cyrillic (JavaScript's \b is ASCII only).
const B = '(?<![\\p{L}\\d])';
const E = '(?![\\p{L}\\d])';

const FLAT_DETAILS = new RegExp(
  `${B}(?:вх(?:од)?|vh(?:od)?|entrance|ет(?:аж)?|et(?:azh)?|floor|ап(?:артамент)?|ap(?:artament)?|apt)${E}\\.?\\s*[:№#]?\\s*[\\p{L}\\d]{1,4}${E}`,
  'giu',
);
const QUARTER = new RegExp(
  `${B}(?:ж\\.?\\s*к\\.?|жк|кв\\.?|квартал|к-с|комплекс|zh\\.?\\s*k\\.?|zhk|kv\\.?|kvartal)${E}\\.?\\s*([^,;]+?)\\s*(?=[,;]|${B}(?:бл|блок|bl|blok|ул|улица|бул|булевард|ul|bul|blvd)${E}|$)`,
  'iu',
);
const BLOCK = new RegExp(`${B}(?:бл|блок|bl|blok)${E}\\.?\\s*[№#]?\\s*(\\d+[\\p{L}]?)`, 'iu');
const STREET = new RegExp(
  `${B}(ул|улица|бул|булевард|пл|площад|ul|ulitsa|bul|blvd|bulevard|pl)${E}\\.?\\s*([^,;\\d№#]+)(?:(?:№|#)?\\s*(\\d+[\\p{L}]?)${E})?`,
  'iu',
);
// A street name stops where a ж.к. / бл. part starts; "No" before the number is not part of it.
const STREET_CUT = new RegExp(`\\s+${B}(?:ж\\.?\\s*к|жк|кв|бл|блок|bl|zhk|kv)${E}.*$`, 'iu');
const STREET_NO = /\s+(?:No|N|номер)\.?\s*$/iu;
const CITY_PREFIX = new RegExp(`^\\s*(?:гр|град|с|село|gr|grad|s|selo)${E}\\.?\\s*`, 'iu');

/** Trim, unify spaces and drop typographic quotes. */
export function cleanPart(text: string | null | undefined): string {
  return (text ?? '')
    .normalize('NFC')
    .replace(/[„“”"«»]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Remove entrance / floor / apartment details ("вх. А, ет. 3, ап. 9"). */
export function stripFlatDetails(text: string): string {
  return cleanPart(
    text
      .replace(FLAT_DETAILS, ' ')
      .replace(/\s*,(\s*,)+/g, ',')
      .replace(/^[\s,;]+|[\s,;]+$/g, ''),
  );
}

export function cleanCity(city: string | null | undefined): string {
  return cleanPart(city).replace(CITY_PREFIX, '').trim();
}

export function cleanZip(zip: string | null | undefined): string | null {
  const digits = cleanPart(zip).replace(/^'/, '');
  return /^\d{4}$/.test(digits) ? digits : null;
}

export function parseBgAddress(input: GeocodeInput): ParsedAddress {
  const line = stripFlatDetails(
    [cleanPart(input.address1), cleanPart(input.address2)].filter(Boolean).join(', '),
  );
  const street = STREET.exec(line);
  const quarter = QUARTER.exec(line);
  const block = BLOCK.exec(line);
  const rawName = street?.[2] ?? '';
  const cut = STREET_CUT.test(rawName);
  const streetName = rawName.replace(STREET_CUT, '').replace(STREET_NO, '').trim() || null;
  return {
    line,
    streetType: streetName ? (street?.[1] ?? null) : null,
    street: streetName,
    // A number after a cut-off name ("ул. X жк Y 5") belongs to the ж.к., not the street.
    number: streetName && !cut ? (street?.[3] ?? null) : null,
    quarter: quarter?.[1]?.trim() || null,
    block: block?.[1] ?? null,
    city: cleanCity(input.city) || null,
    zip: cleanZip(input.zip),
  };
}

/**
 * The address line as a geocoder query: no "No"/"№" before house numbers and no notes in
 * brackets ("ул. Славянска No 34 (ДО КАСИТЕ)" → "ул. Славянска 34").
 */
export function queryLine(line: string): string {
  return cleanPart(
    line
      .replace(/\([^)]*\)/g, ' ')
      .replace(new RegExp(`${B}(?:No|N|номер)${E}\\.?\\s*(?=\\d)|№\\s*`, 'giu'), '')
      .replace(/\s+,/g, ','),
  );
}

/** True when the country field is empty or means Bulgaria (P4-23). */
export function isBulgaria(country: string | null | undefined): boolean {
  const c = cleanPart(country).toLowerCase();
  return c === '' || c === 'bg' || c === 'bgr' || c === 'bulgaria' || c === 'българия';
}

/**
 * Query variants, most precise first (P4-21): the original text (Cyrillic as typed), without the
 * postcode, transliterated to Latin, the street without the ж.к./бл. parts, the ж.к. + бл. without
 * the street, the ж.к. alone, then city + postcode and the city alone. Duplicates are dropped.
 */
export function buildQueryVariants(input: GeocodeInput): QueryVariant[] {
  const a = parseBgAddress(input);
  if (!a.city) return [];
  const city = a.city;
  const out: QueryVariant[] = [];
  const add = (kind: QueryVariantKind, parts: (string | null)[]) => {
    const q = parts.filter((p): p is string => !!p && p.trim() !== '').join(', ');
    if (q && !out.some((v) => v.q.toLowerCase() === q.toLowerCase())) out.push({ kind, q });
  };

  const line = queryLine(a.line);
  if (line) {
    add('original', [line, a.zip ? `${a.zip} ${city}` : city]);
    add('original_no_zip', [line, city]);
    if (hasCyrillic(`${line}, ${city}`))
      add('latin', [transliterateBg(line), transliterateBg(city)]);
  }
  const streetText = a.street
    ? `${a.streetType ? `${a.streetType}.` : ''} ${a.street}${a.number ? ` ${a.number}` : ''}`.trim()
    : null;
  if (streetText && (a.quarter || a.block)) add('street_only', [streetText, city]);
  if (a.quarter && a.block) add('quarter_block', [`ж.к. ${a.quarter}`, `бл. ${a.block}`, city]);
  if (a.quarter) add('quarter', [`ж.к. ${a.quarter}`, city]);
  if (a.zip) add('city_zip', [`${a.zip} ${city}`]);
  add('city', [city]);
  return out;
}

// --- Cache key (P4-25) --------------------------------------------------------------------

const KEY_WORDS: [RegExp, string][] = [
  [new RegExp(`${B}улица${E}`, 'gu'), 'ул'],
  [new RegExp(`${B}булевард${E}`, 'gu'), 'бул'],
  [new RegExp(`${B}ж\\s*к${E}`, 'gu'), 'жк'],
  [new RegExp(`${B}квартал${E}`, 'gu'), 'кв'],
  [new RegExp(`${B}блок${E}`, 'gu'), 'бл'],
  [new RegExp(`${B}площад${E}`, 'gu'), 'пл'],
  [new RegExp(`${B}(?:номер|no)${E}`, 'gu'), ' '],
];

/** Lower case, unified abbreviations, no punctuation: "ул. Иван Вазов №12" → "ул иван вазов 12". */
export function normalizeForKey(text: string | null | undefined): string {
  let s = cleanPart(text).toLowerCase();
  s = s.replace(/[.,;:()\\/\-–—_'`№#+]/g, ' ').replace(/\s+/g, ' ');
  for (const [re, to] of KEY_WORDS) s = s.replace(re, to);
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * The same address always gives the same key, however it was typed (spacing, punctuation,
 * "ул." vs "улица", "гр. Пловдив" vs "Пловдив", flat details). Original script is kept: a
 * Cyrillic and a Latin spelling are different keys, to avoid mixing up similar street names.
 */
export function addressKey(input: GeocodeInput): string {
  const a = parseBgAddress(input);
  return [
    'bg',
    normalizeForKey(input.province),
    normalizeForKey(a.city),
    a.zip ?? '',
    normalizeForKey(a.line),
  ].join('|');
}
