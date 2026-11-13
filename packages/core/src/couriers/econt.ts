/**
 * Econt JSON API: pure request builders and response mappers (no I/O). The EcontApiAdapter in
 * supabase/functions/_shared/couriers/ does the HTTP calls with these.
 *
 * Types come from Econt's OpenAPI spec (econt-openapi.ts, `pnpm econt:types`). Where the live
 * API differs from the spec, the live response wins (brief section 8), e.g. the business hours
 * are epoch milliseconds, not "HH:MM" strings (docs/STATUS.md).
 */
import type { CourierSite, Quote, QuoteRequest } from './adapter.ts';
import type { components } from './econt-openapi.ts';
import {
  cleanCoordinates,
  type CourierPoint,
  type OpeningSpan,
  type WorkingHours,
} from './points.ts';

type Schemas = components['schemas'];
export type EcontAddress = Schemas['Address'];
export type EcontCity = Schemas['City'];
export type EcontStreet = Schemas['Street'];
export type EcontQuarter = Schemas['Quarter'];
export type EcontShippingLabel = Schemas['ShippingLabel'];

type HoursField =
  | 'normalBusinessHoursFrom'
  | 'normalBusinessHoursTo'
  | 'halfDayBusinessHoursFrom'
  | 'halfDayBusinessHoursTo';

/** An office as the live API returns it: the hours are epoch ms (the spec says "time"). */
export type EcontOffice = Omit<Schemas['Office'], HoursField> &
  Partial<Record<HoursField, string | number | null>>;

export const ECONT_URLS = {
  demo: 'https://demo.econt.com/ee/services/',
  production: 'https://ee.econt.com/services/',
} as const;
export type EcontEnv = keyof typeof ECONT_URLS;

/**
 * Econt's own published test account for the demo environment (ee.econt.com/services,
 * "For the test system … you can use the following credentials"). Public, not a secret.
 * The production login is only ever read from the Supabase secrets ECONT_USERNAME / ECONT_PASSWORD.
 */
export const ECONT_DEMO_LOGIN = { username: 'iasp-dev', password: '1Asp-dev' } as const;

export const ECONT_PATHS = {
  offices: 'Nomenclatures/NomenclaturesService.getOffices.json',
  cities: 'Nomenclatures/NomenclaturesService.getCities.json',
  streets: 'Nomenclatures/NomenclaturesService.getStreets.json',
  quarters: 'Nomenclatures/NomenclaturesService.getQuarters.json',
  createLabel: 'Shipments/LabelService.createLabel.json',
} as const;

const SOFIA_TIME = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Sofia',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** "09:30" from epoch ms (Sofia time) or from "09:30" / "09:30:00". */
export function econtTime(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return SOFIA_TIME.format(new Date(value));
  }
  const m = /^(\d{1,2}):(\d{2})/.exec(value.trim());
  return m ? `${m[1]!.padStart(2, '0')}:${m[2]}` : null;
}

function span(from: string | number | null | undefined, to: string | number | null | undefined) {
  const f = econtTime(from);
  const t = econtTime(to);
  return f && t && f !== t ? ({ from: f, to: t } satisfies OpeningSpan) : null;
}

/** Econt gives "normal" (Mon–Fri) and "half day" (Saturday) hours; Sunday is not given. */
export function econtWorkingHours(o: EcontOffice): WorkingHours | null {
  const weekdays = span(o.normalBusinessHoursFrom, o.normalBusinessHoursTo);
  const saturday = span(o.halfDayBusinessHoursFrom, o.halfDayBusinessHoursTo);
  if (!weekdays && !saturday) return null;
  return { weekdays, saturday };
}

/** One Econt office → CourierPoint. null when it is not in Bulgaria or has no code. */
export function mapEcontOffice(o: EcontOffice): CourierPoint | null {
  const address = o.address ?? {};
  const city = address.city ?? {};
  if (city.country?.code3 && city.country.code3 !== 'BGR') return null;
  const code = (o.code ?? '').trim();
  const name = (o.name ?? '').trim();
  if (!code || !name) return null;
  const coords = cleanCoordinates(address.location?.latitude, address.location?.longitude);
  return {
    carrier: 'econt',
    externalId: code,
    code,
    type: o.isAPS ? 'locker' : o.isMPS ? 'mobile' : 'office',
    nameBg: name,
    nameEn: o.nameEn?.trim() || null,
    city: city.name?.trim() || null,
    postcode: (address.zip || city.postCode || '').trim() || null,
    addressText: (address.fullAddress ?? '').replace(/\s+/g, ' ').trim() || null,
    lat: coords?.lat ?? null,
    lng: coords?.lng ?? null,
    coordConfidence: coords ? (address.location?.confidence ?? null) : null,
    coordSource: coords ? 'courier' : null,
    workingHours: econtWorkingHours(o),
    phone: (o.phones ?? []).filter(Boolean).join(', ') || null,
    raw: {
      id: o.id ?? null,
      city_id: city.id ?? null,
      city_name_en: city.nameEn ?? null,
      quarter: address.quarter ?? null,
      street: address.street ?? null,
      num: address.num ?? null,
      other: address.other || null,
      full_address_en: address.fullAddressEn?.trim() || null,
      shipment_types: o.shipmentTypes ?? [],
      hub_code: o.hubCode ?? null,
      is_drive: o.isDrive ?? false,
      partner_code: o.partnerCode || null,
    },
  };
}

