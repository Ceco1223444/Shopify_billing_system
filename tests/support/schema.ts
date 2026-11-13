/** Every table the migrations create in `public`. */
export const PUBLIC_TABLES = [
  'audit_log',
  'courier_offices',
  'flags',
  'geocode_cache',
  'import_batch_orders',
  'import_batches',
  'members',
  'order_lines',
  'orders',
  'price_quotes',
  'product_cost_history',
  'products',
  'settings',
  'shipment_orders',
  'shipments',
  'stock_movements',
  'sync_probe',
  'tariffs',
] as const;

export type PublicTable = (typeof PUBLIC_TABLES)[number];

/** Tables only the owner may write (members read them). */
export const OWNER_WRITE_TABLES = [
  'import_batch_orders',
  'import_batches',
  'members',
  'settings',
  'shipment_orders', // Phase 3: only the owner moves orders between shipments (P3-12)
  'tariffs',
] as const;

/** Tables only the owner may even read (Phase 2: import is owner only). */
export const OWNER_ONLY_TABLES = ['import_batch_orders', 'import_batches'] as const;

/** Tables nobody signed in may write (audit trigger / Edge Functions only). */
export const READ_ONLY_FOR_USERS = ['audit_log', 'courier_offices', 'geocode_cache'] as const;

/** Tables whose changes are broadcast over Realtime. */
export const REALTIME_TABLES = ['flags', 'orders', 'products', 'shipments', 'sync_probe'] as const;

export const BUCKETS = ['labels', 'product-photos', 'raw-imports'] as const;

export const uniq = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
