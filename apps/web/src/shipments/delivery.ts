/**
 * Delivery (Phase 5): what the detection decided for a shipment, the phone call tools (owner and
 * packers), address corrections, and starting the detection (detect-delivery Edge Function).
 */
import { formatKm, type ScriptDecision } from '@happyhome/core/detect';
import { supabase, supabasePublishableKey, supabaseUrl } from '../lib/supabase';
import type { ShipmentRow } from './data';

export type Certainty = 'certain' | 'uncertain' | 'error';
export type CallOutcome = 'confirmed' | 'other_point' | 'home_address' | 'no_answer' | 'refused';

/** An office / locker as stored in delivery_suggestion / delivery_alternatives. */
export interface StoredPoint {
  id: string;
  carrier: 'econt' | 'speedy';
  type: 'office' | 'locker' | 'mobile';
  name_bg: string;
  address_text: string | null;
  distance_km: number | null;
}

export interface StoredReason {
  code: string;
  bg: string;
  en: string;
}

const list = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);
const isPoint = (v: unknown): v is StoredPoint =>
  !!v && typeof v === 'object' && typeof (v as StoredPoint).id === 'string';

export const suggestionOf = (s: ShipmentRow): StoredPoint | null =>
  isPoint(s.delivery_suggestion) ? s.delivery_suggestion : null;
export const alternativesOf = (s: ShipmentRow): StoredPoint[] =>
  list<unknown>(s.delivery_alternatives).filter(isPoint);
export const deliveryReasonsOf = (s: ShipmentRow): StoredReason[] =>
  list<StoredReason>(s.delivery_reasons);
export const deliveryHintsOf = (s: ShipmentRow): StoredReason[] =>
  list<StoredReason>(s.delivery_hints);

/** "Пловдив Тест (0,8 км)": the name without the carrier (the badge shows it). */
export function pointName(
  p: { name_bg: string; distance_km?: number | null },
  lang: 'bg' | 'en',
  withDistance = true,
): string {
  const km = withDistance && p.distance_km != null ? ` (${formatKm(p.distance_km, lang)})` : '';
  return `${p.name_bg}${km}`;
}

/** null = the detection has not run yet for the current address. */
export function certaintyOf(s: ShipmentRow): Certainty | null {
  if (s.delivery_dirty && s.delivery_rule !== 'manual') return null;
  const c = s.delivery_certainty;
  return c === 'certain' || c === 'uncertain' || c === 'error' ? c : null;
}

/** A call makes sense while the shipment is open and the destination is not sure. */
export function needsCall(s: ShipmentRow): boolean {
  const c = certaintyOf(s);
  return (
    (c === 'uncertain' || c === 'error') && ['imported', 'needs_check', 'ready'].includes(s.status)
  );
}

export const isManualDelivery = (s: ShipmentRow): boolean => {
  const o = (s.manual_overrides ?? {}) as Record<string, unknown>;
  return !!o.delivery;
};

/** The stored decision in the shape the call script reads. */
export function scriptDecisionOf(s: ShipmentRow): ScriptDecision | null {
  const rule = s.delivery_rule;
  if (!rule || !['A', 'B', 'C', 'D', 'E', 'F'].includes(rule)) return null;
  const carrier = s.carrier === 'econt' || s.carrier === 'speedy' ? s.carrier : null;
  const type = s.delivery_type;
  const sug = suggestionOf(s);
  return {
    rule: rule as ScriptDecision['rule'],
    carrier,
    deliveryType: type === 'office' || type === 'locker' || type === 'address' ? type : null,
    reasons: deliveryReasonsOf(s),
    suggestion: sug,
  };
}

export type DeliveryError =
  | 'version_conflict'
  | 'shipment_locked'
  | 'reason_required'
  | 'unknown_point'
  | 'nothing_to_confirm'
  | 'owner_only'
  | 'other';

function deliveryError(error: { code?: string; message?: string } | null): DeliveryError | null {
  if (!error) return null;
  const m = error.message ?? '';
  if (error.code === 'PT409' || /version_conflict/.test(m)) return 'version_conflict';
  if (error.code === '55000') return 'shipment_locked';
  if (/reason_required/.test(m)) return 'reason_required';
  if (/unknown_point/.test(m)) return 'unknown_point';
  if (/nothing_to_confirm/.test(m)) return 'nothing_to_confirm';
  if (error.code === '42501') return 'owner_only';
  return 'other';
}

export async function recordCall(
  s: ShipmentRow,
  outcome: CallOutcome,
  options: { pointId?: string | null; note?: string } = {},
): Promise<DeliveryError | null> {
  const { error } = await supabase.rpc('delivery_call_outcome', {
    p_shipment_id: s.id,
    p_outcome: outcome,
    p_version: s.version,
    ...(options.pointId ? { p_point_id: options.pointId } : {}),
    ...(options.note ? { p_note: options.note } : {}),
  });
  return deliveryError(error);
}

export interface AddressFields {
  address1: string;
  address2: string;
  city: string;
  zip: string;
}

export async function updateAddress(
  s: ShipmentRow,
  fields: AddressFields,
): Promise<{ version: number } | { error: DeliveryError }> {
  const { data, error } = await supabase.rpc('shipment_update_address', {
    p_shipment_id: s.id,
    p_address1: fields.address1,
    p_address2: fields.address2,
    p_city: fields.city,
    p_zip: fields.zip,
    p_version: s.version,
  });
  const failed = deliveryError(error);
  return failed ? { error: failed } : { version: data!.version };
}

export async function resetDelivery(id: string): Promise<DeliveryError | null> {
  const { error } = await supabase.rpc('delivery_reset', { p_shipment_id: id });
  return deliveryError(error);
}

async function callDetect(body: object): Promise<boolean> {
  const { data: session } = await supabase.auth.getSession();
  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/detect-delivery`, {
      method: 'POST',
      headers: {
        apikey: supabasePublishableKey,
        Authorization: `Bearer ${session.session?.access_token ?? ''}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** After an import: detect every new or changed shipment (in the background, P5-01). */
export const startDetection = (): Promise<boolean> => callDetect({ action: 'pending' });

/** After an address edit: detect these shipments now (the page follows the result live). */
export const detectNow = (ids: string[]): Promise<boolean> =>
  callDetect({ action: 'ids', shipment_ids: ids });

export interface CallRow {
  id: string;
  outcome: CallOutcome;
  note: string | null;
  created_at: string;
  by: string | null;
}

export async function loadCalls(shipmentId: string): Promise<CallRow[]> {
  const { data, error } = await supabase
    .from('shipment_calls')
    .select('id, outcome, note, created_at, called_by')
    .eq('shipment_id', shipmentId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  const ids = [...new Set((data ?? []).flatMap((c) => (c.called_by ? [c.called_by] : [])))];
  const names = new Map<string, string>();
  if (ids.length) {
    const { data: people } = await supabase
      .from('members')
      .select('user_id, display_name')
      .in('user_id', ids);
    for (const p of people ?? []) names.set(p.user_id, p.display_name);
  }
  return (data ?? []).map((c) => ({
    id: c.id,
    outcome: c.outcome as CallOutcome,
    note: c.note,
    created_at: c.created_at,
    by: c.called_by ? (names.get(c.called_by) ?? null) : null,
  }));
}
