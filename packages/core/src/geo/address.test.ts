import { describe, expect, it } from 'vitest';
import {
  addressKey,
  buildQueryVariants,
  cleanCity,
  cleanZip,
  isBulgaria,
  normalizeForKey,
  parseBgAddress,
  queryLine,
  stripFlatDetails,
} from './address.ts';

describe('stripFlatDetails', () => {
  it.each([
    ['ж.к. Тракия бл. 12, вх. А, ет. 3, ап. 9', 'ж.к. Тракия бл. 12'],
    ['ул. Иван Вазов 12, ет.2 ап.5', 'ул. Иван Вазов 12'],
    ['жк Люлин 7 бл 712 вход Б етаж 4 апартамент 15', 'жк Люлин 7 бл 712'],
    ['zh.k. Mladost 1, bl. 5, vh. V, et. 6, ap. 21', 'zh.k. Mladost 1, bl. 5'],
  ])('%s → %s', (input, output) => {
    expect(stripFlatDetails(input)).toBe(output);
  });
});

describe('parseBgAddress', () => {
  it('a street with a number', () => {
    const a = parseBgAddress({
      address1: 'ул. „Кукленско шосе“ №11',
      city: 'гр. Пловдив',
      zip: '4000',
    });
    expect(a).toMatchObject({
      streetType: 'ул',
      street: 'Кукленско шосе',
      number: '11',
      quarter: null,
      block: null,
      city: 'Пловдив',
      zip: '4000',
    });
  });

  it('"No" before the number and a letter after it', () => {
    const a = parseBgAddress({ address1: 'бул. Св. Димитър Солунски No 26А', city: 'Благоевград' });
    expect(a).toMatchObject({ streetType: 'бул', street: 'Св. Димитър Солунски', number: '26А' });
  });

  it('a housing estate with a block and flat details', () => {
    const a = parseBgAddress({
      address1: 'ж.к. Тракия бл. 54',
      address2: 'вх. Б, ет. 4, ап. 11',
      city: 'Пловдив',
    });
    expect(a).toMatchObject({
      street: null,
      quarter: 'Тракия',
      block: '54',
      line: 'ж.к. Тракия бл. 54',
    });
  });

  it('a street AND a housing estate', () => {
    const a = parseBgAddress({ address1: 'жк Младост 1, ул. Никола Габровски 12', city: 'София' });
    expect(a).toMatchObject({ quarter: 'Младост 1', street: 'Никола Габровски', number: '12' });
  });

  it('a street name cut where the ж.к. starts keeps the number for the ж.к.', () => {
    const a = parseBgAddress({ address1: 'ул. Охрид жк Изгрев 5', city: 'Бургас' });
    expect(a.street).toBe('Охрид');
    expect(a.number).toBeNull();
    expect(a.quarter).toBe('Изгрев 5');
  });

  it('Latin keywords', () => {
    const a = parseBgAddress({ address1: 'ul. Ivan Vazov 12, et. 3', city: 'Sofia' });
    expect(a).toMatchObject({
      streetType: 'ul',
      street: 'Ivan Vazov',
      number: '12',
      city: 'Sofia',
    });
  });
});

describe('small cleaners', () => {
  it('cleanCity drops гр. / с. / град', () => {
    expect(cleanCity('гр. Пловдив')).toBe('Пловдив');
    expect(cleanCity('с.Белозем')).toBe('Белозем');
    expect(cleanCity('град София')).toBe('София');
    expect(cleanCity('Стара Загора')).toBe('Стара Загора');
  });

  it("cleanZip keeps 4 digits only (the legacy tool strips Shopify's apostrophe too)", () => {
    expect(cleanZip("'4000")).toBe('4000');
    expect(cleanZip(' 1000 ')).toBe('1000');
    expect(cleanZip('40000')).toBeNull();
    expect(cleanZip(null)).toBeNull();
  });

  it('isBulgaria (P4-23)', () => {
    for (const c of [null, '', 'BG', 'bg', 'Bulgaria', 'България', 'BGR'])
      expect(isBulgaria(c)).toBe(true);
    for (const c of ['RO', 'Greece', 'DE']) expect(isBulgaria(c)).toBe(false);
  });
});

