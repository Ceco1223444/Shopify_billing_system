import { describe, expect, it } from 'vitest';
import { GEOAPIFY_DEFAULT_URL, geoapifySearchUrl, parseGeoapifyResults } from './geoapify.ts';
import { hitInCity, precisionOf } from './nominatim.ts';

/** A Geoapify forward-geocoding result (format=json), shaped like the documented answer. */
const result = (over: Record<string, unknown>) => ({
  lat: 42.1449,
  lon: 24.7486,
  formatted: 'улица Иван Вазов 12, 4000 Пловдив, България',
  country_code: 'bg',
  city: 'Пловдив',
  county: 'Пловдив',
  state: 'Пловдив',
  postcode: '4000',
  street: 'улица Иван Вазов',
  housenumber: '12',
  result_type: 'building',
  rank: { confidence: 1, match_type: 'full_match' },
  ...over,
});

describe('geoapifySearchUrl', () => {
  it('asks for one Bulgarian result in JSON, in Bulgarian, with the key', () => {
    const url = new URL(
      geoapifySearchUrl(GEOAPIFY_DEFAULT_URL, 'ул. Иван Вазов 12, Пловдив', 'k1'),
    );
    expect(url.origin + url.pathname).toBe('https://api.geoapify.com/v1/geocode/search');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      text: 'ул. Иван Вазов 12, Пловдив',
      filter: 'countrycode:bg',
      lang: 'bg',
      limit: '1',
      format: 'json',
      apiKey: 'k1',
    });
  });

  it('accepts the base URL with a trailing slash', () => {
    expect(geoapifySearchUrl('https://api.geoapify.com/v1/geocode/', 'x', 'k')).toMatch(
      /^https:\/\/api\.geoapify\.com\/v1\/geocode\/search\?/,
    );
  });
});

describe('parseGeoapifyResults', () => {
  it('reads the first Bulgarian result as a Nominatim-like hit', () => {
    expect(parseGeoapifyResults({ results: [result({})] })).toEqual({
      lat: 42.1449,
      lng: 24.7486,
      displayName: 'улица Иван Вазов 12, 4000 Пловдив, България',
      addressType: 'building',
      category: 'building',
      type: 'building',
      placeRank: 30,
      houseNumber: '12',
      places: ['Пловдив', 'Пловдив', 'Пловдив'],
    });
  });

  it('skips results outside Bulgaria, too coarse to place a parcel, and junk', () => {
    expect(parseGeoapifyResults(null)).toBeNull();
    expect(parseGeoapifyResults({ results: 'x' })).toBeNull();
    expect(parseGeoapifyResults([result({})])).toBeNull(); // not the documented shape
    expect(
      parseGeoapifyResults({ results: [result({ country_code: 'ro', lat: 44.43, lon: 26.1 })] }),
    ).toBeNull();
    for (const coarse of ['county', 'state', 'country', 'unknown']) {
      expect(parseGeoapifyResults({ results: [result({ result_type: coarse })] })).toBeNull();
    }
    const second = result({ result_type: 'street', lat: 42.15 });
    expect(
      parseGeoapifyResults({ results: [null, result({ result_type: 'state' }), second] })?.lat,
    ).toBe(42.15);
  });
});

describe('Geoapify result types → precision (P4-24)', () => {
  const street = { street: 'Иван Вазов', block: null };
  const blockOnly = { street: null, block: '54' };
  const precision = (
    resultType: string,
    variant: Parameters<typeof precisionOf>[1],
    address: typeof street | typeof blockOnly,
  ) =>
    precisionOf(
      parseGeoapifyResults({ results: [result({ result_type: resultType })] }),
      variant,
      address,
    );

  it('building and street: street level when a street was asked', () => {
    expect(precision('building', 'original', street)).toBe('street');
    expect(precision('amenity', 'original', street)).toBe('street');
    expect(precision('street', 'original', street)).toBe('street');
  });

  it('a building found from ж.к. + бл. is the block; a road found from a ж.к. is the quarter', () => {
    expect(precision('building', 'quarter_block', blockOnly)).toBe('block');
    expect(precision('street', 'quarter', blockOnly)).toBe('quarter');
  });

  it('suburb and district are the quarter; postcode and city the town', () => {
    expect(precision('suburb', 'quarter', blockOnly)).toBe('quarter');
    expect(precision('district', 'quarter', blockOnly)).toBe('quarter');
    expect(precision('postcode', 'city_zip', street)).toBe('city');
    expect(precision('city', 'city', street)).toBe('city');
  });

  it('the town check uses the settlement names of the result', () => {
    const hit = parseGeoapifyResults({
      results: [result({ city: 'Айдемир', county: 'Силистра', state: 'Силистра' })],
    })!;
    expect(hitInCity(hit, 'Айдемир')).toBe(true);
    expect(hitInCity(hit, 'Aydemir')).toBe(true);
    expect(hitInCity(hit, 'София')).toBe(false);
  });
});
