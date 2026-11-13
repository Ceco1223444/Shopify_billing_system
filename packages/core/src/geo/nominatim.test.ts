import { describe, expect, it } from 'vitest';
import {
  nominatimSearchUrl,
  parseNominatimResults,
  hitInCity,
  precisionOf,
  precisionToConfidence,
  type NominatimHit,
} from './nominatim.ts';

const hit = (over: Partial<NominatimHit>): NominatimHit => ({
  lat: 42.14,
  lng: 24.75,
  displayName: 'x',
  addressType: 'road',
  category: 'highway',
  type: 'residential',
  placeRank: 26,
  houseNumber: null,
  ...over,
});

describe('nominatimSearchUrl', () => {
  it('asks for one Bulgarian result in JSON, with the query and optional e-mail', () => {
    const url = new URL(
      nominatimSearchUrl('https://nominatim.openstreetmap.org/', 'ул. Иван Вазов 12, Пловдив', {
        email: 'shop@example.com',
      }),
    );
    expect(url.origin + url.pathname).toBe('https://nominatim.openstreetmap.org/search');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      q: 'ул. Иван Вазов 12, Пловдив',
      format: 'jsonv2',
      countrycodes: 'bg',
      limit: '1',
      addressdetails: '1',
      'accept-language': 'bg',
      email: 'shop@example.com',
    });
  });

  it('keeps a path prefix of a self-hosted instance and sends no e-mail when there is none', () => {
    const url = new URL(nominatimSearchUrl('https://geo.example.com/nominatim', 'Пловдив'));
    expect(url.pathname).toBe('/nominatim/search');
    expect(url.searchParams.has('email')).toBe(false);
  });
});

describe('parseNominatimResults', () => {
  it('reads the first Bulgarian result', () => {
    const parsed = parseNominatimResults([
      {
        lat: '42.1221',
        lon: '24.7595',
        display_name: '11, Кукленско шосе, Пловдив',
        addresstype: 'building',
        category: 'building',
        type: 'yes',
        place_rank: 30,
        address: { house_number: '11', city: 'Пловдив', country_code: 'bg' },
      },
    ]);
    expect(parsed).toEqual({
      lat: 42.1221,
      lng: 24.7595,
      displayName: '11, Кукленско шосе, Пловдив',
      addressType: 'building',
      category: 'building',
      type: 'yes',
      placeRank: 30,
      houseNumber: '11',
      places: ['Пловдив'],
    });
  });

  it('skips results outside Bulgaria and junk', () => {
    expect(parseNominatimResults([])).toBeNull();
    expect(parseNominatimResults({ error: 'x' })).toBeNull();
    expect(
      parseNominatimResults([
        { lat: '44.43', lon: '26.10', address: { country_code: 'ro' } },
        { lat: 'nope', lon: '24' },
      ]),
    ).toBeNull();
  });
});

