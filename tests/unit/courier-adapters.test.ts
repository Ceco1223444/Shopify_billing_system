/**
 * The Edge Functions' courier adapters with a fake network (P4-02, P4-03).
 * Saved answers: packages/core/test/fixtures (Econt getOffices, Speedy's public pages).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EcontApiAdapter } from '../../supabase/functions/_shared/couriers/econt-api-adapter';
import { selectAdapter } from '../../supabase/functions/_shared/couriers/select';
import {
  SpeedyManualAdapter,
  type TariffBand,
} from '../../supabase/functions/_shared/couriers/speedy-manual-adapter';

const fixture = (name: string) =>
  readFileSync(new URL(`../../packages/core/test/fixtures/${name}`, import.meta.url), 'utf8');

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** fetch() that answers by URL and remembers every request. */
function fakeFetch(answer: (url: string) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    seen.push({
      url,
      method: init?.method ?? 'GET',
      headers,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return answer(url);
  }) as typeof fetch;
  return { fetch: fn, seen };
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const quoteRequest = {
  senderOfficeCode: '4044',
  destination: { kind: 'office' as const, officeCode: '7029' },
  weightG: 1500,
  codCents: 5000,
  declaredValueCents: 0,
  payer: 'SENDER' as const,
  packCount: 1,
};

function econt(
  fetchImpl: typeof fetch,
  login: { username: string; password: string } | null = null,
) {
  return new EcontApiAdapter({
    dataEnv: 'production',
    shipmentEnv: 'demo',
    productionLogin: login,
    fetch: fetchImpl,
  });
}

describe('EcontApiAdapter', () => {
  it('lists offices from production without a login (getOffices is public)', async () => {
    const net = fakeFetch(() => new Response(fixture('econt-offices.json')));
    const res = await econt(net.fetch).listOffices();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.source).toBe('econt_api:production');
    expect(res.value.points.map((p) => p.externalId)).toEqual([
      '4044',
      '4068',
      '2951@2932',
      '10016',
      '7029',
    ]);
    expect(net.seen).toEqual([
      {
        url: 'https://ee.econt.com/services/Nomenclatures/NomenclaturesService.getOffices.json',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: { countryCode: 'BGR' },
      },
    ]);
  });

  it('sends the production login when the owner has set it', async () => {
    const net = fakeFetch(() => new Response(fixture('econt-offices.json')));
    await econt(net.fetch, { username: 'shop@example.com', password: 'secret' }).listOffices();
    expect(net.seen[0]!.headers.authorization).toBe(
      `Basic ${Buffer.from('shop@example.com:secret').toString('base64')}`,
    );
  });

  it('reports Econt errors, HTTP failures and junk answers', async () => {
    const error = await econt(
      fakeFetch(() => jsonResponse({ type: 'ExInvalidParam', message: 'Bad country' }, 400)).fetch,
    ).listOffices();
    expect(error).toMatchObject({ ok: false, error: { code: 'courier_error', status: 400 } });
    if (!error.ok) expect(error.error.message).toContain('Bad country');

    const junk = await econt(fakeFetch(() => new Response('<html>')).fetch).listOffices();
    expect(junk).toMatchObject({ ok: false, error: { code: 'bad_response' } });

    const notAList = await econt(fakeFetch(() => jsonResponse({ cities: [] })).fetch).listOffices();
    expect(notAList).toMatchObject({ ok: false, error: { code: 'parse_failed' } });

    const down = await econt(
      fakeFetch(() => Promise.reject(new Error('connection reset'))).fetch,
    ).listOffices();
    expect(down).toMatchObject({ ok: false, error: { code: 'http_error' } });
  });

  it('calculates on the demo with Econt’s published test account (read-only "calculate")', async () => {
    const net = fakeFetch(() =>
      jsonResponse({ label: { totalPrice: 4.54, currency: 'EUR', services: [] } }),
    );
    const res = await econt(net.fetch).calculate(quoteRequest);
    expect(res).toMatchObject({ ok: true, value: { totalCents: 454, source: 'econt_api:demo' } });
    expect(net.seen[0]!.url).toBe(
      'https://demo.econt.com/ee/services/Shipments/LabelService.createLabel.json',
    );
    expect((net.seen[0]!.body as { mode: string }).mode).toBe('calculate');
    expect(net.seen[0]!.headers.authorization).toBe(
      `Basic ${Buffer.from('iasp-dev:1Asp-dev').toString('base64')}`,
    );
  });

  it('refuses production prices without the production login, and sends nothing', async () => {
    const net = fakeFetch(() => jsonResponse({}));
    const adapter = new EcontApiAdapter({
      dataEnv: 'production',
      shipmentEnv: 'production',
      productionLogin: null,
      fetch: net.fetch,
    });
    expect(await adapter.calculate(quoteRequest)).toMatchObject({
      ok: false,
      error: { code: 'credentials_missing' },
    });
    expect(net.seen).toEqual([]);
  });

  it('resolveSite, streets and quarters (P4-07)', async () => {
    const net = fakeFetch((url) => {
      if (url.endsWith('getCities.json')) {
        return jsonResponse({
          cities: [
            { id: 33, name: 'Пловдив', nameEn: 'Plovdiv', postCode: '4000' },
            { id: 41, name: 'София', nameEn: 'Sofia', postCode: '1000' },
            { id: 99, name: 'Пловдивци', nameEn: 'Plovdivtsi', postCode: '4758' },
          ],
        });
      }
      if (url.endsWith('getStreets.json'))
        return jsonResponse({ streets: [{ id: 1, name: 'Иван Вазов' }] });
      return jsonResponse({ quarters: [{ id: 2, name: 'Тракия' }] });
    });
    const adapter = econt(net.fetch);
    const byName = await adapter.resolveSite({ name: 'гр. Пловдив' });
    expect(byName.ok && byName.value.map((s) => s.externalId)).toEqual(['33']);
    const latin = await adapter.resolveSite({ name: 'Sofia' });
    expect(latin.ok && latin.value.map((s) => s.externalId)).toEqual(['41']);
    const byPostcode = await adapter.resolveSite({ postcode: '4758' });
    expect(byPostcode.ok && byPostcode.value.map((s) => s.name)).toEqual(['Пловдивци']);
    expect(await adapter.listStreets(33)).toEqual({
      ok: true,
      value: [{ id: 1, name: 'Иван Вазов' }],
    });
    expect(await adapter.listQuarters(33)).toEqual({
      ok: true,
      value: [{ id: 2, name: 'Тракия' }],
    });
    expect(net.seen.at(-1)!.body).toEqual({ cityID: 33 });
  });

  it('can do everything in API mode; waybills come in Phase 9, tracking and COD in Phase 11', async () => {
    const net = fakeFetch(() => jsonResponse({}));
    const adapter = econt(net.fetch);
    expect(adapter.capabilities()).toContain('createShipment');
    expect(await adapter.createShipment()).toMatchObject({
      ok: false,
      error: { code: 'not_available_yet', phase: 9 },
    });
    expect(await adapter.printLabel()).toMatchObject({ error: { phase: 9 } });
    expect(await adapter.cancelShipment()).toMatchObject({ error: { phase: 9 } });
    expect(await adapter.track()).toMatchObject({ error: { phase: 11 } });
    expect(await adapter.codPayments()).toMatchObject({ error: { phase: 11 } });
    expect(net.seen).toEqual([]); // nothing was sent to Econt
  });
});

