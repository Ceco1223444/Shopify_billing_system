/**
 * Real, public courier offices (Econt / Speedy lists of 14 Nov 2026) for the detection tests, and
 * in-memory versions of the lookups the Edge Function does with the database and the geocoder.
 */
import type { SupportedCarrier } from '../src/domain.ts';
import type { DetectionDeps, GeoPoint } from '../src/detect/decide.ts';
import type { PointCandidate } from '../src/detect/match.ts';
import type { DetectionInput } from '../src/detect/signals.ts';
import { haversineKm } from '../src/geo/distance.ts';
import { latinKey } from '../src/geo/translit.ts';

type Row = [
  SupportedCarrier,
  string,
  PointCandidate['type'],
  string,
  string,
  string | null,
  string,
  number,
  number,
];

const ROWS: Row[] = [
  [
    'speedy',
    '190',
    'office',
    'АЙТОС - КИРИЛ И МЕТОДИЙ (УЛ.)',
    'Айтос',
    '8500',
    'гр. Айтос [8500] ул. Кирил и Методий No 17',
    42.703595,
    27.250811,
  ],
  [
    'econt',
    '4068',
    'locker',
    'Пловдив 24/7 Еконтомат - Тракия',
    'Пловдив',
    '4000',
    'Пловдив ж.к. Тракия бул. Съединение №43',
    42.13232,
    24.79506,
  ],
  [
    'econt',
    '4067',
    'office',
    'Пловдив Гербера кв.Тракия',
    'Пловдив',
    '4000',
    'Пловдив ж.к. Тракия бул. Освобождение №87',
    42.130753,
    24.778329,
  ],
  [
    'econt',
    '4064',
    'office',
    'Пловдив Капана',
    'Пловдив',
    '4000',
    'Пловдив ул. Стефан Веркович №3 Бивша агенция по вписванията',
    42.150058,
    24.749258,
  ],
  [
    'econt',
    '4007',
    'office',
    'Пловдив Тракия',
    'Пловдив',
    '4000',
    'Пловдив ж.к. Тракия ул. Георги Данчов №45 блок.45',
    42.135844,
    24.78989,
  ],
  [
    'speedy',
    '9145',
    'locker',
    'ПЛОВДИВ - КАУФЛАНД ТРАКИЯ (АВТОМАТ)',
    'Пловдив',
    null,
    'гр. Пловдив бул. Освобождение No 47 (НА ПАРКИНГА)',
    42.133216,
    24.789813,
  ],
  [
    'speedy',
    '79',
    'office',
    'ПЛОВДИВ - ОФИС',
    'Пловдив',
    null,
    'гр. Пловдив ул. Константин Стоилов No 19',
    42.148486,
    24.749681,
  ],
  [
    'speedy',
    '276',
    'office',
    'ПЛОВДИВ - ТРАКИЯ (ЖК), БЛ.1',
    'Пловдив',
    null,
    'гр. Пловдив бул. Освобождение No 31',
    42.141635,
    24.788176,
  ],
  [
    'speedy',
    '430',
    'office',
    'ПЛОВДИВ - ТРАКИЯ (ЖК), БЛ.100',
    'Пловдив',
    null,
    'гр. Пловдив жк Тракия ул. Братан No 2',
    42.132387,
    24.795349,
  ],
  [
    'speedy',
    '608',
    'office',
    'ПЛОВДИВ - ТРАКИЯ (ЖК), БЛ.148',
    'Пловдив',
    null,
    'гр. Пловдив жк Тракия бл. 148',
    42.130548,
    24.788574,
  ],
  [
    'speedy',
    '837',
    'office',
    'ПЛОВДИВ - ТРАКИЯ (ЖК), БЛ.45',
    'Пловдив',
    null,
    'гр. Пловдив жк Тракия бл. 45',
    42.135828,
    24.789979,
  ],
  [
    'speedy',
    '737',
    'office',
    'РУСЕ - БОРИСОВА',
    'Русе',
    null,
    'гр. Русе ул. Борисова No 113',
    43.835456,
    25.956028,
  ],
  [
    'speedy',
    '776',
    'office',
    'РУСЕ - БОРЦИТЕ',
    'Русе',
    null,
    'гр. Русе ул. Мостова No 3 СРЕЩУ ЕНЕРГОТО',
    43.853798,
    25.957893,
  ],
  [
    'speedy',
    '202',
    'office',
    'РУСЕ - БУРОВ',
    'Русе',
    null,
    'гр. Русе ул. Буров No 2',
    43.846591,
    25.951992,
  ],
  [
    'speedy',
    '10',
    'office',
    'РУСЕ - БЪЛГАРИЯ (БУЛ.)',
    'Русе',
    null,
    'гр. Русе бул. България No 310',
    43.872216,
    26.016864,
  ],
  [
    'speedy',
    '849',
    'office',
    'РУСЕ - ЗДРАВЕЦ ИЗТОК',
    'Русе',
    null,
    'гр. Русе жк Здравец-изток ул. Котовск No 12 МАГАЗИН 4, ДОЙЧЕ ШУЛЕ',
    43.849346,
    25.985499,
  ],
  [
    'speedy',
    '179',
    'office',
    'РУСЕ - ПРАКТИКЕР',
    'Русе',
    null,
    'гр. Русе бул. Липник No 10',
    43.846394,
    25.967062,
  ],
  [
    'speedy',
    '371',
    'office',
    'РУСЕ - ТЕХНОПОЛИС',
    'Русе',
    null,
    'гр. Русе бул. Христо Ботев No 38',
    43.831454,
    25.970027,
  ],
  [
    'speedy',
    '91',
    'office',
    'РУСЕ - ЦЕНТЪР, ОПЕРА',
    'Русе',
    null,
    'гр. Русе ул. Муткурова No 36',
    43.847172,
    25.957646,
  ],
  [
    'speedy',
    '791',
    'office',
    'РУСЕ - ЧАРОДЕЙКА (ЖК)',
    'Русе',
    null,
    'гр. Русе ул. Тодор Икономов No 5',
    43.832267,
    25.978251,
  ],
  [
    'speedy',
    '123',
    'office',
    'СЛИВЕН - ЦАР ОСВОБОДИТЕЛ',
    'Сливен',
    '8800',
    'гр. Сливен [8800] бул. Цар Освободител No 28',
    42.680192,
    26.319286,
  ],
  [
    'econt',
    '17131',
    'locker',
    'София 24/7 Еконтомат - ОМВ София Младост 1 А',
    'София',
    '1000',
    'София бул. Александър Малинов №27',
    42.651617,
    23.380036,
  ],
  [
    'econt',
    '1056',
    'office',
    'София Младост 1',
    'София',
    '1000',
    'София ул. Йерусалим №54 блок.54',
    42.654803,
    23.372824,
  ],
  [
    'econt',
    '1184',
    'office',
    'София Младост 1А Пътеките',
    'София',
    '1000',
    'София кв. Младост-1А ул. Кръстьо Раковски №1 блок.508',
    42.650159,
    23.380708,
  ],
  [
    'econt',
    '1175',
    'office',
    'София Младост 4',
    'София',
    '1000',
    'София кв. Младост-4 блок.487 магазин 6',
    42.62619,
    23.383767,
  ],
  [
    'speedy',
    '9047',
    'locker',
    'СОФИЯ - БИЛЛА МЛАДОСТ 4 (АВТОМАТ)',
    'София',
    null,
    'гр. София жк Младост 4 ул. 406 No 14',
    42.629789,
    23.381152,
  ],
  [
    'speedy',
    '9089',
    'locker',
    'СОФИЯ - КАУФЛАНД МЛАДОСТ 4 (АВТОМАТ)',
    'София',
    null,
    'гр. София жк Младост 4 ул. Околовръстен път No 271 (СЛЕД КАСИТЕ)',
    42.624109,
    23.384048,
  ],
  [
    'speedy',
    '9004',
    'locker',
    'СОФИЯ - ФАНТАСТИКО МЛАДОСТ 4 (АВТОМАТ)',
    'София',
    null,
    'гр. София жк Младост 4 ДО БЛ. 405',
    42.635791,
    23.377255,
  ],
  [
    'speedy',
    '98',
    'office',
    'СОФИЯ - МЛАДОСТ 1 (ЖК)',
    'София',
    null,
    'гр. София жк Младост 1 бл. 12А МАГАЗИН 14',
    42.65758,
    23.376336,
  ],
  [
    'speedy',
    '362',
    'office',
    'СОФИЯ - МЛАДОСТ 1А (ЖК)',
    'София',
    null,
    'гр. София жк Младост 1А бл. 508',
    42.650174,
    23.380873,
  ],
  [
    'speedy',
    '199',
    'office',
    'СОФИЯ - МЛАДОСТ 4 (Ж.К.), БЛ.488',
    'София',
    null,
    'гр. София жк Младост 4 бл. 488',
    42.626468,
    23.384094,
  ],
  [
    'speedy',
    '66',
    'office',
    'СОФИЯ - МЛАДОСТ 4 (ЖК)',
    'София',
    null,
    'гр. София жк Младост 4 ул. Бизнес парк София бл. 2',
    42.628569,
    23.373724,
  ],
];

