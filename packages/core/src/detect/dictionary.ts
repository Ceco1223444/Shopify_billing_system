/**
 * Detection keyword dictionary (P5-05), seeded from Appendix B of the prompt pack. The owner can
 * add words in Settings (`settings.detection_dictionary`); they are merged with these and never
 * replace them.
 *
 * Words are matched on normalized text (lower case, no punctuation) and on its Latin and
 * Cyrillic copies, as whole words: "apt" must not match inside "apteka" (аптека).
 */

export const DICTIONARY_CATEGORIES = [
  'econt',
  'speedy',
  'other',
  'office',
  'locker',
  'home',
] as const;
export type DictionaryCategory = (typeof DICTIONARY_CATEGORIES)[number];

export type DetectionDictionary = Record<DictionaryCategory, string[]>;

/** Appendix B. */
export const BASE_DICTIONARY: DetectionDictionary = {
  econt: [
    'еконт',
    'еконта',
    'econt',
    'ekont',
    'ekonta',
    'е-конт',
    'еконтомат',
    'econtomat',
    'ekontomat',
    'aps',
  ],
  speedy: ['спиди', 'спийди', 'спидито', 'speedy', 'spidi', 'spiidi', 'apt'],
  other: ['box now', 'boxnow', 'бокс нау', 'боксноу', 'sameday', 'сеймдей', 'pigeon', 'пиджън'],
  office: ['офис', 'офиса', 'ofis', 'office', 'клон', 'филиал'],
  locker: [
    'автомат',
    'автомата',
    'avtomat',
    'пакетомат',
    'paketomat',
    'локер',
    'locker',
    'еконтомат',
    'econtomat',
    'ekontomat',
    'apt',
    'aps',
  ],
  home: [
    'личен адрес',
    'до адрес',
    'адресна доставка',
    'доставка до адрес',
    'до врата',
    'до вкъщи',
    'вкъщи',
    'домашен адрес',
    'до дома',
    'lichen adres',
    'do adres',
    'home address',
    'to address',
    'to my address',
    'to the door',
    'door delivery',
  ],
};

/** The owner's extra words (settings.detection_dictionary): any subset of the categories. */
export type DictionaryAdditions = Partial<Record<DictionaryCategory, string[]>>;

/** Base + the owner's words, without duplicates or empty entries. */
export function mergeDictionary(
  additions: DictionaryAdditions | null | undefined,
): DetectionDictionary {
  const out = {} as DetectionDictionary;
  for (const category of DICTIONARY_CATEGORIES) {
    const words = [...BASE_DICTIONARY[category], ...(additions?.[category] ?? [])]
      .map((w) => (typeof w === 'string' ? w.trim().toLowerCase() : ''))
      .filter(Boolean);
    out[category] = [...new Set(words)];
  }
  return out;
}

/** Display names of the other couriers, for the reason text (BOX NOW → "BOX NOW"). */
export const OTHER_COURIER_NAMES: [RegExp, string][] = [
  [/box\s*now|бокс\s*нау|боксноу/i, 'BOX NOW'],
  [/sameday|сеймдей/i, 'Sameday'],
  [/pigeon|пиджън/i, 'Pigeon Express'],
];
