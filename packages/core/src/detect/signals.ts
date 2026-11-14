/**
 * What the customer wrote (P5-01 … P5-06): couriers, office / locker words, home words, office
 * codes, street-address patterns, and the remaining words to match against office names.
 *
 * Sources in order of trust: Shipping Address1 / Address2 / Company, then the customer's note and
 * the internal comment. Shipping Method is never read (P5-02).
 */
import type { SupportedCarrier } from '../domain.ts';
import { cleanCity } from '../geo/address.ts';
import { OTHER_COURIER_NAMES, type DetectionDictionary } from './dictionary.ts';
import { findTerms, textForms, type TermHit, type TextForms } from './normalize.ts';

export interface DetectionInput {
  address1?: string | null;
  address2?: string | null;
  company?: string | null;
  /** The customer's note(s) and the internal comment (less trusted). */
  notes?: (string | null | undefined)[];
  city?: string | null;
  zip?: string | null;
  country?: string | null;
  /** P5-02: shown for information only, never read by the detection. */
  shippingMethod?: string | null;
}

export type PointWord = 'office' | 'locker';

export interface Signals {
  carriers: SupportedCarrier[];
  /** A courier we do not ship with (BOX NOW, Sameday, …), display name. */
  otherCourier: string | null;
  pointWords: PointWord[];
  home: boolean;
  /** Street / ж.к. + a number or block in Address1/2 (rules B and D). */
  streetAddress: boolean;
  /** вх. / ет. / ап.: only a home has those. */
  flatDetails: boolean;
  /** Any street-pattern word (ул., бл., №, …) in Address1/2: the "looks like home" hint. */
  streetHints: boolean;
  /** Numbers that may be an office ID or code ("автомат 123", "офис № 4044"). */
  codes: string[];
  /** Latin words left for matching against office names and addresses. */
  remaining: string;
  /** Which source the courier / office words came from. */
  source: 'address' | 'notes' | null;
  /** Some word matched only with a typo allowed ("Ekonnt"). */
  typo: boolean;
}

// Latin forms of the words that are not part of an office's distinctive name.
const STREET_WORDS = new Set([
  'ul',
  'ulitsa',
  'ulica',
  'bul',
  'bulevard',
  'blvd',
  'pl',
  'ploshtad',
  'zh',
  'k',
  'zhk',
  'jk',
  'kv',
  'kvartal',
  'bl',
  'blok',
  'vh',
  'vhod',
  'et',
  'etazh',
  'ap',
  'apartament',
  'no',
  'nomer',
]);
const STOP_WORDS = new Set([
  'do',
  'na',
  'v',
  'vav',
  'za',
  'ot',
  'i',
  'ili',
  's',
  'sas',
  'pri',
  'molya',
  'moia',
  'moya',
  'gr',
  'grad',
  'selo',
  'the',
  'to',
  'at',
  'in',
  'of',
  'my',
  'please',
  'and',
  'or',
  'tsentar',
  'sreshtu',
  'blizo',
  'vse',
  'edno',
  'dostavka',
]);
const STREET_TYPE = new Set(['ul', 'ulitsa', 'ulica', 'bul', 'bulevard', 'blvd', 'pl', 'ploshtad']);
const ESTATE = new Set(['zhk', 'jk', 'kv', 'kvartal']);
const FLAT = new Set(['vh', 'vhod', 'et', 'etazh', 'ap', 'apartament']);
const CODE_PREFIX = new Set(['no', 'nomer', 'kod', 'id', 'code']);

/** Words of the town (and its postcode), never part of an office's distinctive name. */
export function cityWords(city: string | null | undefined, zip?: string | null): Set<string> {
  const words = new Set(textForms(cleanCity(city)).words);
  if (zip) words.add(zip.trim());
  return words;
}

/** The distinctive words: no dictionary words, town, street-type or filler words. */
export function distinctiveWords(
  forms: TextForms,
  consumed: Set<number>,
  town: Set<string>,
): string {
  return forms.words
    .filter(
      (w, i) => !consumed.has(i) && !town.has(w) && !STREET_WORDS.has(w) && !STOP_WORDS.has(w),
    )
    .join(' ');
}

function hasEstate(words: string[]): boolean {
  return words.some((w, i) => ESTATE.has(w) || (w === 'zh' && words[i + 1] === 'k'));
}

