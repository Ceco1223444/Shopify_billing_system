// courier-sync — Econt and Speedy offices / lockers into courier_offices (Phase 4).
//
// POST JSON { action, carriers?, wait?, env?, mock? }
//   start     carriers (default both): start a run per carrier (or join the running one), work on it
//   continue  resume unfinished runs, then geocode points without coordinates
//   probe     fetch and count only, write nothing (manual smoke test; env: demo | production)
// Callers: the owner ("Обнови офисите"), pg_cron (its token), service key (scripts, tests).
// The work runs in the background (EdgeRuntime.waitUntil) and the call answers 202 at once,
// unless wait: true. The owner's page follows the progress in courier_sync_runs.
//
// mock: { econt?: points[], speedy?: points[] } serves those points instead of the couriers.
// Only for the service key on the LOCAL stack (tests): the hosted app never invents offices.
import {
  ECONT_URLS,
  MockAdapter,
  DEFAULT_GEOCODER_SETTINGS,
  ok,
  type CourierAdapter,
  type CourierMode,
  type CourierPoint,
  type CourierResult,
  type EcontEnv,
  type GeocoderSettings,
  type SupportedCarrier,
} from '../_shared/core.ts';
import { EcontApiAdapter } from '../_shared/couriers/econt-api-adapter.ts';
import { selectAdapter } from '../_shared/couriers/select.ts';
import { SpeedyManualAdapter } from '../_shared/couriers/speedy-manual-adapter.ts';
import { continueAll, processRuns, startRuns, type SyncJobDeps } from '../_shared/courier-sync.ts';
import {
  adminClient,
  CORS,
  econtProductionLogin,
  geocoderApiKey,
  identify,
  isLocalStack,
  json,
} from '../_shared/http.ts';

const CARRIERS: SupportedCarrier[] = ['econt', 'speedy'];
/** Background work stops starting new steps after this (hosted limit: 150 s wall clock). */
const BACKGROUND_BUDGET_MS = 100_000;
const WAIT_BUDGET_MS = 50_000;
const LEASE_SECONDS = 150;
/** Used only if a setting is missing (the migrations seed them; see SETTINGS_DEFAULTS). */
const FALLBACK = {
  courier_modes: { econt: 'api', speedy: 'manual' } as Record<SupportedCarrier, CourierMode>,
  geocoder: DEFAULT_GEOCODER_SETTINGS as GeocoderSettings,
};

