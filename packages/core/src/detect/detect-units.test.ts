import { describe, expect, it } from 'vitest';
import { addressLinks, callScript } from './call.ts';
import { formatKm, orderSuggestions, type DeliveryDecision } from './decide.ts';
import { BASE_DICTIONARY, mergeDictionary } from './dictionary.ts';
import { pointCore } from './match.ts';
import {
  editDistance,
  findTerms,
  normalizeText,
  textForms,
  toCyrillic,
  toLatin,
} from './normalize.ts';
import { analyze } from './signals.ts';
import { similarity } from './trigram.ts';

describe('normalization (P5-03, P5-04)', () => {
  it('lower case, NFC, no punctuation, one space', () => {
    expect(normalizeText('  Офис  ЕКОНТ – Пловдив, „Тест“!! ')).toBe('офис еконт пловдив тест');
    expect(normalizeText('е́конт')).toBe('е конт'); // the accent is not a letter
  });

  it('Latin and Cyrillic copies line up word for word', () => {
    expect(toLatin('офис еконт')).toBe('ofis ekont');
    expect(toCyrillic('ofis ekont')).toBe('офис еконт');
    expect(toCyrillic('econt office')).toBe('еконт оффике');
    const f = textForms('Econt office');
    expect(f.words).toEqual(['econt', 'office']);
  });

  it('typos: one edit in words of 5+ letters, same first letter', () => {
    expect(editDistance('ekonnt', 'ekont')).toBe(1);
    expect(editDistance('spidy', 'spidi')).toBe(1);
    expect(editDistance('ekotn', 'ekont')).toBe(1); // swapped letters
    const hits = (t: string) => findTerms(textForms(t), BASE_DICTIONARY.speedy).map((h) => h.term);
    expect(hits('Spidy')).toContain('spidi');
    expect(hits('apteka')).toEqual([]); // "apt" whole words only
    expect(hits('APT 12')).toEqual(['apt']);
  });

  it('owner words are added to the base list, never replace it', () => {
    const d = mergeDictionary({ econt: ['еконтче', ' ЕКОНТ '], home: ['у дома'] });
    expect(d.econt).toContain('еконтче');
    expect(d.econt.filter((w) => w === 'еконт')).toHaveLength(1);
    expect(d.home).toContain('у дома');
    expect(d.speedy).toEqual(BASE_DICTIONARY.speedy);
  });
});

describe('trigram similarity (like pg_trgm)', () => {
  it('matches the PostgreSQL documentation example', () => {
    // similarity('word', 'two words') = 0.36363637 in the pg_trgm docs
    expect(similarity('word', 'two words')).toBeCloseTo(0.363636, 5);
    expect(similarity('trakia', 'trakia')).toBe(1);
    expect(similarity('', 'x')).toBe(0);
  });

  it('office names lose the town, courier and office words', () => {
    const d = mergeDictionary(null);
    expect(pointCore('Пловдив 24/7 Еконтомат - Тракия', new Set(['plovdiv']), d)).toBe('trakia');
    expect(pointCore('ПЛОВДИВ - ТРАКИЯ (ЖК), БЛ.100', new Set(['plovdiv']), d)).toBe('trakia 100');
  });
});

describe('signals', () => {
  const d = mergeDictionary(null);
  it('street address = street or ж.к. + a number or block', () => {
    expect(analyze({ address1: 'ул. Примерна 12' }, d).streetAddress).toBe(true);
    expect(analyze({ address1: 'ж.к. Тракия бл. 148' }, d).streetAddress).toBe(true);
    expect(analyze({ address1: 'zh.k. Mladost 1 bl. 12' }, d).streetAddress).toBe(true);
    expect(analyze({ address1: 'Иван Вазов 12' }, d).streetAddress).toBe(false);
    expect(analyze({ address1: 'ул. Иван Вазов' }, d).streetAddress).toBe(false);
  });

  it('flat details and street hints', () => {
    expect(analyze({ address1: 'бл. 5, вх. Б, ап. 12' }, d).flatDetails).toBe(true);
    expect(analyze({ address1: 'бл. 5' }, d).flatDetails).toBe(false);
    expect(analyze({ address1: 'Русе № 5' }, d).streetHints).toBe(true);
    expect(analyze({ address1: 'офис Капана' }, d).streetHints).toBe(false);
  });

  it('office codes only next to a courier / office word or after №', () => {
    expect(analyze({ address1: 'Speedy автомат 123' }, d).codes).toEqual(['123']);
    expect(analyze({ address1: 'Еконт № 4007' }, d).codes).toEqual(['4007']);
    expect(analyze({ address1: 'офис еконт, ул. Христо Ботев 18' }, d).codes).toEqual([]);
  });

  it('Shipping Method is never read (P5-02)', () => {
    expect(analyze({ address1: 'ул. Опитна 21', shippingMethod: 'Спиди – до автомат' }, d)).toEqual(
      analyze({ address1: 'ул. Опитна 21' }, d),
    );
  });
});

describe('formatting, tie-break, call script, links', () => {
  it('distance in Bulgarian and English', () => {
    expect(formatKm(0.8, 'bg')).toBe('0,8 км');
    expect(formatKm(0.84, 'en')).toBe('0.8 km');
    expect(formatKm(12.4, 'bg')).toBe('12 км');
  });

  it('P5-16: within 200 m the other courier is offered too; an exact tie goes to the tie-break courier', () => {
    const p = (carrier: 'econt' | 'speedy', km: number) => ({
      id: `${carrier}${km}`,
      carrier,
      type: 'office' as const,
      name_bg: '',
      city: null,
      postcode: null,
      address_text: null,
      external_id: '',
      distance_km: km,
    });
    expect(
      orderSuggestions([p('speedy', 0.5), p('econt', 0.5)], 'econt').map((x) => x.carrier),
    ).toEqual(['econt', 'speedy']);
    expect(
      orderSuggestions([p('econt', 0.6), p('speedy', 0.45)], 'econt').map((x) => x.id),
    ).toEqual(['speedy0.45', 'econt0.6']);
    expect(orderSuggestions([p('econt', 0.9), p('speedy', 0.3)], 'econt').map((x) => x.id)).toEqual(
      ['speedy0.3'],
    );
  });

  it('call script in Bulgarian, with the suggestion', () => {
    const decision = {
      rule: 'C',
      certainty: 'uncertain',
      carrier: 'speedy',
      deliveryType: 'office',
      point: null,
      suggestion: {
        id: 's',
        carrier: 'speedy',
        type: 'office',
        name_bg: 'РУСЕ - БУРОВ',
        city: 'Русе',
        postcode: null,
        address_text: null,
        external_id: '202',
      },
      alternatives: [],
      reasons: [{ code: 'point_unclear', bg: '', en: '' }],
      hints: [],
      geo: null,
      typo: false,
    } satisfies DeliveryDecision;
    expect(callScript(decision, '#2008')).toBe(
      'Здравейте, обаждам се от HappyHome за поръчка #2008. Къде да изпратим пратката — до офис на Спиди „РУСЕ - БУРОВ“ или до личен адрес?',
    );
  });

  it('Google links are plain URLs with the address (no API)', () => {
    const links = addressLinks({ address1: 'ул. Опитна 21', city: 'Русе', zip: '7000' });
    expect(links.maps).toBe(
      `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent('ул. Опитна 21, 7000 Русе, България')}`,
    );
    expect(links.search.startsWith('https://www.google.com/search?q=')).toBe(true);
  });
});