describe('buildQueryVariants (P4-21)', () => {
  it('street address: original (with and without postcode), bare street, Latin, city + postcode, city', () => {
    const v = buildQueryVariants({
      address1: 'ул. Кукленско шосе 11',
      address2: 'ет. 2',
      city: 'Пловдив',
      zip: '4000',
    });
    expect(v).toEqual([
      { kind: 'original', q: 'ул. Кукленско шосе 11, 4000 Пловдив' },
      { kind: 'original_no_zip', q: 'ул. Кукленско шосе 11, Пловдив' },
      { kind: 'street_bare', q: 'Кукленско шосе 11, Пловдив' },
      { kind: 'latin', q: 'ul. Kuklensko shose 11, Plovdiv' },
      { kind: 'city_zip', q: '4000 Пловдив' },
      { kind: 'city', q: 'Пловдив' },
    ]);
  });

  it('ж.к. + бл.: with and without the block, then the ж.к. alone', () => {
    const v = buildQueryVariants({ address1: 'ж.к. Тракия бл. 54, вх. Б', city: 'Пловдив' });
    expect(v.map((x) => x.kind)).toEqual(['original', 'latin', 'quarter_block', 'quarter', 'city']);
    expect(v.find((x) => x.kind === 'quarter_block')?.q).toBe('ж.к. Тракия, бл. 54, Пловдив');
    expect(v.find((x) => x.kind === 'quarter')?.q).toBe('ж.к. Тракия, Пловдив');
  });

  it('street + ж.к.: the street without the ж.к. part', () => {
    const v = buildQueryVariants({
      address1: 'жк Младост 1, ул. Никола Габровски 12',
      city: 'София',
    });
    expect(v.find((x) => x.kind === 'street_only')?.q).toBe('ул. Никола Габровски 12, София');
    expect(v.find((x) => x.kind === 'street_bare')?.q).toBe('Никола Габровски 12, София');
  });

  it('a house number range: the first number', () => {
    const v = buildQueryVariants({ address1: 'ул. Марагидик 10-12', city: 'София' });
    expect(v.find((x) => x.kind === 'street_bare')?.q).toBe('Марагидик 10, София');
  });

  it('never contains flat details, names or phones', () => {
    const v = buildQueryVariants({
      address1: 'ж.к. Люлин бл. 312, вх. А, ет. 7, ап. 41',
      city: 'София',
    });
    for (const x of v) expect(x.q).not.toMatch(/вх|ет\.|ап\./);
  });

  it('queries carry no "No"/"№" before the number and no notes in brackets', () => {
    const v = buildQueryVariants({
      address1: 'ул. Славянска No 34 (ДО КАСИТЕ)',
      city: 'Айтос',
      zip: '8500',
    });
    expect(v[0]).toEqual({ kind: 'original', q: 'ул. Славянска 34, 8500 Айтос' });
    expect(queryLine('бул. „Христо Ботев“ №5, ет. 2')).toBe('бул. Христо Ботев 5, ет. 2');
  });

  it('Latin input gets no extra Latin variant', () => {
    const v = buildQueryVariants({ address1: 'ul. Ivan Vazov 12', city: 'Sofia' });
    expect(v.map((x) => x.kind)).toEqual(['original', 'street_bare', 'city']);
    expect(v[1]?.q).toBe('Ivan Vazov 12, Sofia');
  });

  it('no city → nothing to ask', () => {
    expect(buildQueryVariants({ address1: 'ул. Иван Вазов 12' })).toEqual([]);
  });
});

describe('addressKey (P4-25)', () => {
  const base = { address1: 'ул. Иван Вазов 12', city: 'Пловдив', zip: '4000' };

  it('is the same however the same address is typed', () => {
    const k = addressKey(base);
    expect(
      addressKey({ address1: 'улица  Иван Вазов №12', city: 'гр. Пловдив', zip: "'4000" }),
    ).toBe(k);
    expect(
      addressKey({
        address1: 'ул.Иван Вазов 12',
        address2: 'ет. 3, ап. 7',
        city: 'Пловдив',
        zip: '4000',
      }),
    ).toBe(k);
    expect(addressKey({ ...base, address1: 'УЛ. ИВАН ВАЗОВ 12' })).toBe(k);
  });

  it('differs for a different street, number, city or postcode', () => {
    const k = addressKey(base);
    expect(addressKey({ ...base, address1: 'ул. Иван Вазов 14' })).not.toBe(k);
    expect(addressKey({ ...base, city: 'Пазарджик' })).not.toBe(k);
    expect(addressKey({ ...base, zip: '4002' })).not.toBe(k);
  });

  it('normalizeForKey unifies the usual abbreviations', () => {
    expect(normalizeForKey('Ж.К. Тракия, Блок 54')).toBe('жк тракия бл 54');
    expect(normalizeForKey('булевард „Христо Ботев“ No 5')).toBe('бул христо ботев 5');
  });
});