export const POINTS: PointCandidate[] = ROWS.map(
  ([carrier, id, type, name, city, postcode, address, lat, lng]) => ({
    id: `${carrier}-${id}`,
    carrier,
    external_id: id,
    code: id,
    type,
    name_bg: name,
    city,
    postcode,
    address_text: address,
    lat,
    lng,
  }),
);

export const pointById = (
  carrier: SupportedCarrier,
  externalId: string,
): PointCandidate & { lat: number; lng: number } =>
  POINTS.find((p) => p.carrier === carrier && p.external_id === externalId) as PointCandidate & {
    lat: number;
    lng: number;
  };

const town = (s: string | null | undefined) =>
  latinKey((s ?? '').replace(/^\s*(гр|град|с|село)\.?\s+/i, '').trim());

/** Fake lookups. `geo` answers the geocoder by Address1 (missing → not found). */
export function fakeDeps(
  geo: Record<string, GeoPoint | null | 'busy'> = {},
): DetectionDeps & { geocoded: DetectionInput[] } {
  const geocoded: DetectionInput[] = [];
  return {
    geocoded,
    pointsInCity: async (city, zip) =>
      POINTS.filter(
        (p) =>
          (city && town(p.city) === town(city)) || (!!zip && p.postcode === zip && !!p.postcode),
      ),
    pointsByCode: async (carrier, codes) =>
      POINTS.filter((p) => p.carrier === carrier && codes.includes(p.external_id)),
    geocode: async (input) => {
      geocoded.push(input);
      return geo[input.address1 ?? ''] ?? null;
    },
    nearestPoints: async (at, o) =>
      POINTS.filter((p) => !o.carriers || o.carriers.includes(p.carrier))
        .filter((p) => !o.types || o.types.includes(p.type))
        .map((p) => ({ ...p, distance_km: haversineKm(at, { lat: p.lat!, lng: p.lng! }) }))
        .filter((p) => p.distance_km <= o.maxKm)
        .sort((a, b) => a.distance_km - b.distance_km)
        .slice(0, o.limit),
  };
}

/** A point `km` north of a given point (1° latitude ≈ 111.2 km). */
export function northOf(
  p: { lat: number; lng: number },
  km: number,
  precision: GeoPoint['precision'] = 'street',
): GeoPoint {
  return { lat: p.lat + km / 111.195, lng: p.lng, precision };
}
