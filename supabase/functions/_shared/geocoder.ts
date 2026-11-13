/**
 * Geocoder (P4-20 … P4-25): a Shopify address → lat, lng, precision, with Nominatim.
 *
 *  1. The normalized address key is looked up in geocode_cache: a known address is NEVER sent
 *     to Nominatim again (P4-25, T4-03). Failures are cached too.
 *  2. Otherwise the query variants are tried, most precise first. Every query string is cached
 *     on its own as well, so a shared "4000 Пловдив" is asked once for all customers.
 *  3. Before each request the app reserves a slot in the database (geocoder_reserve): at least
 *     1.2 s between any two requests of the whole app, 15 s for scheduled jobs (T4-06).
 *     If the next slot is too far away the call answers "busy" instead of waiting.
 *
 * Only the address goes out: never names, phones or e-mails.
 */
import {
  addressKey,
  APP_USER_AGENT,
  buildQueryVariants,
  isBulgaria,
  NOMINATIM_BULK_INTERVAL_MS,
  nominatimSearchUrl,
  parseBgAddress,
  parseNominatimResults,
  precisionOf,
  type GeocodeInput,
  type GeocodePrecision,
  type GeocoderSettings,
  type NominatimHit,
  type QueryVariantKind,
} from './core.ts';
import { call, rowOrNull, sleep as realSleep, type Db } from './db.ts';

/** Spacing between any two Nominatim requests of the app (policy: at most 1 per second). */
export const NOMINATIM_SPACING_MS = 1200;
const PROVIDER = 'nominatim';

