// geocode — a Shopify shipping address → { lat, lng, precision } with Nominatim (Phase 4).
//
// POST JSON { address1, address2, city, zip, province, country } (the Shopify columns).
// Callers: signed-in members, or a service key (later phases call it from the server).
// Answers:
//   200 { ok, result: { lat, lng, precision: street|block|quarter|city|failed, cached, variant } }
//   400 bad_request, 401 not_signed_in, 403 not_a_member,
//   503 busy (the app's 1-request-per-second slot is taken: try again in a moment),
//   502 provider_error (Nominatim did not answer).
// Only the address is sent to Nominatim; nothing is logged.
import {
  DEFAULT_GEOCODER_SETTINGS,
  type GeocodeInput,
  type GeocoderSettings,
} from '../_shared/core.ts';
import { geocodeAddress } from '../_shared/geocoder.ts';
import { adminClient, CORS, geocoderApiKey, identify, json } from '../_shared/http.ts';

const FIELDS = ['address1', 'address2', 'city', 'zip', 'province', 'country'] as const;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });

  const admin = adminClient();
  const caller = await identify(req, admin);
  if (caller instanceof Response) return caller;
  if (caller.kind === 'cron') return json(403, { error: 'not_a_member' });

  let input: GeocodeInput;
  try {
    const body = (await req.json()) as Record<string, unknown>;
    input = {};
    for (const field of FIELDS) {
      const value = body[field];
      if (value !== undefined && value !== null && typeof value !== 'string') throw new Error();
      input[field] = typeof value === 'string' ? value.slice(0, 300) : null;
    }
  } catch {
    return json(400, { error: 'bad_request' });
  }

  const { data } = await admin.rpc('app_setting', { p_key: 'geocoder' });
  const settings = (data as GeocoderSettings | null) ?? DEFAULT_GEOCODER_SETTINGS;

  try {
    const result = await geocodeAddress(input, {
      db: admin,
      fetch,
      settings,
      apiKey: geocoderApiKey(settings.provider),
      mode: 'interactive',
      maxWaitMs: 8000,
    });
    if (result.reason === 'busy') return json(503, { error: 'busy' });
    if (result.reason === 'provider_error') return json(502, { error: 'provider_error' });
    return json(200, { ok: true, result });
  } catch (e) {
    console.error('geocode failed', (e as { code?: string }).code ?? '');
    return json(500, { error: 'geocode_failed' });
  }
});
