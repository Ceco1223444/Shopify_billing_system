// detect-delivery — where each shipment goes and how sure that is (Phase 5).
//
// POST JSON { action, shipment_ids?, wait? }
//   pending  every shipment whose address changed or was never detected (after an import, and
//            every 2 minutes from pg_cron); runs in the background unless wait: true
//   ids      the given shipments now (after a person edits an address); answers with the decisions
// Callers: members (owner and packers), pg_cron (its token), a service key (scripts, tests).
// The geocoder (settings.geocoder: Geoapify, key in GEOAPIFY_API_KEY) is called 1.2 s apart at
// most; a busy or failing geocoder leaves the shipment pending.
// On the local stack the geocoder is off (no test address ever reaches a real geocoder).
// Nothing about the customer is logged.
import { DEFAULT_GEOCODER_SETTINGS, type GeocoderSettings } from '../_shared/core.ts';
import { runDetection, type DeliveryJobDeps } from '../_shared/delivery.ts';
import {
  adminClient,
  CORS,
  geocoderApiKey,
  identify,
  isLocalStack,
  json,
} from '../_shared/http.ts';

const BACKGROUND_BUDGET_MS = 100_000;
const WAIT_BUDGET_MS = 25_000;

interface Body {
  action?: 'pending' | 'ids';
  shipment_ids?: string[];
  wait?: boolean;
}

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });

  const admin = adminClient();
  const caller = await identify(req, admin);
  if (caller instanceof Response) return caller;

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return json(400, { error: 'bad_request' });
  }
  const action = body.action ?? 'pending';
  const ids = (body.shipment_ids ?? []).filter((id) => typeof id === 'string' && UUID.test(id));
  if (
    !['pending', 'ids'].includes(action) ||
    (action === 'ids' && !ids.length) ||
    ids.length > 50
  ) {
    return json(400, { error: 'bad_request' });
  }

  // Tell pg_cron where the functions live (hosted only), like courier-sync does.
  if (!isLocalStack() && caller.kind !== 'cron') {
    await admin.rpc('courier_sync_set_functions_url', {
      p_url: `${Deno.env.get('SUPABASE_URL')}/functions/v1`,
    });
  }

  const { data: stored } = await admin.rpc('app_setting', { p_key: 'geocoder' });
  const geocoder = (stored as GeocoderSettings | null) ?? DEFAULT_GEOCODER_SETTINGS;
  // The local stack (tests, CI) never sends addresses to a real geocoder: there the geocoder
  // is off unless GEOCODER_LOCAL=on is set for the local functions.
  const localOff = isLocalStack() && Deno.env.get('GEOCODER_LOCAL') !== 'on';
  const deps: DeliveryJobDeps = {
    db: admin,
    fetch,
    geocoder: localOff ? { ...geocoder, enabled: false } : geocoder,
    geocoderApiKey: geocoderApiKey(geocoder.provider),
    geocodeMaxWaitMs: action === 'ids' ? 8_000 : 20_000,
  };

  const work = () =>
    runDetection(deps, {
      ids: action === 'ids' ? ids : undefined,
      budgetMs: body.wait || action === 'ids' ? WAIT_BUDGET_MS : BACKGROUND_BUDGET_MS,
      limit: action === 'ids' ? ids.length : 200,
    });

  if (action === 'ids' || body.wait || typeof EdgeRuntime === 'undefined') {
    try {
      return json(200, { ok: true, shipments: await work() });
    } catch (e) {
      console.error('detect-delivery failed', (e as { code?: string })?.code ?? '');
      return json(500, { error: 'detect_failed' });
    }
  }
  EdgeRuntime.waitUntil(
    work()
      .then((done) => {
        // Counts only: nothing about the customers.
        const counts: Record<string, number> = {};
        for (const d of done) counts[d.result] = (counts[d.result] ?? 0) + 1;
        console.log('detect-delivery done', JSON.stringify(counts));
      })
      .catch((e) => console.error('detect-delivery failed', e?.code ?? '')),
  );
  return json(202, { ok: true });
});