export interface GeocoderDeps {
  db: Db;
  fetch: typeof fetch;
  settings: GeocoderSettings;
  /** interactive = a person is waiting; bulk = scheduled job (4 per minute at most). */
  mode: 'interactive' | 'bulk';
  /** Answer "busy" rather than wait longer than this for a free slot. */
  maxWaitMs: number;
  /** At most this many requests to Nominatim for one address. */
  maxRequests?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface GeocodeOutcome {
  key: string;
  lat: number | null;
  lng: number | null;
  precision: GeocodePrecision;
  variant: QueryVariantKind | null;
  displayName: string | null;
  /** true = answered from geocode_cache without asking Nominatim. */
  cached: boolean;
  /** Requests sent to Nominatim for this call. */
  requests: number;
  /** Why it failed without trying (not cached, so it can be tried again later). */
  reason?: 'not_bulgaria' | 'no_city' | 'disabled' | 'busy' | 'provider_error';
}

interface CacheRow {
  id: string | null;
  lat: number | null;
  lng: number | null;
  precision: GeocodePrecision | null;
  variant: string | null;
  display_name: string | null;
  raw: Record<string, unknown> | null;
}

const cacheGet = async (db: Db, kind: 'address' | 'query', key: string) =>
  rowOrNull(
    await call<CacheRow | null>(db, 'geocode_cache_get', {
      p_provider: PROVIDER,
      p_kind: kind,
      p_key: key,
    }),
  );

const cachePut = (
  db: Db,
  kind: 'address' | 'query',
  key: string,
  value: {
    lat: number | null;
    lng: number | null;
    precision: GeocodePrecision;
    variant: string | null;
    displayName: string | null;
    raw: Record<string, unknown>;
  },
) =>
  call(db, 'geocode_cache_put', {
    p_provider: PROVIDER,
    p_kind: kind,
    p_key: key,
    p_lat: value.lat,
    p_lng: value.lng,
    p_precision: value.precision,
    p_variant: value.variant,
    p_display_name: value.displayName,
    p_raw: value.raw,
  });

/** Wait for this app's turn (both buckets for scheduled jobs). false = too busy. */
async function takeSlot(deps: GeocoderDeps): Promise<boolean> {
  const sleep = deps.sleep ?? realSleep;
  if (deps.mode === 'bulk') {
    const bulkWait = await call<number | null>(deps.db, 'geocoder_reserve', {
      p_bucket: 'nominatim_bulk',
      p_interval_ms: NOMINATIM_BULK_INTERVAL_MS,
      p_max_wait_ms: deps.maxWaitMs,
    });
    if (bulkWait === null) return false;
    await sleep(bulkWait);
  }
  const wait = await call<number | null>(deps.db, 'geocoder_reserve', {
    p_bucket: 'nominatim',
    p_interval_ms: NOMINATIM_SPACING_MS,
    p_max_wait_ms: deps.maxWaitMs,
  });
  if (wait === null) return false;
  await sleep(wait);
  return true;
}

type Search = { ok: true; hit: NominatimHit | null } | { ok: false };

async function search(deps: GeocoderDeps, query: string): Promise<Search> {
  const url = nominatimSearchUrl(deps.settings.url, query, { email: deps.settings.email });
  try {
    const res = await deps.fetch(url, {
      headers: { 'User-Agent': APP_USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { ok: false }; // 429 / 5xx: do not cache, try again later
    return { ok: true, hit: parseNominatimResults(await res.json()) };
  } catch {
    return { ok: false };
  }
}

export async function geocodeAddress(
  input: GeocodeInput,
  deps: GeocoderDeps,
): Promise<GeocodeOutcome> {
  const key = addressKey(input);
  const base = { key, variant: null, displayName: null, cached: false, requests: 0 };
  const failed = (reason: GeocodeOutcome['reason']): GeocodeOutcome => ({
    ...base,
    lat: null,
    lng: null,
    precision: 'failed',
    reason,
  });

  if (!isBulgaria(input.country)) return failed('not_bulgaria');

  const known = await cacheGet(deps.db, 'address', key);
  if (known) {
    return {
      key,
      lat: known.lat,
      lng: known.lng,
      precision: known.precision ?? 'failed',
      variant: (known.variant as QueryVariantKind | null) ?? null,
      displayName: known.display_name,
      cached: true,
      requests: 0,
    };
  }

  const variants = buildQueryVariants(input);
  if (!variants.length) return failed('no_city');
  if (!deps.settings.enabled) return failed('disabled');

  const parsed = parseBgAddress(input);
  const maxRequests = deps.maxRequests ?? variants.length;
  let requests = 0;
  for (const variant of variants) {
    let hit: NominatimHit | null;
    const known = await cacheGet(deps.db, 'query', variant.q);
    if (known) {
      hit =
        known.lat !== null && known.lng !== null
          ? ({
              lat: known.lat,
              lng: known.lng,
              displayName: known.display_name ?? '',
              ...(known.raw as Omit<NominatimHit, 'lat' | 'lng' | 'displayName'>),
            } satisfies NominatimHit)
          : null;
    } else {
      // Out of requests for this call: the answers so far are cached, the next call goes on.
      if (requests >= maxRequests) return { ...failed('busy'), requests };
      if (!(await takeSlot(deps))) return { ...failed('busy'), requests };
      requests++;
      const found = await search(deps, variant.q);
      if (!found.ok) return { ...failed('provider_error'), requests };
      hit = found.hit;
      await cachePut(deps.db, 'query', variant.q, {
        lat: hit?.lat ?? null,
        lng: hit?.lng ?? null,
        precision: precisionOf(hit, variant.kind, parsed),
        variant: variant.kind,
        displayName: hit?.displayName ?? null,
        raw: hit
          ? {
              addressType: hit.addressType,
              category: hit.category,
              type: hit.type,
              placeRank: hit.placeRank,
              houseNumber: hit.houseNumber,
            }
          : {},
      });
    }

    const precision = precisionOf(hit, variant.kind, parsed);
    if (hit && precision !== 'failed') {
      const outcome: GeocodeOutcome = {
        key,
        lat: hit.lat,
        lng: hit.lng,
        precision,
        variant: variant.kind,
        displayName: hit.displayName,
        cached: false,
        requests,
      };
      await cachePut(deps.db, 'address', key, { ...outcome, raw: { variant: variant.kind } });
      return outcome;
    }
  }

  // Nothing found with any variant: remember that too, so it is never asked again.
  const none: GeocodeOutcome = { ...base, lat: null, lng: null, precision: 'failed', requests };
  await cachePut(deps.db, 'address', key, { ...none, raw: { variants: variants.length } });
  return none;
}
