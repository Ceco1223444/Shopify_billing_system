/**
 * EcontApiAdapter (P4-02): Econt's JSON API.
 *
 * Phase 4 uses only read-only calls: offices, cities, streets, quarters, price calculation
 * (createLabel with mode "calculate", which creates nothing). Creating, changing, printing and
 * cancelling waybills come in Phase 9; tracking and COD payments in Phase 11. Until then those
 * methods answer "not_available_yet": the capability list already says Econt can do them.
 *
 * Offices are public: getOffices answers without a login on both environments (checked
 * 13 Nov 2026). The production login (secrets ECONT_USERNAME / ECONT_PASSWORD) is sent when set;
 * the demo uses Econt's published test account.
 */
import {
  COURIER_METHODS,
  ECONT_DEMO_LOGIN,
  ECONT_PATHS,
  ECONT_URLS,
  econtCalculateRequest,
  econtErrorMessage,
  fail,
  latinKey,
  mapEcontCity,
  mapEcontOffices,
  notAvailableYet,
  ok,
  parseEcontQuote,
  type CourierAdapter,
  type CourierMethod,
  type CourierResult,
  type CourierSite,
  type EcontEnv,
  type EcontQuarter,
  type EcontStreet,
  type OfficeList,
  type Quote,
  type QuoteRequest,
} from '../core.ts';

export interface EcontLogin {
  username: string;
  password: string;
}

export interface EcontAdapterOptions {
  /** Environment for offices / cities (read-only). The office sync always uses production. */
  dataEnv: EcontEnv;
  /** Environment for prices and (Phase 9) waybills: settings.econt_env. */
  shipmentEnv: EcontEnv;
  /** Production login from the Supabase secrets, or null when not set yet. */
  productionLogin: EcontLogin | null;
  fetch: typeof fetch;
  timeoutMs?: number;
}

function basicAuth(login: EcontLogin): string {
  const bytes = new TextEncoder().encode(`${login.username}:${login.password}`);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return `Basic ${btoa(binary)}`;
}

export class EcontApiAdapter implements CourierAdapter {
  readonly carrier = 'econt' as const;
  readonly mode = 'api' as const;

  constructor(private readonly options: EcontAdapterOptions) {}

  capabilities(): readonly CourierMethod[] {
    return COURIER_METHODS;
  }

  private login(env: EcontEnv): EcontLogin | null {
    return env === 'demo' ? ECONT_DEMO_LOGIN : this.options.productionLogin;
  }

