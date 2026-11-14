/**
 * Delivery detection job (Phase 5): read the shipments to detect, run packages/core's
 * detectDelivery with the real lookups (offices of the town, offices by code, the geocoder,
 * nearest offices), and store each decision with delivery_apply. Shared by the detect-delivery
 * Edge Function and the Node integration tests (RPC-only database access).
 */
import {
  detectDelivery,
  mergeDictionary,
  type DeliveryDecision,
  type DetectionDeps,
  type DetectionInput,
  type DetectionSettings,
  type DictionaryAdditions,
  type GeocoderSettings,
  type PointCandidate,
  type SupportedCarrier,
} from './core.ts';
import { call, type Db } from './db.ts';
import { geocodeAddress } from './geocoder.ts';

export interface PendingShipment {
  id: string;
  version: number;
  address1: string | null;
  address2: string | null;
  city: string | null;
  zip: string | null;
  country: string | null;
  company: string | null;
  notes: string[] | null;
  shipping_method: string | null;
  reference: string | null;
  manual: boolean;
}

export interface DeliveryJobDeps {
  db: Db;
  fetch: typeof fetch;
  geocoder: GeocoderSettings;
  /** Longest wait for a geocoder slot before giving up for this shipment (it stays pending). */
  geocodeMaxWaitMs: number;
  now?: () => number;
}

export function inputOf(s: PendingShipment): DetectionInput {
  return {
    address1: s.address1,
    address2: s.address2,
    company: s.company,
    notes: s.notes ?? [],
    city: s.city,
    zip: s.zip,
    country: s.country,
    shippingMethod: s.shipping_method,
  };
}

export async function loadDetectionSettings(db: Db): Promise<DetectionSettings> {
  const setting = async <T>(key: string, fallback: T): Promise<T> =>
    ((await call<T | null>(db, 'app_setting', { p_key: key })) ?? fallback) as T;
  const range = Number(await setting<number>('office_range_km', 1));
  const tie = await setting<SupportedCarrier>('home_carrier_tie_break', 'econt');
  const words = await setting<DictionaryAdditions>('detection_dictionary', {});
  return {
    officeRangeKm: Number.isFinite(range) && range > 0 ? range : 1,
    homeCarrierTieBreak: tie === 'speedy' ? 'speedy' : 'econt',
    dictionary: mergeDictionary(words),
  };
}

type PointRow = PointCandidate & { distance_km?: number | null };

export function detectionDeps(deps: DeliveryJobDeps): DetectionDeps {
  const { db } = deps;
  return {
    pointsInCity: async (city, zip) => {
      const rows: PointRow[] = [];
      for (const q of [city, zip]) {
        if (!q) continue;
        for (const r of await call<PointRow[]>(db, 'points_in_city', { p_query: q })) {
          if (!rows.some((x) => x.id === r.id)) rows.push(r);
        }
      }
      return rows;
    },
    pointsByCode: (carrier, codes) =>
      call<PointRow[]>(db, 'points_by_code', { p_carrier: carrier, p_codes: codes }),
    nearestPoints: (at, o) =>
      call<PointRow[]>(db, 'nearest_points', {
        p_lat: at.lat,
        p_lng: at.lng,
        p_carriers: o.carriers ?? null,
        p_types: o.types ?? null,
        p_max_km: o.maxKm,
        p_limit: o.limit,
      }),
    geocode: async (input) => {
      const out = await geocodeAddress(
        {
          address1: input.address1,
          address2: input.address2,
          city: input.city,
          zip: input.zip,
          country: input.country,
        },
        {
          db,
          fetch: deps.fetch,
          settings: deps.geocoder,
          mode: 'interactive',
          maxWaitMs: deps.geocodeMaxWaitMs,
        },
      );
      if (out.reason === 'busy' || out.reason === 'provider_error') return 'busy';
      if (out.precision === 'failed' || out.lat === null || out.lng === null) return null;
      return { lat: out.lat, lng: out.lng, precision: out.precision };
    },
  };
}

const compact = (p: PointCandidate | null) =>
  p && {
    id: p.id,
    carrier: p.carrier,
    type: p.type,
    name_bg: p.name_bg,
    address_text: p.address_text,
    distance_km: p.distance_km == null ? null : Math.round(p.distance_km * 1000) / 1000,
  };

/** The JSON delivery_apply stores. */
export function decisionJson(d: DeliveryDecision) {
  return {
    rule: d.rule,
    certainty: d.certainty,
    carrier: d.carrier,
    delivery_type: d.deliveryType,
    office_id: d.point?.id ?? null,
    suggestion: compact(d.suggestion),
    alternatives: d.alternatives.map(compact),
    reasons: d.reasons,
    hints: d.hints,
    geo: d.geo,
  };
}

export interface DetectedShipment {
  id: string;
  result: 'applied' | 'stale' | 'manual' | 'missing' | 'busy';
  decision?: ReturnType<typeof decisionJson>;
}

/**
 * Detect the given shipments (or every pending one), until the time budget is used. A shipment
 * whose geocoding is busy stays pending; the next run (or the 2-minute tick) does it.
 */
export async function runDetection(
  deps: DeliveryJobDeps,
  options: { ids?: string[]; budgetMs: number; limit?: number },
): Promise<DetectedShipment[]> {
  const now = deps.now ?? (() => Date.now());
  const started = now();
  const settings = await loadDetectionSettings(deps.db);
  const lookups = detectionDeps(deps);
  const pending = await call<PendingShipment[]>(deps.db, 'delivery_pending', {
    p_limit: options.limit ?? 50,
    p_ids: options.ids ?? null,
  });
  const out: DetectedShipment[] = [];
  for (const s of pending) {
    if (now() - started >= options.budgetMs) break;
    if (s.manual) {
      const result = await call<DetectedShipment['result']>(deps.db, 'delivery_apply', {
        p_shipment_id: s.id,
        p_version: s.version,
        p_decision: {},
      });
      out.push({ id: s.id, result });
      continue;
    }
    const outcome = await detectDelivery(inputOf(s), lookups, settings);
    if (outcome.kind === 'busy') {
      out.push({ id: s.id, result: 'busy' });
      break; // the geocoder is busy for everyone: stop, the next run continues
    }
    const decision = decisionJson(outcome.decision);
    const result = await call<DetectedShipment['result']>(deps.db, 'delivery_apply', {
      p_shipment_id: s.id,
      p_version: s.version,
      p_decision: decision,
    });
    out.push({ id: s.id, result, decision });
  }
  return out;
}