export interface MappedEcontOffices {
  points: CourierPoint[];
  skipped: number;
  withoutCoordinates: number;
}

/** The getOffices response → points. Throws when the response is not an office list. */
export function mapEcontOffices(json: unknown): MappedEcontOffices {
  const offices = (json as { offices?: unknown } | null)?.offices;
  if (!Array.isArray(offices)) throw new Error('getOffices: no "offices" array');
  const points: CourierPoint[] = [];
  let skipped = 0;
  const seen = new Set<string>();
  for (const o of offices as EcontOffice[]) {
    const p = mapEcontOffice(o);
    if (!p || seen.has(p.externalId)) {
      skipped++;
      continue;
    }
    seen.add(p.externalId);
    points.push(p);
  }
  return { points, skipped, withoutCoordinates: points.filter((p) => p.lat === null).length };
}

export function mapEcontCity(c: EcontCity): CourierSite | null {
  if (c.id === undefined || !c.name) return null;
  return {
    externalId: String(c.id),
    name: c.name,
    nameEn: c.nameEn ?? null,
    postcode: c.postCode ?? null,
    region: c.regionName ?? null,
  };
}

/** Econt's error body: { type, message, innerErrors: [...] }. */
export function econtErrorMessage(json: unknown): string | null {
  if (!json || typeof json !== 'object') return null;
  const e = json as { type?: unknown; message?: unknown; innerErrors?: unknown };
  if (typeof e.message !== 'string' || !e.message) return null;
  const inner = Array.isArray(e.innerErrors)
    ? e.innerErrors
        .map((i) => (i && typeof i === 'object' ? (i as { message?: unknown }).message : null))
        .filter((m): m is string => typeof m === 'string' && m !== '')
    : [];
  return [e.message, ...inner].join(' | ');
}

const euros = (cents: number): number => Math.round(cents) / 100;
const cents = (euro: unknown): number => Math.round(Number(euro ?? 0) * 100);

/**
 * createLabel body for a PRICE CALCULATION (mode "calculate"): Econt returns the price and
 * creates nothing. The sender/receiver names are placeholders; prices do not depend on them.
 */
export function econtCalculateRequest(req: QuoteRequest): {
  label: EcontShippingLabel;
  mode: 'calculate';
} {
  const d = req.destination;
  const label: EcontShippingLabel = {
    senderClient: { name: 'HappyHome', phones: ['0000000000'] },
    senderOfficeCode: req.senderOfficeCode,
    receiverClient: { name: 'Получател', phones: ['0000000000'] },
    packCount: Math.max(1, req.packCount),
    shipmentType: 'pack',
    weight: Math.max(0.1, req.weightG / 1000),
    shipmentDescription: 'стока',
    paymentReceiverMethod: req.payer === 'RECIPIENT' ? 'cash' : undefined,
    paymentSenderMethod: req.payer === 'SENDER' ? 'cash' : undefined,
    services: {
      ...(req.codCents > 0
        ? { cdAmount: euros(req.codCents), cdType: 'get', cdCurrency: 'EUR' }
        : {}),
      ...(req.declaredValueCents > 0
        ? {
            declaredValueAmount: euros(req.declaredValueCents),
            declaredValueCurrency: 'EUR',
          }
        : {}),
    },
  };
  if (d.kind === 'address') {
    label.receiverAddress = {
      city: { name: d.city, postCode: d.postcode ?? undefined, country: { code3: 'BGR' } },
      street: d.street ?? undefined,
      num: d.number ?? undefined,
      quarter: d.quarter ?? undefined,
      other: d.other ?? undefined,
    };
  } else {
    label.receiverOfficeCode = d.officeCode;
  }
  return { label, mode: 'calculate' };
}

/** createLabel (mode calculate) response → Quote. Throws when there is no price in it. */
export function parseEcontQuote(json: unknown): Quote {
  const label = (json as { label?: Record<string, unknown> } | null)?.label;
  if (!label || label.totalPrice === undefined || label.totalPrice === null) {
    throw new Error('createLabel/calculate: no totalPrice');
  }
  const currency = String(label.currency ?? 'EUR');
  if (currency !== 'EUR') throw new Error(`createLabel/calculate: currency ${currency}`);
  const services = Array.isArray(label.services) ? label.services : [];
  return {
    totalCents: cents(label.totalPrice),
    currency: 'EUR',
    lines: services.map((s: Record<string, unknown>) => ({
      label: String(s.description ?? s.type ?? ''),
      cents: cents(s.price),
    })),
    approximate: false,
    source: 'econt_api',
  };
}
