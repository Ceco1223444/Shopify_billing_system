/**
 * One interface for every courier (P4-01, brief section 4). The rest of the app never asks
 * which courier or which mode it talks to: it asks the adapter what it can do (capabilities())
 * and shows the manual flow when a method is not supported.
 *
 * Implementations live in the Edge Functions (supabase/functions/_shared/couriers/):
 *   EcontApiAdapter       (api mode)
 *   SpeedyManualAdapter   (manual mode: offices from the public list, prices from the tariff table)
 *   MockAdapter           (tests; ./mock.ts)
 *
 * Methods never throw for courier problems: they return { ok: false, error }.
 */
import type { CourierMode, DeliveryType, SupportedCarrier } from '../domain.ts';
import type { CourierPoint } from './points.ts';

export const COURIER_METHODS = [
  'listOffices',
  'resolveSite',
  'calculate',
  'validateShipment',
  'createShipment',
  'updateShipment',
  'cancelShipment',
  'printLabel',
  'track',
  'codPayments',
] as const;
export type CourierMethod = (typeof COURIER_METHODS)[number];

export type CourierErrorCode =
  /** The courier is in manual mode: the owner does this by hand (MySpeedy). */
  | 'not_supported_in_manual_mode'
  /** Part of the adapter, built in a later phase (the error says which). */
  | 'not_available_yet'
  /** No adapter for this courier + mode (e.g. Speedy "api" before Phase 13). */
  | 'mode_not_available'
  | 'credentials_missing'
  | 'http_error'
  | 'bad_response'
  | 'parse_failed'
  | 'courier_error'
  | 'no_tariff';

export interface CourierError {
  code: CourierErrorCode;
  /** English, for logs and developers. The app shows its own Bulgarian text for each code. */
  message: string;
  status?: number;
  /** Phase that adds the method (not_available_yet). */
  phase?: number;
  details?: unknown;
}

export type CourierResult<T> = { ok: true; value: T } | { ok: false; error: CourierError };

export const ok = <T>(value: T): CourierResult<T> => ({ ok: true, value });
export const fail = <T = never>(error: CourierError): CourierResult<T> => ({ ok: false, error });

export function notSupportedInManualMode<T = never>(method: CourierMethod): CourierResult<T> {
  return fail({
    code: 'not_supported_in_manual_mode',
    message: `${method} is not supported in manual mode`,
  });
}

export function notAvailableYet<T = never>(method: CourierMethod, phase: number): CourierResult<T> {
  return fail({ code: 'not_available_yet', message: `${method} comes in Phase ${phase}`, phase });
}

// --- Inputs and results ---------------------------------------------------------------------

export interface OfficeList {
  points: CourierPoint[];
  /** e.g. "econt_api:production", "speedy_public_list" */
  source: string;
  /** Problems that did not stop the sync (e.g. "12 offices without coordinates"). */
  warnings: string[];
  /** Source entries that were left out, with the reason (not BG, missing code…). */
  skipped: number;
}

export interface SiteQuery {
  /** City or village name, Cyrillic or Latin. */
  name?: string | null;
  postcode?: string | null;
}

/** A settlement as the courier knows it (Econt city ID, Speedy site ID). */
export interface CourierSite {
  externalId: string;
  name: string;
  nameEn: string | null;
  postcode: string | null;
  region: string | null;
}

/** Where a parcel goes: a courier point (office / locker) or a home address. */
export type Destination =
  | { kind: 'office' | 'locker'; officeCode: string }
  | {
      kind: 'address';
      city: string;
      postcode: string | null;
      street: string | null;
      number: string | null;
      quarter: string | null;
      other: string | null;
    };

export interface QuoteRequest {
  /** The shop's drop-off office (settings.sender_offices). */
  senderOfficeCode: string;
  destination: Destination;
  weightG: number;
  /** Cash on delivery in euro cents, 0 = none. */
  codCents: number;
  /** Declared value in euro cents, 0 = none. */
  declaredValueCents: number;
  payer: 'SENDER' | 'RECIPIENT';
  packCount: number;
}

export interface QuoteLine {
  label: string;
  cents: number;
}

export interface Quote {
  totalCents: number;
  currency: 'EUR';
  lines: QuoteLine[];
  /** true = from the seeded tariff table ("ориентировъчна цена"), false = the courier's API. */
  approximate: boolean;
  source: string;
}

/** A waybill request. Phase 9 fills in the details. */
export interface ShipmentDraft extends QuoteRequest {
  shipmentId: string;
  receiverName: string;
  receiverPhone: string;
  contents: string;
  reference: string;
  deliveryType: DeliveryType;
}

export interface ShipmentValidation {
  valid: boolean;
  problems: string[];
}

export interface WaybillRef {
  waybillNumber: string;
}

export interface CreatedWaybill extends WaybillRef {
  labelUrl: string | null;
  priceCents: number | null;
}

export interface LabelFile {
  contentType: string;
  bytes: Uint8Array;
}

export interface TrackingEvent {
  at: string;
  status: string;
  description: string;
}

export interface TrackingResult extends WaybillRef {
  events: TrackingEvent[];
  delivered: boolean;
  returned: boolean;
}

export interface CodPayment extends WaybillRef {
  amountCents: number;
  paidAt: string;
}

export interface CourierAdapter {
  readonly carrier: SupportedCarrier;
  readonly mode: CourierMode | 'mock';
  /** What this adapter can do. The UI shows the manual flow for everything else. */
  capabilities(): readonly CourierMethod[];
  listOffices(): Promise<CourierResult<OfficeList>>;
  resolveSite(query: SiteQuery): Promise<CourierResult<CourierSite[]>>;
  calculate(request: QuoteRequest): Promise<CourierResult<Quote>>;
  validateShipment(draft: ShipmentDraft): Promise<CourierResult<ShipmentValidation>>;
  createShipment(draft: ShipmentDraft): Promise<CourierResult<CreatedWaybill>>;
  updateShipment(ref: WaybillRef, draft: ShipmentDraft): Promise<CourierResult<CreatedWaybill>>;
  cancelShipment(ref: WaybillRef): Promise<CourierResult<{ cancelled: boolean }>>;
  printLabel(ref: WaybillRef, paper: 'A6' | 'A4' | 'A4_4xA6'): Promise<CourierResult<LabelFile>>;
  track(refs: WaybillRef[]): Promise<CourierResult<TrackingResult[]>>;
  codPayments(range: { from: string; to: string }): Promise<CourierResult<CodPayment[]>>;
}

/** Capability check that reads well at call sites: if (can(adapter, 'createShipment')) … */
export function can(adapter: Pick<CourierAdapter, 'capabilities'>, method: CourierMethod): boolean {
  return adapter.capabilities().includes(method);
}
