/**
 * Geocoder (P4-20 … P4-25): a Shopify address → lat, lng, precision, with the provider in
 * settings.geocoder: Geoapify (default since 14 Nov 2026, API key in GEOAPIFY_API_KEY) or a
 * Nominatim server. The public Nominatim refuses requests from Supabase Edge Functions.
 *
 *  1. The normalized address key is looked up in geocode_cache: a known address is NEVER sent
 *     to Nominatim again (P4-25, T4-03). Failures are cached too.
 *     Each provider has its own cache entries.
 *  2. Otherwise the query variants are tried, most precise first. Every query string is cached
 *     on its own as well, so a shared "4000 Пловдив" is asked once for all customers. A hit that
 *     is not in the town the address names is skipped (a street can share a town's name).
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
  hitInCity,
  isBulgaria,
  GEOCODER_KEY_SECRETS,
  geoapifySearchUrl,
  NOMINATIM_BULK_INTERVAL_MS,
  nominatimSearchUrl,
  parseBgAddress,
  parseGeoapifyResults,
  parseNominatimResults,
  precisionOf,
  type GeocodeInput,
  type GeocodePrecision,
  type GeocoderSettings,
  type NominatimHit,
  type QueryVariantKind,
} from './core.ts';
import { call, rowOrNull, sleep as realSleep, type Db } from './db.ts';

/** Spacing between any two geocoder requests of the app (Nominatim: at most 1 per second). */
export const NOMINATIM_SPACING_MS = 1200;

export interface GeocoderDeps {
  db: Db;
  fetch: typeof fetch;
  settings: GeocoderSettings;
  /** The provider's API key (Geoapify), from the Edge Function secret. Never logged. */
  apiKey?: string | null;
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

const cacheGet = async (db: Db, provider: string, kind: 'address' | 'query', key: string) =>
  rowOrNull(
    await call<CacheRow | null>(db, 'geocode_cache_get', {
      p_provider: provider,
      p_kind: kind,
      p_key: key,
    }),
  );

const cachePut = (
  db: Db,
  provider: string,
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
    p_provider: provider,
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

/** Error text without URLs: a fetch error message can contain the request URL, i.e. the address. */
export const withoutUrls = (text: string) => text.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>');

/** A provider's error page as one short line, without markup, URLs, the address or the key. */
export const errorPageSummary = (body: string, query: string, apiKey?: string | null) =>
  withoutUrls(
    (apiKey ? body.split(apiKey).join('<key>') : body)
      .split(query)
      .join('<query>')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  ).slice(0, 300);

/** The provider needs an API key and none is set: say so once per worker, not per address. */
let warnedNoKey = false;
function keyMissing(deps: GeocoderDeps): boolean {
  const secret = GEOCODER_KEY_SECRETS[deps.settings.provider];
  if (!secret || deps.apiKey) return false;
  if (!warnedNoKey) {
    warnedNoKey = true;
    console.warn(`geocoder: ${secret} is not set (Edge Function secrets); addresses wait`);
  }
  return true;
}

async function search(deps: GeocoderDeps, query: string): Promise<Search> {
  const geoapify = deps.settings.provider === 'geoapify';
  const url = geoapify
    ? geoapifySearchUrl(deps.settings.url, query, deps.apiKey ?? '')
    : nominatimSearchUrl(deps.settings.url, query, { email: deps.settings.email });
  const started = Date.now();
  try {
    const res = await deps.fetch(url, {
      headers: { 'User-Agent': APP_USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      // 401 / 403 / 429 / 5xx: do not cache, try again later. Logged without address or key.
      const page = await res.text().catch(() => '');
      console.warn(
        `geocoder: ${deps.settings.provider} answered HTTP ${res.status} after ${Date.now() - started} ms: ${errorPageSummary(page, query, deps.apiKey)}`,
      );
      return { ok: false };
    }
    const body: unknown = await res.json();
    return { ok: true, hit: geoapify ? parseGeoapifyResults(body) : parseNominatimResults(body) };
  } catch (e) {
    const err = e as { name?: string; message?: string };
    console.warn(
      `geocoder: ${deps.settings.provider} request failed after ${Date.now() - started} ms: ${err?.name ?? 'Error'} ${withoutUrls(String(err?.message ?? '')).slice(0, 200)}`,
    );
    return { ok: false };
  }
}

export async function geocodeAddress(
  input: GeocodeInput,
  deps: GeocoderDeps,
): Promise<GeocodeOutcome> {
  const key = addressKey(input);
  const provider = deps.settings.provider;
  const base = { key, variant: null, displayName: null, cached: false, requests: 0 };
  const failed = (reason: GeocodeOutcome['reason']): GeocodeOutcome => ({
    ...base,
    lat: null,
    lng: null,
    precision: 'failed',
    reason,
  });

  if (!isBulgaria(input.country)) return failed('not_bulgaria');

  const known = await cacheGet(deps.db, provider, 'address', key);
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
    const known = await cacheGet(deps.db, provider, 'query', variant.q);
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
      // No key: nothing is sent, the address waits (answers already cached were still used).
      if (keyMissing(deps)) return { ...failed('provider_error'), requests };
      if (!(await takeSlot(deps))) return { ...failed('busy'), requests };
      requests++;
      const found = await search(deps, variant.q);
      if (!found.ok) return { ...failed('provider_error'), requests };
      hit = found.hit;
      await cachePut(deps.db, provider, 'query', variant.q, {
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
              places: hit.places ?? [],
            }
          : {},
      });
    }

    const precision = precisionOf(hit, variant.kind, parsed);
    // The city variants ARE the town; every other hit must lie in the town the address names.
    const inTown =
      variant.kind === 'city' || variant.kind === 'city_zip' || !hit || !parsed.city
        ? true
        : hitInCity(hit, parsed.city);
    if (hit && precision !== 'failed' && inTown) {
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
      await cachePut(deps.db, provider, 'address', key, {
        ...outcome,
        raw: { variant: variant.kind },
      });
      return outcome;
    }
  }

  // Nothing found with any variant: remember that too, so it is never asked again.
  const none: GeocodeOutcome = { ...base, lat: null, lng: null, precision: 'failed', requests };
  await cachePut(deps.db, provider, 'address', key, {
    ...none,
    raw: { variants: variants.length },
  });
  return none;
}