interface Body {
  action?: 'start' | 'continue' | 'probe';
  carriers?: SupportedCarrier[];
  trigger?: string;
  wait?: boolean;
  env?: EcontEnv;
  mock?: Partial<Record<SupportedCarrier, CourierPoint[]>>;
}

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });

  const admin = adminClient();
  const caller = await identify(req, admin);
  if (caller instanceof Response) return caller;
  if (caller.kind === 'member' && caller.role !== 'owner') {
    return json(403, { error: 'owner_only' });
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return json(400, { error: 'bad_request' });
  }
  const action = body.action ?? 'start';
  const carriers = (body.carriers ?? CARRIERS).filter((c) => CARRIERS.includes(c));
  if (!['start', 'continue', 'probe'].includes(action) || !carriers.length) {
    return json(400, { error: 'bad_request' });
  }
  const useMock = !!body.mock && caller.kind === 'service' && isLocalStack();
  if (body.mock && !useMock) return json(403, { error: 'mock_not_allowed' });

  // Tell pg_cron where this function lives (hosted project only; the URL never changes).
  if (!isLocalStack() && caller.kind !== 'cron') {
    await admin.rpc('courier_sync_set_functions_url', {
      p_url: `${Deno.env.get('SUPABASE_URL')}/functions/v1`,
    });
  }

  const setting = async <T>(key: string, fallback: T): Promise<T> => {
    const { data } = await admin.rpc('app_setting', { p_key: key });
    return (data as T | null) ?? fallback;
  };
  const modes = await setting<Record<SupportedCarrier, CourierMode>>(
    'courier_modes',
    FALLBACK.courier_modes,
  );
  const econtEnv = await setting<EcontEnv>('econt_env', 'demo');
  const geocoder = await setting<GeocoderSettings>('geocoder', FALLBACK.geocoder);

  const adapterFor = (carrier: SupportedCarrier): Promise<CourierResult<CourierAdapter>> => {
    if (useMock) {
      return Promise.resolve(ok(new MockAdapter({ carrier, points: body.mock?.[carrier] ?? [] })));
    }
    return Promise.resolve(
      selectAdapter(carrier, modes[carrier], {
        fetch,
        econtProductionLogin: econtProductionLogin(),
        econtShipmentEnv: econtEnv,
        findTariff: async (c, deliveryType, weightG) => {
          const { data } = await admin.rpc('tariff_find', {
            p_carrier: c,
            p_delivery_type: deliveryType,
            p_weight_g: weightG,
            p_on: new Date().toISOString().slice(0, 10),
          });
          return data && (data as { id: string | null }).id ? data : null;
        },
      }),
    );
  };

  // probe: counts straight from the source, nothing written (T4-08 smoke test).
  if (action === 'probe') {
    if (caller.kind === 'cron') return json(403, { error: 'owner_only' });
    const result: Record<string, unknown> = {};
    for (const carrier of carriers) {
      const adapter: CourierAdapter =
        carrier === 'econt'
          ? new EcontApiAdapter({
              dataEnv: body.env === 'demo' ? 'demo' : 'production',
              shipmentEnv: econtEnv,
              productionLogin: econtProductionLogin(),
              fetch,
            })
          : new SpeedyManualAdapter({ fetch, findTariff: () => Promise.resolve(null) });
      const list = await adapter.listOffices();
      if (!list.ok) {
        result[carrier] = { ok: false, error: list.error };
        continue;
      }
      const byType: Record<string, number> = {};
      for (const p of list.value.points) byType[p.type] = (byType[p.type] ?? 0) + 1;
      result[carrier] = {
        ok: true,
        source: list.value.source,
        url: carrier === 'econt' ? ECONT_URLS[body.env === 'demo' ? 'demo' : 'production'] : null,
        total: list.value.points.length,
        byType,
        withCoordinates: list.value.points.filter((p) => p.lat !== null).length,
        skipped: list.value.skipped,
        warnings: list.value.warnings,
      };
    }
    return json(200, { ok: true, probe: result });
  }

  const budget = body.wait ? WAIT_BUDGET_MS : BACKGROUND_BUDGET_MS;
  const deps: SyncJobDeps = {
    db: admin,
    adapterFor,
    budgetMs: budget,
    leaseSeconds: LEASE_SECONDS,
    geocoder: useMock
      ? null
      : { settings: geocoder, apiKey: geocoderApiKey(geocoder.provider), fetch },
    log: (message) => console.log(message),
  };

  let runs: { id: string; carrier: string }[] = [];
  if (action === 'start') {
    const trigger = caller.kind === 'cron' ? 'cron' : body.trigger === 'test' ? 'test' : 'manual';
    const actor = caller.kind === 'member' ? caller.userId : null;
    runs = await startRuns(carriers, trigger, actor, deps);
  }

  const work = async () => {
    if (action === 'start') {
      const processed = await processRuns(
        runs.map((r) => r.id),
        deps,
      );
      return { runs: processed };
    }
    return continueAll(deps);
  };

  if (body.wait || typeof EdgeRuntime === 'undefined') {
    return json(200, { ok: true, ...(await work()) });
  }
  EdgeRuntime.waitUntil(work().catch((e) => console.error('courier-sync failed', e?.code ?? '')));
  return json(202, { ok: true, runs: runs.map((r) => ({ id: r.id, carrier: r.carrier })) });
});