describe('precisionOf (P4-24)', () => {
  const street = { street: 'Иван Вазов', block: null };
  const blockOnly = { street: null, block: '54' };

  it('street level for roads and houses', () => {
    expect(precisionOf(hit({}), 'original', street)).toBe('street');
    expect(
      precisionOf(
        hit({ addressType: 'building', category: 'building', placeRank: 30 }),
        'original',
        street,
      ),
    ).toBe('street');
  });

  it('a road whose addresstype is the road type is still a street (live Nominatim answer)', () => {
    const road = hit({ addressType: 'residential', type: 'residential', placeRank: 26 });
    expect(precisionOf(road, 'street_bare', street)).toBe('street');
    expect(precisionOf(hit({ addressType: 'tertiary', placeRank: 26 }), 'original', street)).toBe(
      'street',
    );
    // "жк. Тракия" is also a road name: found from a ж.к. it is only the quarter.
    expect(precisionOf(road, 'original', blockOnly)).toBe('quarter');
    expect(precisionOf(road, 'quarter', street)).toBe('quarter');
  });

  it('block level for a building found from ж.к. + бл.', () => {
    const building = hit({ addressType: 'building', category: 'building', placeRank: 30 });
    expect(precisionOf(building, 'quarter_block', blockOnly)).toBe('block');
    expect(precisionOf(building, 'original', blockOnly)).toBe('block');
  });

  it('quarter and city levels', () => {
    expect(precisionOf(hit({ addressType: 'suburb', placeRank: 20 }), 'quarter', blockOnly)).toBe(
      'quarter',
    );
    expect(
      precisionOf(
        hit({ addressType: 'residential', category: 'landuse', placeRank: 22 }),
        'quarter',
        blockOnly,
      ),
    ).toBe('quarter');
    expect(precisionOf(hit({ addressType: 'city', placeRank: 16 }), 'city', street)).toBe('city');
    expect(precisionOf(hit({ addressType: 'village', placeRank: 19 }), 'city', street)).toBe(
      'city',
    );
    expect(precisionOf(hit({ addressType: 'postcode', placeRank: 21 }), 'city_zip', street)).toBe(
      'city',
    );
  });

  it('failed for nothing found or only a province', () => {
    expect(precisionOf(null, 'original', street)).toBe('failed');
    expect(precisionOf(hit({ addressType: 'state', placeRank: 8 }), 'city', street)).toBe('failed');
  });

  it('confidence 2 / 1 / 0 for street / quarter / city', () => {
    expect(precisionToConfidence('street')).toBe(2);
    expect(precisionToConfidence('block')).toBe(2);
    expect(precisionToConfidence('quarter')).toBe(1);
    expect(precisionToConfidence('city')).toBe(0);
    expect(precisionToConfidence('failed')).toBeNull();
  });
});

describe('hitInCity', () => {
  it('accepts a hit in the named town, however the town is spelled', () => {
    const sofia = {
      displayName: '10-12, Марагидик, кв. Подуяне, София, Район Оборище, Столична, София-град',
      places: ['София', 'кв. Подуяне', 'Район Оборище', 'Столична', 'София-град'],
    };
    expect(hitInCity(sofia, 'София')).toBe(true);
    expect(hitInCity(sofia, 'Sofiya')).toBe(true);
    expect(hitInCity(sofia, 'Sofia, Bulgaria')).toBe(true);
    expect(hitInCity({ displayName: '', places: ['Герман', 'Столична'] }, 'Герман')).toBe(true);
  });

  it('rejects a place of the same name in another town (live case: Айдемир)', () => {
    // Nominatim's answer for "София 7, Айдемир": an object called "Айдемир" in Sofia.
    const live = {
      displayName: 'Айдемир, ж.к. Дървеница, София, Район Студентски, Столична, София-град, 1797',
      places: ['София', 'ж.к. Дървеница', 'Район Студентски', 'Столична', 'София-град'],
    };
    expect(hitInCity(live, 'Айдемир')).toBe(false);
    // An older cache entry without details: the first part (the object itself) does not count.
    expect(hitInCity({ displayName: live.displayName }, 'Айдемир')).toBe(false);
    expect(hitInCity({ displayName: 'x, Пловдив, 4000', places: ['Пловдив'] }, 'Плевен')).toBe(
      false,
    );
  });

  it('parseNominatimResults keeps the settlement names, not the road or house number', () => {
    const hit = parseNominatimResults([
      {
        lat: '43.404',
        lon: '24.614',
        display_name: '42, Хаджи Димитър, 9-ти квартал, Плевен, 5800, България',
        addresstype: 'building',
        category: 'building',
        place_rank: 30,
        address: {
          house_number: '42',
          road: 'Хаджи Димитър',
          suburb: '9-ти квартал',
          city: 'Плевен',
          postcode: '5800',
          country_code: 'bg',
        },
      },
    ]);
    expect(hit?.places).toEqual(['Плевен', '9-ти квартал']);
  });
});
