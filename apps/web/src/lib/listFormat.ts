import { intlLocale } from '../i18n';

/** ["Мама", "Тате"] -> "Мама и Тате" (or "Mama and Tate" in English). */
export function formatNameList(names: string[]): string {
  return new Intl.ListFormat(intlLocale(), { style: 'long', type: 'conjunction' }).format(names);
}
