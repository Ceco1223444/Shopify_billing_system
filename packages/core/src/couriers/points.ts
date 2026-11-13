/**
 * A courier office / locker / mobile post station as the app stores it (table courier_offices).
 * Both couriers' data is mapped to this shape before it is synced (P4-14).
 */
import type { SupportedCarrier } from '../domain.ts';
import { isInBulgaria } from '../geo/distance.ts';

/** Must match the CHECK on courier_offices.type (an integration test compares them). */
export const POINT_TYPES = ['office', 'locker', 'mobile'] as const;
export type PointType = (typeof POINT_TYPES)[number];

/** Where a point's coordinates came from. */
export const COORD_SOURCES = ['courier', 'speedy_map', 'nominatim'] as const;
export type CoordSource = (typeof COORD_SOURCES)[number];

/** "09:00"–"18:00" in Sofia local time. */
export interface OpeningSpan {
  from: string;
  to: string;
}

/**
 * Opening hours. null = closed that day; a missing key = the courier does not say
 * (Econt gives weekdays and Saturday only).
 */
export interface WorkingHours {
  weekdays?: OpeningSpan | null;
  saturday?: OpeningSpan | null;
  sunday?: OpeningSpan | null;
}

export interface CourierPoint {
  carrier: SupportedCarrier;
  /** Econt office code / Speedy office ID: what a waybill needs. Unique per carrier. */
  externalId: string;
  code: string | null;
  type: PointType;
  nameBg: string;
  nameEn: string | null;
  city: string | null;
  postcode: string | null;
  addressText: string | null;
  lat: number | null;
  lng: number | null;
  /** 0–3: 3 = from the courier, 2 = geocoded street, 1 = quarter, 0 = city only. */
  coordConfidence: number | null;
  coordSource: CoordSource | null;
  workingHours: WorkingHours | null;
  phone: string | null;
  /** Extra source fields kept for later phases (ids, hub, services). Not used for change checks. */
  raw: Record<string, unknown>;
}

/** Problems that make a point unusable (empty list = fine). */
export function pointProblems(p: CourierPoint): string[] {
  const problems: string[] = [];
  if (!p.externalId.trim()) problems.push('missing_id');
  if (!p.nameBg.trim()) problems.push('missing_name');
  if (!(POINT_TYPES as readonly string[]).includes(p.type)) problems.push('bad_type');
  if ((p.lat === null) !== (p.lng === null)) problems.push('half_coordinates');
  if (p.lat !== null && p.lng !== null && !isInBulgaria({ lat: p.lat, lng: p.lng })) {
    problems.push('outside_bulgaria');
  }
  return problems;
}

/**
 * Coordinates as the courier sent them, or null when they are missing, zero or outside
 * Bulgaria (some demo offices have 0,0).
 */
export function cleanCoordinates(lat: unknown, lng: unknown): { lat: number; lng: number } | null {
  const la = typeof lat === 'number' ? lat : Number(lat);
  const ln = typeof lng === 'number' ? lng : Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln) || (la === 0 && ln === 0)) return null;
  return isInBulgaria({ lat: la, lng: ln }) ? { lat: la, lng: ln } : null;
}

/** The database row form (snake_case jsonb) that the sync RPCs take. */
export function pointToRow(p: CourierPoint): Record<string, unknown> {
  return {
    carrier: p.carrier,
    external_id: p.externalId,
    code: p.code,
    type: p.type,
    name_bg: p.nameBg,
    name_en: p.nameEn,
    city: p.city,
    postcode: p.postcode,
    address_text: p.addressText,
    lat: p.lat,
    lng: p.lng,
    coord_confidence: p.coordConfidence,
    coord_source: p.coordSource,
    working_hours: p.workingHours,
    phone: p.phone,
    raw: p.raw,
  };
}
