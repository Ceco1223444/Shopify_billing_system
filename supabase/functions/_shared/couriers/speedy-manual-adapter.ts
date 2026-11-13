/**
 * SpeedyManualAdapter (P4-02): Speedy without API credentials.
 *
 *   listOffices  Speedy's PUBLIC office list page + its public map page (coordinates).
 *                Never the Speedy REST API (brief section 7). Two GET requests per sync.
 *   calculate    from the tariff table ("ориентировъчна цена"; seeded in Phase 7).
 *   everything else → "not supported in manual mode": the owner makes the waybill in MySpeedy.
 */
import {
  fail,
  APP_USER_AGENT,
  mergeSpeedy,
  notSupportedInManualMode,
  ok,
  parseSpeedyMapData,
  parseSpeedyOfficeList,
  SPEEDY_LIST_URL,
  speedyMapUrl,
  type CourierAdapter,
  type CourierMethod,
  type CourierResult,
  type OfficeList,
  type Quote,
  type QuoteRequest,
} from '../core.ts';

/** A tariffs row (only the columns the price needs). */
export interface TariffBand {
  max_weight_g: number;
  price_cents: number;
  extra_per_kg_cents: number | null;
  source: string;
}

export interface SpeedyManualOptions {
  fetch: typeof fetch;
  /** The tariff band for a weight, or null (tariff_find RPC). */
  findTariff(
    deliveryType: 'office' | 'locker' | 'address',
    weightG: number,
  ): Promise<TariffBand | null>;
  timeoutMs?: number;
}

export class SpeedyManualAdapter implements CourierAdapter {
  readonly carrier = 'speedy' as const;
  readonly mode = 'manual' as const;

  constructor(private readonly options: SpeedyManualOptions) {}

  capabilities(): readonly CourierMethod[] {
    return ['listOffices', 'calculate'];
  }

  private async getPage(url: string): Promise<CourierResult<string>> {
    try {
      const res = await this.options.fetch(url, {
        headers: { 'User-Agent': APP_USER_AGENT, Accept: 'text/html' },
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
      });
      if (!res.ok) {
        return fail({
          code: 'http_error',
          message: `Speedy page: HTTP ${res.status}`,
          status: res.status,
        });
      }
      return ok(await res.text());
    } catch (e) {
      return fail({ code: 'http_error', message: `Speedy page: ${(e as Error).message}` });
    }
  }

  async listOffices(): Promise<CourierResult<OfficeList>> {
    const listPage = await this.getPage(SPEEDY_LIST_URL);
    if (!listPage.ok) return listPage;
    const list = parseSpeedyOfficeList(listPage.value);
    if (!list.ok) {
      return fail({
        code: 'parse_failed',
        message: `Speedy office list could not be read (${list.reason}, ${list.found} entries)`,
      });
    }

    // One map page carries every office's coordinates. If it fails, the list is still synced:
    // stored coordinates stay, new offices are geocoded later.
    const warnings: string[] = [];
    let coordinates = null;
    const mapPage = await this.getPage(speedyMapUrl(list.entries[0]!.id));
    if (mapPage.ok) {
      const map = parseSpeedyMapData(mapPage.value);
      if (map.ok) coordinates = map.points;
      else warnings.push(`map page without coordinates (${map.reason})`);
    } else {
      warnings.push(`map page failed (${mapPage.error.message})`);
    }

    const merged = mergeSpeedy(list.entries, coordinates);
    if (merged.withoutCoordinates) {
      warnings.push(`${merged.withoutCoordinates} offices without coordinates on the map page`);
    }
    if (list.problems.length) warnings.push(`${list.problems.length} list entries skipped`);
    return ok({
      points: merged.points,
      source: 'speedy_public_list',
      skipped: list.problems.length,
      warnings,
    });
  }

  /** Approximate price from the tariff table (no COD fee yet: Phase 7 adds the price rules). */
  async calculate(request: QuoteRequest): Promise<CourierResult<Quote>> {
    const kind = request.destination.kind;
    const band = await this.options.findTariff(kind, request.weightG);
    if (!band) {
      return fail({
        code: 'no_tariff',
        message: `No Speedy tariff for ${kind} / ${request.weightG} g`,
      });
    }
    const overKg = Math.max(0, Math.ceil((request.weightG - band.max_weight_g) / 1000));
    const extra = overKg * (band.extra_per_kg_cents ?? 0);
    const lines = [{ label: `≤ ${band.max_weight_g} g`, cents: band.price_cents }];
    if (extra) lines.push({ label: `+${overKg} kg`, cents: extra });
    return ok({
      totalCents: band.price_cents + extra,
      currency: 'EUR',
      lines,
      approximate: true,
      source: band.source,
    });
  }

  resolveSite() {
    return Promise.resolve(notSupportedInManualMode<never>('resolveSite'));
  }
  validateShipment() {
    return Promise.resolve(notSupportedInManualMode<never>('validateShipment'));
  }
  createShipment() {
    return Promise.resolve(notSupportedInManualMode<never>('createShipment'));
  }
  updateShipment() {
    return Promise.resolve(notSupportedInManualMode<never>('updateShipment'));
  }
  cancelShipment() {
    return Promise.resolve(notSupportedInManualMode<never>('cancelShipment'));
  }
  printLabel() {
    return Promise.resolve(notSupportedInManualMode<never>('printLabel'));
  }
  track() {
    return Promise.resolve(notSupportedInManualMode<never>('track'));
  }
  codPayments() {
    return Promise.resolve(notSupportedInManualMode<never>('codPayments'));
  }
}
