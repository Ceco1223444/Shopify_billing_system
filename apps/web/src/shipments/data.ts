/**
 * Shipments (Phase 3): loading the Пратки list and one shipment, live updates, and the
 * owner's split / merge / keep-apart actions (database RPCs that check the role again).
 */
import type { Tables } from '@happyhome/core';
import { useEffect, useRef } from 'react';
import { openPrivateChannel } from '../lib/realtime';
import { supabase } from '../lib/supabase';

export type ShipmentRow = Tables<'shipment_overview'>;
export type FlagRow = Tables<'flags'>;

export interface OrderRef {
  id: string;
  name: string;
  created_at_shopify: string | null;
}

export interface CodPart {
  order_id: string;
  order: string;
  cod: boolean;
  amount_cents: number;
  source: 'outstanding' | 'total' | 'missing' | 'prepaid';
}

export interface ContentLine {
  order: string;
  sku: string | null;
  name: string;
  quantity: number | null;
}

export interface DecisionReason {
  code: string;
  bg: string;
  en: string;
}

/** jsonb arrays written by the database functions (shape documented in the migration). */
const list = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);
export const ordersOf = (s: ShipmentRow): OrderRef[] => list<OrderRef>(s.orders);
export const codOf = (s: ShipmentRow): CodPart[] => list<CodPart>(s.cod_breakdown);
export const contentsOf = (s: ShipmentRow): ContentLine[] => list<ContentLine>(s.contents);
export const reasonsOf = (s: ShipmentRow): DecisionReason[] =>
  list<DecisionReason>(s.decision_reasons);

export async function loadShipments(): Promise<ShipmentRow[]> {
  const out: ShipmentRow[] = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    const { data, error } = await supabase
      .from('shipment_overview')
      .select('*')
      .order('first_order_at', { ascending: true, nullsFirst: false })
      .range(from, from + page - 1);
    if (error) throw error;
    out.push(...(data ?? []));
    if (!data || data.length < page) return out;
  }
}

export interface OrderDetail {
  id: string;
  name: string;
  created_at_shopify: string | null;
  payment_method: string | null;
  total_cents: number | null;
  shipping_name: string | null;
  phone_raw: string | null;
  email: string | null;
  notes: string | null;
}

export interface LoadedShipment {
  shipment: ShipmentRow;
  orders: OrderDetail[];
  flags: FlagRow[];
  /** order id -> the shipment it is in now (for links in the flags) */
  shipmentOfOrder: Map<string, string>;
}

/** order ids mentioned in a flag's details (related orders, the two duplicate orders). */
function orderIdsIn(flag: FlagRow): string[] {
  const d = (flag.details ?? {}) as {
    related?: { order_id?: string }[];
    orders?: { order_id?: string }[];
  };
  return [...(d.related ?? []), ...(d.orders ?? [])].flatMap((r) =>
    r.order_id ? [r.order_id] : [],
  );
}

export async function loadShipment(id: string): Promise<LoadedShipment | null> {
  const { data: shipment, error } = await supabase
    .from('shipment_overview')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!shipment) return null;
  const orderIds = ordersOf(shipment).map((o) => o.id);

  const [orders, flags] = await Promise.all([
    orderIds.length
      ? supabase
          .from('orders')
          .select(
            'id, name, created_at_shopify, payment_method, total_cents, shipping_name, phone_raw, email, notes',
          )
          .in('id', orderIds)
      : Promise.resolve({ data: [] as OrderDetail[], error: null }),
    supabase
      .from('flags')
      .select('*')
      .or(
        [
          `shipment_id.eq.${id}`,
          ...(orderIds.length ? [`order_id.in.(${orderIds.join(',')})`] : []),
        ].join(','),
      )
      .order('created_at'),
  ]);
  if (orders.error) throw orders.error;
  if (flags.error) throw flags.error;

  const mentioned = [...new Set((flags.data ?? []).flatMap(orderIdsIn))];
  const shipmentOfOrder = new Map<string, string>();
  if (mentioned.length) {
    const { data: links } = await supabase
      .from('shipment_orders')
      .select('order_id, shipment_id')
      .in('order_id', mentioned);
    for (const l of links ?? []) shipmentOfOrder.set(l.order_id, l.shipment_id);
  }

  const byId = new Map((orders.data ?? []).map((o) => [o.id, o as OrderDetail]));
  return {
    shipment,
    orders: orderIds.flatMap((oid) => (byId.has(oid) ? [byId.get(oid)!] : [])),
    flags: flags.data ?? [],
    shipmentOfOrder,
  };
}

/** Calls onChange (debounced) whenever a shipment or a flag changes anywhere. */
export function useShipmentChanges(topic: string, onChange: () => void): void {
  const latest = useRef(onChange);
  useEffect(() => {
    latest.current = onChange;
  });
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poke = () => {
      clearTimeout(timer);
      timer = setTimeout(() => latest.current(), 400);
    };
    const close = openPrivateChannel(supabase, `shop:${topic}`, {
      setup: (channel) => {
        channel
          .on('postgres_changes', { event: '*', schema: 'public', table: 'shipments' }, poke)
          .on('postgres_changes', { event: '*', schema: 'public', table: 'flags' }, poke);
      },
    });
    return () => {
      clearTimeout(timer);
      close();
    };
  }, [topic]);
}

export type ActionError =
  'owner_only' | 'shipment_locked' | 'version_conflict' | 'single_order' | 'other';

function actionError(error: { code?: string; message?: string } | null): ActionError | null {
  if (!error) return null;
  if (error.code === '42501') return 'owner_only';
  if (error.code === '55000') return 'shipment_locked';
  if (error.code === 'PT409' || /version_conflict/.test(error.message ?? ''))
    return 'version_conflict';
  if (/single_order/.test(error.message ?? '')) return 'single_order';
  return 'other';
}

export async function splitOrder(
  orderId: string,
  shipmentVersion: number | null,
): Promise<{ newId: string } | { error: ActionError }> {
  const { data, error } = await supabase.rpc('shipment_split', {
    p_order_id: orderId,
    ...(shipmentVersion != null ? { p_shipment_version: shipmentVersion } : {}),
  });
  const failed = actionError(error);
  return failed ? { error: failed } : { newId: data! };
}

export async function mergeShipments(
  target: ShipmentRow,
  source: ShipmentRow,
): Promise<{ id: string } | { error: ActionError }> {
  const { data, error } = await supabase.rpc('shipment_merge', {
    p_target: target.id!,
    p_source: source.id!,
    ...(target.version != null ? { p_target_version: target.version } : {}),
    ...(source.version != null ? { p_source_version: source.version } : {}),
  });
  const failed = actionError(error);
  return failed ? { error: failed } : { id: data! };
}

export async function keepApart(a: string, b: string): Promise<ActionError | null> {
  const { error } = await supabase.rpc('shipment_keep_apart', { p_shipment_a: a, p_shipment_b: b });
  return actionError(error);
}

/** The earlier of two shipments (by their earliest order) is the one the other joins. */
export function mergeTarget(a: ShipmentRow, b: ShipmentRow): [ShipmentRow, ShipmentRow] {
  const ta = a.first_order_at ? Date.parse(a.first_order_at) : Infinity;
  const tb = b.first_order_at ? Date.parse(b.first_order_at) : Infinity;
  return ta <= tb ? [a, b] : [b, a];
}
