/**
 * MockAdapter: an in-memory courier for tests (P4-02). It serves the points it is given, can be
 * told to fail, and counts its calls. Never used against the hosted project: the app never
 * invents courier data (brief section 7).
 */
import type { CourierMode, SupportedCarrier } from '../domain.ts';
import {
  COURIER_METHODS,
  fail,
  notAvailableYet,
  ok,
  type CourierAdapter,
  type CourierError,
  type CourierMethod,
  type CourierResult,
  type CourierSite,
  type OfficeList,
  type Quote,
  type QuoteRequest,
} from './adapter.ts';
import type { CourierPoint } from './points.ts';

export interface MockAdapterOptions {
  carrier: SupportedCarrier;
  points?: CourierPoint[];
  mode?: CourierMode | 'mock';
  capabilities?: readonly CourierMethod[];
  /** listOffices() returns this error instead of the points. */
  listError?: CourierError | null;
  quoteCents?: number;
}

export class MockAdapter implements CourierAdapter {
  readonly carrier: SupportedCarrier;
  readonly mode: CourierMode | 'mock';
  points: CourierPoint[];
  listError: CourierError | null;
  readonly calls: Record<CourierMethod, number>;
  private readonly caps: readonly CourierMethod[];
  private readonly quoteCents: number;

  constructor(options: MockAdapterOptions) {
    this.carrier = options.carrier;
    this.mode = options.mode ?? 'mock';
    this.points = options.points ?? [];
    this.listError = options.listError ?? null;
    this.caps = options.capabilities ?? ['listOffices', 'resolveSite', 'calculate'];
    this.quoteCents = options.quoteCents ?? 500;
    this.calls = Object.fromEntries(COURIER_METHODS.map((m) => [m, 0])) as Record<
      CourierMethod,
      number
    >;
  }

  capabilities(): readonly CourierMethod[] {
    return this.caps;
  }

  async listOffices(): Promise<CourierResult<OfficeList>> {
    this.calls.listOffices++;
    if (this.listError) return fail(this.listError);
    return ok({
      points: this.points.map((p) => ({ ...p })),
      source: `mock:${this.carrier}`,
      warnings: [],
      skipped: 0,
    });
  }

  async resolveSite(query: { name?: string | null }): Promise<CourierResult<CourierSite[]>> {
    this.calls.resolveSite++;
    const name = (query.name ?? '').trim().toLowerCase();
    const cities = [...new Set(this.points.map((p) => p.city).filter((c): c is string => !!c))];
    return ok(
      cities
        .filter((c) => !name || c.toLowerCase() === name)
        .map((c, i) => ({
          externalId: String(i + 1),
          name: c,
          nameEn: null,
          postcode: null,
          region: null,
        })),
    );
  }

  async calculate(_request: QuoteRequest): Promise<CourierResult<Quote>> {
    this.calls.calculate++;
    return ok({
      totalCents: this.quoteCents,
      currency: 'EUR',
      lines: [{ label: 'mock', cents: this.quoteCents }],
      approximate: false,
      source: 'mock',
    });
  }

  private later<T>(method: CourierMethod): Promise<CourierResult<T>> {
    this.calls[method]++;
    return Promise.resolve(notAvailableYet<T>(method, 9));
  }

  validateShipment() {
    return this.later<never>('validateShipment');
  }
  createShipment() {
    return this.later<never>('createShipment');
  }
  updateShipment() {
    return this.later<never>('updateShipment');
  }
  cancelShipment() {
    return this.later<never>('cancelShipment');
  }
  printLabel() {
    return this.later<never>('printLabel');
  }
  track() {
    return this.later<never>('track');
  }
  codPayments() {
    return this.later<never>('codPayments');
  }
}

/** A small, valid point for tests. */
export function mockPoint(
  carrier: SupportedCarrier,
  externalId: string,
  overrides: Partial<CourierPoint> = {},
): CourierPoint {
  return {
    carrier,
    externalId,
    code: externalId,
    type: 'office',
    nameBg: `Тест офис ${externalId}`,
    nameEn: null,
    city: 'Пловдив',
    postcode: '4000',
    addressText: `гр. Пловдив ул. Тестова ${externalId}`,
    lat: 42.1354,
    lng: 24.7453,
    coordConfidence: 3,
    coordSource: 'courier',
    workingHours: { weekdays: { from: '09:00', to: '18:00' }, saturday: null },
    phone: null,
    raw: {},
    ...overrides,
  };
}