interface SourceSignals {
  forms: TextForms;
  hits: Record<keyof DetectionDictionary, TermHit[]>;
}

function scan(text: string, dictionary: DetectionDictionary): SourceSignals {
  const forms = textForms(text);
  const hits = {} as SourceSignals['hits'];
  for (const category of Object.keys(dictionary) as (keyof DetectionDictionary)[]) {
    hits[category] = findTerms(forms, dictionary[category]);
  }
  return { forms, hits };
}

const STREET_HINT = new RegExp(
  '(?<![\\p{L}\\d])(ул|улица|бул|булевард|ж\\.?\\s?к|кв|квартал|бл|блок|вх|ет|ап|ul|ulitsa|bul|zh\\.?\\s?k|jk|kv|bl|vh|et|ap)(?![\\p{L}\\d])|№|(?<![\\p{L}\\d])no\\.?\\s*\\d',
  'iu',
);

export function analyze(input: DetectionInput, dictionary: DetectionDictionary): Signals {
  const addressText = [input.address1, input.address2, input.company]
    .filter((p): p is string => !!p && !!p.trim())
    .join(' , ');
  const notesText = (input.notes ?? []).filter((p): p is string => !!p && !!p.trim()).join(' , ');
  const address = scan(addressText, dictionary);
  const notes = scan(notesText, dictionary);

  const carriers: SupportedCarrier[] = [];
  for (const c of ['econt', 'speedy'] as const) {
    if (address.hits[c].length || notes.hits[c].length) carriers.push(c);
  }
  const pointWords: PointWord[] = [];
  for (const p of ['office', 'locker'] as const) {
    if (address.hits[p].length || notes.hits[p].length) pointWords.push(p);
  }
  // "apt" / "aps" are both a courier and a locker word; "еконтомат" too: fine, both are true.
  const otherText = [addressText, notesText].join(' ');
  const otherHit = address.hits.other.length || notes.hits.other.length;
  const otherCourier = otherHit
    ? (OTHER_COURIER_NAMES.find(([re]) => re.test(otherText))?.[1] ??
      (address.hits.other[0] ?? notes.hits.other[0])!.term.toUpperCase())
    : null;

  const lineForms = textForms([input.address1, input.address2].filter(Boolean).join(' '));
  const words = lineForms.words;
  const hasNumber = words.some((w) => /\d/.test(w));
  const streetAddress = (words.some((w) => STREET_TYPE.has(w)) || hasEstate(words)) && hasNumber;
  const flatDetails = words.some(
    (w, i) => FLAT.has(w) && /\d|^[a-zа-я]$/i.test(words[i + 1] ?? ''),
  );
  const streetHints = STREET_HINT.test([input.address1, input.address2].filter(Boolean).join(' '));

  // Where the courier / office words are, the office name usually is too.
  const has = (s: SourceSignals) =>
    s.hits.econt.length + s.hits.speedy.length + s.hits.office.length + s.hits.locker.length > 0;
  const source = has(address) ? 'address' : has(notes) ? 'notes' : null;
  const chosen = source === 'notes' ? notes : address;

  const consumed = new Set<number>();
  for (const list of Object.values(chosen.hits)) {
    for (const h of list) for (let i = h.start; i < h.end; i++) consumed.add(i);
  }
  const anchors = [
    ...chosen.hits.econt,
    ...chosen.hits.speedy,
    ...chosen.hits.office,
    ...chosen.hits.locker,
  ];
  const codes = new Set<string>();
  chosen.forms.words.forEach((w, i) => {
    if (!/^\d{1,6}$/.test(w)) return;
    const afterPrefix = CODE_PREFIX.has(chosen.forms.words[i - 1] ?? '');
    const nearAnchor = anchors.some((h) => i >= h.end && i - h.end <= 1);
    if (afterPrefix || nearAnchor) codes.add(w);
  });

  const typo = [address, notes].some((s) =>
    Object.values(s.hits).some((list) => list.some((h) => h.fuzzy)),
  );

  return {
    carriers,
    otherCourier,
    pointWords,
    home: address.hits.home.length + notes.hits.home.length > 0,
    streetAddress,
    flatDetails,
    streetHints,
    codes: [...codes],
    remaining: distinctiveWords(chosen.forms, consumed, cityWords(input.city, input.zip)),
    source,
    typo,
  };
}
