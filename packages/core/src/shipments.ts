/**
 * Shipment helpers shared by the screens (Phase 3). The rules that build shipments
 * run in the database, in the import transaction (private.build_shipments).
 */
import type { ShipmentStatus } from './domain';

/** "Before waybill_created": orders can still be split out or merged in. */
export const OPEN_STATUSES = [
  'imported',
  'needs_check',
  'ready',
  'waiting_manual_waybill',
] as const satisfies readonly ShipmentStatus[];

export function isOpenStatus(status: string | null | undefined): boolean {
  return (OPEN_STATUSES as readonly string[]).includes(status ?? '');
}

/**
 * Packers never see shipments that still need the owner's check (P3-15), nor ones the
 * import has not finished yet.
 */
export function visibleToPacker(status: string | null | undefined): boolean {
  return status !== 'needs_check' && status !== 'imported';
}

/** Why several orders travel together, as stored in shipments.combined_by. */
export const COMBINED_BY = ['phone', 'email', 'manual'] as const;
export type CombinedBy = (typeof COMBINED_BY)[number];

export function combinedReasons(value: readonly string[] | null | undefined): CombinedBy[] {
  return COMBINED_BY.filter((c) => (value ?? []).includes(c));
}

/**
 * tel: link in the normalized +359 form (brief section 7). Input: the normalized match
 * key (0XXXXXXXXX for Bulgarian numbers). Foreign numbers keep their own "+".
 */
export function telHref(phoneNorm: string | null | undefined): string | null {
  const p = (phoneNorm ?? '').replace(/[^\d+]/g, '');
  if (!p) return null;
  if (/^0\d{8,9}$/.test(p)) return `tel:+359${p.slice(1)}`;
  if (p.startsWith('+')) return `tel:${p}`;
  return `tel:${p}`;
}

/** "+359 888 000 102" for a normalized Bulgarian number, else the value as stored. */
export function displayPhone(phoneNorm: string | null | undefined): string {
  const p = phoneNorm ?? '';
  const m = /^0(\d{2,3})(\d{3})(\d{3,4})$/.exec(p);
  return m ? `+359 ${m[1]} ${m[2]} ${m[3]}` : p;
}

/** Order for the list: what needs the owner first, then the oldest orders first. */
const STATUS_RANK: Record<string, number> = {
  needs_check: 0,
  imported: 1,
  ready: 2,
  waiting_manual_waybill: 3,
};

export function compareShipments(
  a: { status: string | null; first_order_at: string | null; reference: string | null },
  b: { status: string | null; first_order_at: string | null; reference: string | null },
): number {
  const ra = STATUS_RANK[a.status ?? ''] ?? 9;
  const rb = STATUS_RANK[b.status ?? ''] ?? 9;
  if (ra !== rb) return ra - rb;
  const ta = a.first_order_at ? Date.parse(a.first_order_at) : Infinity;
  const tb = b.first_order_at ? Date.parse(b.first_order_at) : Infinity;
  if (ta !== tb) return ta - tb;
  return (a.reference ?? '').localeCompare(b.reference ?? '');
}
