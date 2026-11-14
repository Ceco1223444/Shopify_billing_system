/**
 * Text normalization for detection (P5-03, P5-04): lower case, Unicode NFC, punctuation removed,
 * whitespace collapsed; plus a Latin copy (Bulgarian streamlined system) and a Cyrillic copy, so
 * "ofis ekont", "офис еконт" and "Econt office" can be compared word by word.
 *
 * Every copy has the same words in the same places (letters are replaced inside a word, never
 * split or joined), so a word found in one copy can be removed from the others by its position.
 */
import { latinKey } from '../geo/translit.ts';

/** Lower case, NFC, every non-letter / non-digit → space, single spaces. */
export function normalizeText(text: string | null | undefined): string {
  return (text ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Latin copy of normalized text ("офис еконт" → "ofis ekont"). */
export function toLatin(normalized: string): string {
  return latinKey(normalized);
}

const LATIN_DIGRAPHS: [string, string][] = [
  ['sht', 'щ'],
  ['zh', 'ж'],
  ['ch', 'ч'],
  ['sh', 'ш'],
  ['ts', 'ц'],
  ['yu', 'ю'],
  ['ya', 'я'],
];
const LATIN_LETTERS: Record<string, string> = {
  a: 'а',
  b: 'б',
  c: 'к',
  d: 'д',
  e: 'е',
  f: 'ф',
  g: 'г',
  h: 'х',
  i: 'и',
  j: 'ж',
  k: 'к',
  l: 'л',
  m: 'м',
  n: 'н',
  o: 'о',
  p: 'п',
  q: 'к',
  r: 'р',
  s: 'с',
  t: 'т',
  u: 'у',
  v: 'в',
  w: 'в',
  x: 'кс',
  y: 'й',
  z: 'з',
};

/** Cyrillic copy of normalized text ("ofis ekont" → "офис еконт", "econt" → "еконт"). */
export function toCyrillic(normalized: string): string {
  let out = '';
  let i = 0;
  while (i < normalized.length) {
    const digraph = LATIN_DIGRAPHS.find(([latin]) => normalized.startsWith(latin, i));
    if (digraph) {
      out += digraph[1];
      i += digraph[0].length;
      continue;
    }
    const ch = normalized[i]!;
    out += LATIN_LETTERS[ch] ?? ch;
    i++;
  }
  return out;
}

export interface TextForms {
  normalized: string;
  latin: string;
  cyrillic: string;
  /** Latin words (the copy used for matching and positions). */
  words: string[];
}

export function textForms(text: string | null | undefined): TextForms {
  const normalized = normalizeText(text);
  const latin = toLatin(normalized);
  return {
    normalized,
    latin,
    cyrillic: toCyrillic(latin),
    words: latin ? latin.split(' ') : [],
  };
}

/** Damerau–Levenshtein distance, stopping early above `max`. */
export function editDistance(a: string, b: string, max = 2): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, d[i - 2]![j - 2]! + 1);
      }
      d[i]![j] = v;
      rowMin = Math.min(rowMin, v);
    }
    if (rowMin > max) return max + 1;
  }
  return d[a.length]![b.length]!;
}

/** Words of at least this length may have one typo ("Ekonnt", "Spidy"). Shorter: exact only. */
export const TYPO_MIN_LENGTH = 5;

export interface TermHit {
  term: string;
  /** Word positions in `words` covered by the term. */
  start: number;
  end: number;
  fuzzy: boolean;
}

/**
 * Whole-word matches of `terms` in the text (P5-06: one typo allowed in words of 5+ letters, same
 * first letter). Multi-word terms ("до адрес", "box now") must match word for word.
 */
export function findTerms(forms: TextForms, terms: string[]): TermHit[] {
  const hits: TermHit[] = [];
  const cyrWords = forms.cyrillic ? forms.cyrillic.split(' ') : [];
  for (const term of terms) {
    const termNorm = normalizeText(term);
    if (!termNorm) continue;
    const termLatin = toLatin(termNorm).split(' ');
    const termCyr = toCyrillic(termLatin.join(' ')).split(' ');
    const n = termLatin.length;
    for (let i = 0; i + n <= forms.words.length; i++) {
      let exact = true;
      for (let k = 0; k < n; k++) {
        if (forms.words[i + k] !== termLatin[k] && cyrWords[i + k] !== termCyr[k]) {
          exact = false;
          break;
        }
      }
      if (exact) {
        hits.push({ term, start: i, end: i + n, fuzzy: false });
        continue;
      }
      if (n === 1) {
        const word = forms.words[i]!;
        const want = termLatin[0]!;
        if (
          want.length >= TYPO_MIN_LENGTH &&
          word.length >= TYPO_MIN_LENGTH &&
          word[0] === want[0] &&
          !/\d/.test(word) &&
          editDistance(word, want, 1) <= 1
        ) {
          hits.push({ term, start: i, end: i + 1, fuzzy: true });
        }
      }
    }
  }
  return hits;
}
