/**
 * Nominatim (OpenStreetMap) request and response helpers. No I/O here: the geocode Edge Function
 * does the HTTP call, the waiting and the caching.
 *
 * Usage policy (https://operations.osmfoundation.org/policies/nominatim/, read 13 Nov 2026):
 * at most 1 request per second for the whole app, a User-Agent that identifies the app,
 * cache everything, no auto-complete, attribution, and the service must be switchable without
 * a software update (the URL lives in settings.geocoder).
 */
import type { GeocodePrecision, ParsedAddress, QueryVariantKind } from './address.ts';
import { isInBulgaria } from './distance.ts';
import { placeSkeleton } from './translit.ts';

export const NOMINATIM_DEFAULT_URL = 'https://nominatim.openstreetmap.org';

/** settings.geocoder */
export interface GeocoderSettings {
  provider: 'nominatim';
  /** Base URL of the Nominatim service (public instance or another one). */
  url: string;
  /** false = never call the geocoder (results already in the cache are still used). */
  enabled: boolean;
  /** Optional contact e-mail sent with requests (Nominatim asks heavier users for one). */
  email: string | null;
}

/** Identifies the app to Nominatim and Speedy (Nominatim forbids stock HTTP-library User-Agents). */
export const APP_USER_AGENT = 'HappyHome-Shipping-Hub/1.0 (small-shop delivery tool)';

/** Absolute maximum for all of the app's requests together. */
export const NOMINATIM_MIN_INTERVAL_MS = 1000;
/** Background jobs that run on a schedule (office sync): the policy allows 4 per minute. */
export const NOMINATIM_BULK_INTERVAL_MS = 15_000;

export interface NominatimHit {
  lat: number;
  lng: number;
  displayName: string;
  /** e.g. road, building, suburb, city (jsonv2 "addresstype") */
  addressType: string;
  category: string;
  type: string;
  placeRank: number;
  houseNumber: string | null;
  /** The settlement and district names from the address details (city, town, village, …). */
  places?: string[];
}

/** Address detail keys that name a settlement or a part of one (not the found object itself). */
const PLACE_KEYS = [
  'city',
  'town',
  'village',
  'hamlet',
  'municipality',
  'city_district',
  'borough',
  'suburb',
  'county',
  'state_district',
  'state',
] as const;

export function nominatimSearchUrl(
  baseUrl: string,
  query: string,
  options: { email?: string | null } = {},
): string {
  const url = new URL('search', baseUrl.replace(/\/+$/, '') + '/');
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('countrycodes', 'bg'); // P4-23: Bulgaria only
  url.searchParams.set('limit', '1');
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('accept-language', 'bg');
  if (options.email) url.searchParams.set('email', options.email);
  return url.toString();
}

/** The first usable result, or null. Anything outside Bulgaria is ignored. */
export function parseNominatimResults(json: unknown): NominatimHit | null {
  if (!Array.isArray(json)) return null;
  for (const item of json) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const lat = Number(r.lat);
    const lng = Number(r.lon);
    const address = (r.address ?? {}) as Record<string, unknown>;
    const country = typeof address.country_code === 'string' ? address.country_code : 'bg';
    if (country.toLowerCase() !== 'bg' || !isInBulgaria({ lat, lng })) continue;
    return {
      lat,
      lng,
      displayName: typeof r.display_name === 'string' ? r.display_name : '',
      addressType: typeof r.addresstype === 'string' ? r.addresstype : '',
      category: typeof r.category === 'string' ? r.category : String(r.class ?? ''),
      type: typeof r.type === 'string' ? r.type : '',
      placeRank: Number(r.place_rank ?? 0),
      houseNumber: typeof address.house_number === 'string' ? address.house_number : null,
      places: PLACE_KEYS.map((k) => address[k]).filter((v): v is string => typeof v === 'string'),
    };
  }
  return null;
}

/**
 * True when the hit lies in the town the address names. A free-form query can match something
 * of the same name elsewhere: "София 7, Айдемир" (ул. София in the village Айдемир) was answered
 * with a place called "Айдемир" in Sofia, 349 km away. The town must be one of the settlement
 * names in the hit's address details, compared spelling-tolerantly ("Sofiya" = "София").
 * Without details (older cache entries) the display name minus its first part (the found object
 * itself) is used.
 */
export function hitInCity(
  hit: Pick<NominatimHit, 'displayName' | 'places'>,
  city: string,
): boolean {
  const want = placeSkeleton(city.split(',')[0] ?? '');
  if (!want) return true;
  const places = hit.places?.length ? hit.places : hit.displayName.split(',').slice(1);
  return places.some((part) => {
    const got = placeSkeleton(part);
    return got === want || got.startsWith(`${want} `);
  });
}

const QUARTER_TYPES = new Set([
  'suburb',
  'quarter',
  'neighbourhood',
  'city_block',
  'residential',
  'borough',
  'city_district',
  'allotments',
]);
const CITY_TYPES = new Set([
  'city',
  'town',
  'village',
  'hamlet',
  'municipality',
  'postcode',
  'isolated_dwelling',
  'locality',
  'farm',
]);

/** How exact a hit is (P4-24): street | block | quarter | city | failed. */
export function precisionOf(
  hit: NominatimHit | null,
  variant: QueryVariantKind,
  address: Pick<ParsedAddress, 'street' | 'block'>,
): GeocodePrecision {
  if (!hit) return 'failed';
  if (hit.category === 'highway' && hit.placeRank >= 26) {
    // A road. Its addresstype can read "residential" or "tertiary" (the road type), so it must
    // not be taken for a ж.к. It is street level only when a street was asked for: a road named
    // after a ж.к. ("жк. Тракия") found from the ж.к. is just the quarter.
    const askedStreet =
      !!address.street && !['quarter_block', 'quarter', 'city_zip', 'city'].includes(variant);
    return askedStreet ? 'street' : 'quarter';
  }
  if (QUARTER_TYPES.has(hit.addressType)) return 'quarter';
  if (CITY_TYPES.has(hit.addressType)) return 'city';
  if (hit.placeRank >= 26) {
    // A building found from "ж.к. … бл. N" (no street): the block itself.
    const blockQuery = variant === 'quarter_block' || (!address.street && !!address.block);
    return blockQuery && hit.placeRank >= 28 ? 'block' : 'street';
  }
  if (hit.placeRank >= 20) return 'quarter';
  if (hit.placeRank >= 12) return 'city';
  return 'failed';
}

/** 0–3 like Econt's own "confidence": 3 = courier data, 2 = street/block, 1 = quarter, 0 = city. */
export function precisionToConfidence(precision: GeocodePrecision): number | null {
  switch (precision) {
    case 'street':
    case 'block':
      return 2;
    case 'quarter':
      return 1;
    case 'city':
      return 0;
    default:
      return null;
  }
}
