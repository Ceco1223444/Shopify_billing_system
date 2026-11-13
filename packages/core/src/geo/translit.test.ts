import { describe, expect, it } from 'vitest';
import { hasCyrillic, latinKey, transliterateBg } from './translit.ts';

describe('transliterateBg (streamlined system)', () => {
  it.each([
    ['София', 'Sofia'],
    ['България', 'Bulgaria'],
    ['Пловдив', 'Plovdiv'],
    ['Стара Загора', 'Stara Zagora'],
    ['Велико Търново', 'Veliko Tarnovo'],
    ['Щастлива', 'Shtastliva'],
    ['Жельо', 'Zhelyo'],
    ['ЖЕЛЮ', 'ZHELYU'],
    ['Юлия', 'Yulia'],
    ['Ямбол', 'Yambol'],
    ['Цар Симеон', 'Tsar Simeon'],
    ['Христо Ботев', 'Hristo Botev'],
    ['бул. Цариградско шосе 115', 'bul. Tsarigradsko shose 115'],
    ['ж.к. Тракия бл. 12, вх. А', 'zh.k. Trakia bl. 12, vh. A'],
    ['Шумен', 'Shumen'],
    ['Айтос', 'Aytos'],
    ['ѝ', 'i'],
  ])('%s → %s', (bg, latin) => {
    expect(transliterateBg(bg)).toBe(latin);
  });

  it('keeps "ия" inside a word as "iya", and only changes it at the end', () => {
    expect(transliterateBg('Илиянци')).toBe('Iliyantsi');
    expect(transliterateBg('Мария, ул. Илия')).toBe('Maria, ul. Ilia');
  });

  it('leaves Latin text and digits alone', () => {
    expect(transliterateBg('Plovdiv 4000, ul. Ivan Vazov 12')).toBe(
      'Plovdiv 4000, ul. Ivan Vazov 12',
    );
  });

  it('latinKey: lower case, one space, same for both scripts', () => {
    expect(latinKey('  София  ')).toBe('sofia');
    expect(latinKey('Sofia')).toBe('sofia');
    expect(latinKey('ВЕЛИКО   ТЪРНОВО')).toBe('veliko tarnovo');
  });

  it('hasCyrillic', () => {
    expect(hasCyrillic('ул. Иван Вазов')).toBe(true);
    expect(hasCyrillic('ul. Ivan Vazov')).toBe(false);
  });
});
