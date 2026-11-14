/**
 * Geoapify forward geocoding (OpenStreetMap data) request and response helpers. No I/O here.
 *
 * Why Geoapify: the public Nominatim refuses every request from Supabase Edge Functions
 * ("Access denied": the hosted runtime appends "SupabaseEdgeRuntime/…" to the User-Agent, and
 * Nominatim blocks that). The owner chose Geoapify on 14 Nov 2026 (EU company, free plan allows
 * commercial use with attribution, no storage limit for results).
 *
 * Terms read 14 Nov 2026 (https://www.geoapify.com/pricing, /term-and-conditions): free plan
 * 3 000 credits a day, up to 5 requests a second, "Powered by Geoapify" + OpenStreetMap
 * attribution in the app. The API key is an Edge Function secret (GEOAPIFY_API_KEY), never in
 * the database, the code or a log.
 *
 * The answer is mapped onto the same hit shape as Nominatim's, so the precision rules, the town
 * check and the cache stay one code path.
 */
import { isInBulgaria } from './distance.ts';
import type { NominatimHit } from './nominatim.ts';

export const GEOAPIFY_DEFAULT_URL = 'https://api.geoapify.com/v1/geocode';

export function geoapifySearchUrl(baseUrl: string, query: string, apiKey: string): string {
  const url = new URL('search', baseUrl.replace(/\/+$/, '') + '/');
  url.searchParams.set('text', query);
  url.searchParams.set('filter', 'countrycode:bg'); // P4-23: Bulgaria only
  url.searchParams.set('lang', 'bg');
  url.searchParams.set('limit', '1');
  url.searchParams.set('format', 'json');
  url.searchParams.set('apiKey', apiKey);
  return url.toString();
}

/** Geoapify result_type → the Nominatim-like fields precisionOf() reads. */
const RESULT_TYPES: Record<string, Pick<NominatimHit, 'addressType' | 'category' | 'placeRank'>> = {
  building: { addressType: 'building', category: 'building', placeRank: 30 },
  amenity: { addressType: 'amenity', category: 'amenity', placeRank: 30 },
  street: { addressType: 'road', category: 'highway', placeRank: 26 },
  suburb: { addressType: 'suburb', category: 'place', placeRank: 20 },
  district: { addressType: 'city_district', category: 'place', placeRank: 20 },
  postcode: { addressType: 'postcode', category: 'place', placeRank: 16 },
  city: { addressType: 'city', category: 'place', placeRank: 16 },
};

/** Settlement and district names in a Geoapify result (for the town check, hitInCity). */
const PLACE_KEYS = [
  'city',
  'town',
  'village',
  'hamlet',
  'municipality',
  'district',
  'suburb',
  'county',
  'state',
] as const;

const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null);

/**
 * The first usable result, or null. Anything outside Bulgaria is ignored, and so are results
 * coarser than a town (county, state, country, unknown): those cannot place a delivery.
 */
export function parseGeoapifyResults(json: unknown): NominatimHit | null {
  const results = (json as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) return null;
  for (const item of results) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const lat = Number(r.lat);
    const lng = Number(r.lon);
    const country = text(r.country_code) ?? 'bg';
    if (country.toLowerCase() !== 'bg' || !isInBulgaria({ lat, lng })) continue;
    const resultType = text(r.result_type) ?? 'unknown';
    const kind = RESULT_TYPES[resultType];
    if (!kind) continue;
    return {
      lat,
      lng,
      displayName: text(r.formatted) ?? '',
      ...kind,
      type: resultType,
      houseNumber: text(r.housenumber),
      places: PLACE_KEYS.map((k) => text(r[k])).filter((v): v is string => v !== null),
    };
  }
  return null;
}