  private async post(
    env: EcontEnv,
    path: string,
    body: unknown,
    needsLogin: boolean,
  ): Promise<CourierResult<unknown>> {
    const login = this.login(env);
    if (needsLogin && !login) {
      return fail({
        code: 'credentials_missing',
        message: 'ECONT_USERNAME / ECONT_PASSWORD are not set in the Supabase secrets',
      });
    }
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (login) headers.Authorization = basicAuth(login);
    let res: Response;
    try {
      res = await this.options.fetch(ECONT_URLS[env] + path, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
      });
    } catch (e) {
      return fail({ code: 'http_error', message: `Econt ${path}: ${(e as Error).message}` });
    }
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      return fail({ code: 'bad_response', message: `Econt ${path}: not JSON`, status: res.status });
    }
    if (!res.ok) {
      const message = econtErrorMessage(json) ?? `HTTP ${res.status}`;
      return fail({
        code: res.status === 401 || res.status === 403 ? 'credentials_missing' : 'courier_error',
        message: `Econt ${path}: ${message}`,
        status: res.status,
      });
    }
    return ok(json);
  }

  async listOffices(): Promise<CourierResult<OfficeList>> {
    const env = this.options.dataEnv;
    const res = await this.post(env, ECONT_PATHS.offices, { countryCode: 'BGR' }, false);
    if (!res.ok) return res;
    try {
      const mapped = mapEcontOffices(res.value);
      return ok({
        points: mapped.points,
        source: `econt_api:${env}`,
        skipped: mapped.skipped,
        warnings: mapped.withoutCoordinates
          ? [`${mapped.withoutCoordinates} offices without coordinates`]
          : [],
      });
    } catch (e) {
      return fail({ code: 'parse_failed', message: (e as Error).message });
    }
  }

  /** getCities, then the ones matching the name (Cyrillic or Latin) and/or postcode. */
  async resolveSite(query: {
    name?: string | null;
    postcode?: string | null;
  }): Promise<CourierResult<CourierSite[]>> {
    const res = await this.post(
      this.options.dataEnv,
      ECONT_PATHS.cities,
      { countryCode: 'BGR' },
      false,
    );
    if (!res.ok) return res;
    const cities = (res.value as { cities?: unknown[] } | null)?.cities;
    if (!Array.isArray(cities))
      return fail({ code: 'bad_response', message: 'getCities: no cities' });
    const name = query.name ? latinKey(query.name.replace(/^(гр|с)\.\s*/i, '')) : null;
    const postcode = query.postcode?.trim() || null;
    const sites = cities
      .map((c) => mapEcontCity(c as Parameters<typeof mapEcontCity>[0]))
      .filter((s): s is CourierSite => !!s)
      .filter(
        (s) =>
          (!name || latinKey(s.name) === name || (s.nameEn && latinKey(s.nameEn) === name)) &&
          (!postcode || s.postcode === postcode),
      );
    return ok(sites);
  }

  /** P4-07: streets of an Econt city (Phase 9 uses them for home addresses). */
  async listStreets(cityId: number): Promise<CourierResult<EcontStreet[]>> {
    const res = await this.post(
      this.options.dataEnv,
      ECONT_PATHS.streets,
      { cityID: cityId },
      false,
    );
    if (!res.ok) return res;
    const streets = (res.value as { streets?: EcontStreet[] } | null)?.streets;
    return Array.isArray(streets)
      ? ok(streets)
      : fail({ code: 'bad_response', message: 'getStreets: no streets' });
  }

  /** P4-07: quarters (ж.к., кв.) of an Econt city. */
  async listQuarters(cityId: number): Promise<CourierResult<EcontQuarter[]>> {
    const res = await this.post(
      this.options.dataEnv,
      ECONT_PATHS.quarters,
      { cityID: cityId },
      false,
    );
    if (!res.ok) return res;
    const quarters = (res.value as { quarters?: EcontQuarter[] } | null)?.quarters;
    return Array.isArray(quarters)
      ? ok(quarters)
      : fail({ code: 'bad_response', message: 'getQuarters: no quarters' });
  }

  /** Price from Econt (read-only: mode "calculate" creates no waybill). */
  async calculate(request: QuoteRequest): Promise<CourierResult<Quote>> {
    const res = await this.post(
      this.options.shipmentEnv,
      ECONT_PATHS.createLabel,
      econtCalculateRequest(request),
      true,
    );
    if (!res.ok) return res;
    try {
      return ok({ ...parseEcontQuote(res.value), source: `econt_api:${this.options.shipmentEnv}` });
    } catch (e) {
      return fail({ code: 'bad_response', message: (e as Error).message });
    }
  }

  validateShipment() {
    return Promise.resolve(notAvailableYet<never>('validateShipment', 9));
  }
  createShipment() {
    return Promise.resolve(notAvailableYet<never>('createShipment', 9));
  }
  updateShipment() {
    return Promise.resolve(notAvailableYet<never>('updateShipment', 9));
  }
  cancelShipment() {
    return Promise.resolve(notAvailableYet<never>('cancelShipment', 9));
  }
  printLabel() {
    return Promise.resolve(notAvailableYet<never>('printLabel', 9));
  }
  track() {
    return Promise.resolve(notAvailableYet<never>('track', 11));
  }
  codPayments() {
    return Promise.resolve(notAvailableYet<never>('codPayments', 11));
  }
}
