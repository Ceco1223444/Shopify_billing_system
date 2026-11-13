/**
 * Bulgarian → Latin transliteration, "streamlined system" (Закон за транслитерацията, 2009),
 * the system used on Bulgarian road signs and in passports.
 *
 *   а a  б b  в v  г g  д d  е e  ж zh  з z  и i  й y  к k  л l  м m  н n  о o  п p
 *   р r  с s  т t  у u  ф f  х h  ц ts  ч ch  ш sh  щ sht  ъ a  ь y  ю yu  я ya
 *
 * Exceptions: "ия" at the end of a word becomes "ia" (София → Sofia), and the law spells the
 * country's own name "България" as "Bulgaria".
 * Non-Cyrillic characters are kept as they are. Keep in sync with private.bg_latin() in
 * supabase/migrations/*_courier_points.sql (the lower-case form is compared in a test).
 */
// Lower-case Cyrillic letter → Latin.
const LOWER: Record<string, string> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'h',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'sht',
  ъ: 'a',
  ь: 'y',
  ю: 'yu',
  я: 'ya',
  ѝ: 'i',
};

const isLetter = (ch: string | undefined): boolean => !!ch && /\p{L}/u.test(ch);
const isUpper = (ch: string | undefined): boolean =>
  !!ch && ch !== ch.toLowerCase() && ch === ch.toUpperCase();

export function transliterateBg(text: string): string {
  const chars = [
    ...text
      .normalize('NFC')
      .replace(/(?<!\p{L})българия(?!\p{L})/giu, (w) =>
        w === w.toUpperCase() ? 'BULGARIA' : w[0] === 'Б' ? 'Bulgaria' : 'bulgaria',
      ),
  ];
  let out = '';
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    const lower = ch.toLowerCase();
    const next = chars[i + 1];

    // "ия" at the end of a word → "ia".
    if (lower === 'и' && next?.toLowerCase() === 'я' && !isLetter(chars[i + 2])) {
      const upperI = isUpper(ch);
      const upperA = isUpper(next);
      out += (upperI ? 'I' : 'i') + (upperA ? 'A' : 'a');
      i++;
      continue;
    }

    const latin = LOWER[lower];
    if (latin === undefined) {
      out += ch;
      continue;
    }
    if (!isUpper(ch)) {
      out += latin;
      continue;
    }
    // Upper case: "ЖЕЛЮ" → "ZHELYU" (whole word in capitals), "Жельо" → "Zhelyo".
    const wordIsCaps =
      (isUpper(next) || (!isLetter(next) && isUpper(chars[i - 1]))) && latin.length > 1;
    out += wordIsCaps ? latin.toUpperCase() : latin[0]!.toUpperCase() + latin.slice(1);
  }
  return out;
}

/** True when the text contains Cyrillic letters. */
export function hasCyrillic(text: string): boolean {
  return /\p{Script=Cyrillic}/u.test(text);
}

/** Lower-case Latin form used for search and comparisons ("София" and "Sofia" → "sofia"). */
export function latinKey(text: string): string {
  return transliterateBg(text.toLowerCase()).replace(/\s+/g, ' ').trim();
}