describe('SpeedyManualAdapter', () => {
  const tariffs = (band: TariffBand | null) => async () => band;

  it('reads the public list and the public map page, and nothing else', async () => {
    const net = fakeFetch((url) =>
      url.includes('offices_list.php')
        ? new Response(fixture('speedy-offices-list.html'))
        : new Response(fixture('speedy-officesmap.html')),
    );
    const res = await new SpeedyManualAdapter({
      fetch: net.fetch,
      findTariff: tariffs(null),
    }).listOffices();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.points).toHaveLength(124);
    expect(res.value.source).toBe('speedy_public_list');
    expect(res.value.warnings).toEqual(['1 offices without coordinates on the map page']);
    expect(net.seen.map((s) => s.url)).toEqual([
      'https://services.speedy.bg/office_locator_widget_v2/offices_list.php?lang=bg&countryId=',
      'https://services.speedy.bg/officesmap_v2/?lang=bg&id=190',
    ]);
    for (const s of net.seen) {
      expect(s.method).toBe('GET');
      expect(s.headers['user-agent']).toMatch(/^HappyHome-Shipping-Hub\//);
    }
  });

  it('a changed list page is "parse_failed" (the sync then keeps the stored offices)', async () => {
    const net = fakeFetch(() => new Response('<html><body>Нова страница</body></html>'));
    const res = await new SpeedyManualAdapter({
      fetch: net.fetch,
      findTariff: tariffs(null),
    }).listOffices();
    expect(res).toMatchObject({ ok: false, error: { code: 'parse_failed' } });
  });

  it('a failing map page still syncs the list, without coordinates', async () => {
    const net = fakeFetch((url) =>
      url.includes('offices_list.php')
        ? new Response(fixture('speedy-offices-list.html'))
        : new Response('down', { status: 503 }),
    );
    const res = await new SpeedyManualAdapter({
      fetch: net.fetch,
      findTariff: tariffs(null),
    }).listOffices();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.points.every((p) => p.lat === null)).toBe(true);
    expect(res.value.warnings[0]).toContain('map page failed');
  });

  it('prices from the tariff table, marked approximate; no tariff → no_tariff', async () => {
    const band = {
      max_weight_g: 1000,
      price_cents: 450,
      extra_per_kg_cents: 60,
      source: 'speedy.bg 2026',
    };
    const adapter = new SpeedyManualAdapter({
      fetch: fakeFetch(() => jsonResponse({})).fetch,
      findTariff: tariffs(band),
    });
    expect(await adapter.calculate({ ...quoteRequest, weightG: 2500 })).toEqual({
      ok: true,
      value: {
        totalCents: 450 + 2 * 60,
        currency: 'EUR',
        lines: [
          { label: '≤ 1000 g', cents: 450 },
          { label: '+2 kg', cents: 120 },
        ],
        approximate: true,
        source: 'speedy.bg 2026',
      },
    });
    const none = new SpeedyManualAdapter({
      fetch: fakeFetch(() => jsonResponse({})).fetch,
      findTariff: tariffs(null),
    });
    expect(await none.calculate(quoteRequest)).toMatchObject({
      ok: false,
      error: { code: 'no_tariff' },
    });
  });

  it('everything else is "not supported in manual mode"', async () => {
    const adapter = new SpeedyManualAdapter({
      fetch: fakeFetch(() => jsonResponse({})).fetch,
      findTariff: tariffs(null),
    });
    expect(adapter.capabilities()).toEqual(['listOffices', 'calculate']);
    for (const result of [
      await adapter.createShipment(),
      await adapter.printLabel(),
      await adapter.track(),
      await adapter.codPayments(),
      await adapter.resolveSite(),
    ]) {
      expect(result).toMatchObject({ ok: false, error: { code: 'not_supported_in_manual_mode' } });
    }
  });
});

describe('selectAdapter (P4-03)', () => {
  const deps = {
    fetch: fakeFetch(() => jsonResponse({})).fetch,
    econtProductionLogin: null,
    econtShipmentEnv: 'demo' as const,
    findTariff: async () => null,
  };

  it('picks the adapter from settings.courier_modes', () => {
    const e = selectAdapter('econt', 'api', deps);
    expect(e.ok && e.value).toBeInstanceOf(EcontApiAdapter);
    const s = selectAdapter('speedy', 'manual', deps);
    expect(s.ok && s.value).toBeInstanceOf(SpeedyManualAdapter);
  });

  it('Speedy "api" (Phase 13) and Econt "manual" have no adapter yet', () => {
    expect(selectAdapter('speedy', 'api', deps)).toMatchObject({
      ok: false,
      error: { code: 'mode_not_available' },
    });
    expect(selectAdapter('econt', 'manual', deps)).toMatchObject({ ok: false });
  });
});
