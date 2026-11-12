/**
 * Shared domain vocabulary. These lists must match the CHECK constraints in
 * supabase/migrations (the integration tests compare them with the database).
 */

export const MEMBER_ROLES = ['owner', 'packer'] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

/** Shipment pipeline, in order (brief section 5). */
export const SHIPMENT_STATUSES = [
  'imported',
  'needs_check',
  'ready',
  'waiting_manual_waybill',
  'waybill_created',
  'printed',
  'printed_draft',
  'handed_over',
  'delivered',
  'returned',
  'cancelled',
] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

export const CARRIERS = ['econt', 'speedy', 'boxnow', 'other'] as const;
export type Carrier = (typeof CARRIERS)[number];

/** Couriers the app works with; others are only detected and flagged. */
export const SUPPORTED_CARRIERS = ['econt', 'speedy'] as const satisfies readonly Carrier[];
export type SupportedCarrier = (typeof SUPPORTED_CARRIERS)[number];

export const DELIVERY_TYPES = ['office', 'locker', 'address'] as const;
export type DeliveryType = (typeof DELIVERY_TYPES)[number];

export const FLAG_SEVERITIES = ['info', 'amber', 'red'] as const;
export type FlagSeverity = (typeof FLAG_SEVERITIES)[number];

export const COURIER_MODES = ['api', 'manual'] as const;
export type CourierMode = (typeof COURIER_MODES)[number];
