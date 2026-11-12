-- Phase 1 / migration 2 — domain model (brief section 5)
-- Every table has: id uuid, created_at, updated_at, updated_by, version.
-- Money = integer euro cents. Weight = integer grams. Time = timestamptz.
-- Later phases extend these tables with their own migrations.

-- ---------------------------------------------------------------------------
-- import_batches — one uploaded Shopify CSV export
-- ---------------------------------------------------------------------------
create table public.import_batches (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  file_name text not null,
  file_hash text not null, -- FNV-1a of the raw bytes (repeated-file detection)
  file_size_bytes integer check (file_size_bytes >= 0),
  encoding text,
  delimiter text,
  storage_path text, -- object in the raw-imports bucket; null once deleted
  raw_deleted_at timestamptz, -- set when the raw CSV is removed after settings.raw_csv_retention_days
  row_count integer check (row_count >= 0),
  order_count integer check (order_count >= 0),
  status text not null default 'uploaded'
    check (status in ('uploaded', 'parsed', 'imported', 'failed')),
  summary jsonb not null default '{}'::jsonb
);
create index import_batches_file_hash_idx on public.import_batches (file_hash);
create index import_batches_created_at_idx on public.import_batches (created_at desc);

-- ---------------------------------------------------------------------------
-- orders — one per Shopify order. Unique on the Shopify Id; when an export
-- has no Id column, the order Name (e.g. #1001) is the fallback key.
-- ---------------------------------------------------------------------------
create table public.orders (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  shopify_id text unique,
  name text not null, -- Shopify "Name", e.g. #1001
  first_import_batch_id uuid references public.import_batches (id) on delete set null,
  last_import_batch_id uuid references public.import_batches (id) on delete set null,
  created_at_shopify timestamptz,
  email text,
  email_norm text,
  phone_raw text, -- as typed by the customer
  phone_norm text, -- normalized match key (0XXXXXXXXX)
  shipping_name text,
  shipping_company text,
  shipping_address1 text,
  shipping_address2 text,
  shipping_city text,
  shipping_zip text,
  shipping_country text,
  shipping_method text,
  payment_method text,
  is_cod boolean,
  financial_status text,
  fulfillment_status text,
  currency text not null default 'EUR',
  subtotal_cents integer,
  shipping_cents integer,
  total_cents integer,
  outstanding_cents integer,
  notes text,
  note_attributes jsonb not null default '[]'::jsonb,
  cancelled_at timestamptz,
  content_hash text, -- hash of the imported values, to spot changes on re-import
  raw jsonb not null default '{}'::jsonb -- every CSV column, untouched
);
create unique index orders_name_key_without_shopify_id on public.orders (name)
  where shopify_id is null;
create index orders_name_idx on public.orders (name);
create index orders_phone_norm_idx on public.orders (phone_norm);
create index orders_email_norm_idx on public.orders (email_norm);
create index orders_created_at_shopify_idx on public.orders (created_at_shopify);
create index orders_first_import_batch_id_idx on public.orders (first_import_batch_id);
create index orders_last_import_batch_id_idx on public.orders (last_import_batch_id);

-- ---------------------------------------------------------------------------
-- products — keyed by SKU
-- ---------------------------------------------------------------------------
create table public.products (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  sku text unique,
  name text not null,
  photo_path text, -- object in the product-photos bucket
  purchase_cost_cents integer check (purchase_cost_cents >= 0),
  weight_g integer check (weight_g > 0),
  stock_qty integer not null default 0,
  is_active boolean not null default true,
  notes text
);
create index products_name_idx on public.products (name);

-- ---------------------------------------------------------------------------
-- order_lines — the line items of an order
-- ---------------------------------------------------------------------------
create table public.order_lines (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  order_id uuid not null references public.orders (id) on delete cascade,
  line_no integer not null check (line_no >= 1),
  product_id uuid references public.products (id) on delete set null,
  name text not null,
  sku text,
  quantity integer not null default 1 check (quantity >= 0),
  price_cents integer,
  requires_shipping boolean,
  raw jsonb not null default '{}'::jsonb,
  unique (order_id, line_no)
);
create index order_lines_product_id_idx on public.order_lines (product_id);
create index order_lines_sku_idx on public.order_lines (sku);

-- ---------------------------------------------------------------------------
-- courier_offices — Econt and Speedy offices and lockers
-- ---------------------------------------------------------------------------
create table public.courier_offices (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  carrier text not null check (carrier in ('econt', 'speedy')),
  external_id text not null, -- Econt office code / Speedy office ID
  kind text not null check (kind in ('office', 'locker')),
  name text not null,
  name_en text,
  city text,
  zip text,
  address text,
  lat double precision check (lat between -90 and 90),
  lng double precision check (lng between -180 and 180),
  location extensions.geography(point, 4326), -- kept in sync with lat/lng by trigger
  geo_confidence smallint,
  phone text,
  working_hours jsonb,
  is_active boolean not null default true,
  source text not null, -- e.g. econt_api, speedy_public_list
  synced_at timestamptz,
  raw jsonb not null default '{}'::jsonb,
  unique (carrier, external_id)
);
create index courier_offices_location_idx on public.courier_offices using gist (location);
create index courier_offices_city_idx on public.courier_offices (carrier, city);
create index courier_offices_zip_idx on public.courier_offices (zip);

create or replace function private.set_office_location()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.lat is null or new.lng is null then
    new.location := null;
  else
    new.location :=
      extensions.st_setsrid(extensions.st_makepoint(new.lng, new.lat), 4326)::extensions.geography;
  end if;
  return new;
end;
$$;
revoke all on function private.set_office_location() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- shipments — one physical parcel = one label; can contain several orders
-- ---------------------------------------------------------------------------
create table public.shipments (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  status text not null default 'imported' check (status in (
    'imported', 'needs_check', 'ready', 'waiting_manual_waybill', 'waybill_created',
    'printed', 'printed_draft', 'handed_over', 'delivered', 'returned', 'cancelled'
  )),
  carrier text check (carrier in ('econt', 'speedy', 'boxnow', 'other')),
  delivery_type text check (delivery_type in ('office', 'locker', 'address')),
  office_id uuid references public.courier_offices (id) on delete set null,
  recipient_name text,
  recipient_phone_raw text,
  recipient_phone_norm text,
  recipient_email text,
  city text,
  zip text,
  address1 text,
  address2 text,
  cod_cents integer check (cod_cents >= 0),
  declared_value_cents integer check (declared_value_cents >= 0),
  weight_g integer check (weight_g > 0),
  waybill_number text,
  waybill_pdf_path text, -- object in the labels bucket
  waybill_created_at timestamptz,
  printed_at timestamptz,
  handed_over_at timestamptz,
  delivered_at timestamptz,
  returned_at timestamptz,
  cancelled_at timestamptz,
  -- Fields a person picked by hand: {"office_id": true, ...}. Automatic logic leaves them alone.
  manual_overrides jsonb not null default '{}'::jsonb,
  -- Why each automatic decision was made: [{code, bg, en, ...}]
  decision_reasons jsonb not null default '[]'::jsonb,
  notes text
);
-- One waybill number can belong to one shipment only.
create unique index shipments_waybill_unique on public.shipments (carrier, waybill_number)
  where waybill_number is not null;
create index shipments_status_idx on public.shipments (status);
create index shipments_office_id_idx on public.shipments (office_id);
create index shipments_recipient_phone_norm_idx on public.shipments (recipient_phone_norm);

-- ---------------------------------------------------------------------------
-- shipment_orders — which orders travel in which shipment
-- ---------------------------------------------------------------------------
create table public.shipment_orders (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  shipment_id uuid not null references public.shipments (id) on delete cascade,
  order_id uuid not null references public.orders (id) on delete restrict,
  unique (shipment_id, order_id)
);
create index shipment_orders_order_id_idx on public.shipment_orders (order_id);

-- ---------------------------------------------------------------------------
-- flags — typed issues on an order or a shipment
-- ---------------------------------------------------------------------------
create table public.flags (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  order_id uuid references public.orders (id) on delete cascade,
  shipment_id uuid references public.shipments (id) on delete cascade,
  severity text not null check (severity in ('info', 'amber', 'red')),
  code text not null, -- machine code, e.g. PHONE_INVALID
  message_bg text not null,
  message_en text not null,
  reason_bg text,
  reason_en text,
  details jsonb not null default '{}'::jsonb,
  resolved_at timestamptz,
  resolved_by uuid,
  resolution_note text,
  check (order_id is not null or shipment_id is not null)
);
create index flags_order_id_idx on public.flags (order_id);
create index flags_shipment_id_idx on public.flags (shipment_id);
create index flags_open_idx on public.flags (severity) where resolved_at is null;

-- ---------------------------------------------------------------------------
-- product_cost_history and stock_movements
-- ---------------------------------------------------------------------------
create table public.product_cost_history (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  product_id uuid not null references public.products (id) on delete restrict,
  cost_cents integer not null check (cost_cents >= 0),
  valid_from timestamptz not null default now(),
  note text
);
create index product_cost_history_product_idx
  on public.product_cost_history (product_id, valid_from desc);

create table public.stock_movements (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  product_id uuid not null references public.products (id) on delete restrict,
  quantity_delta integer not null check (quantity_delta <> 0),
  reason text not null check (reason in ('purchase', 'shipment', 'return', 'adjustment')),
  shipment_id uuid references public.shipments (id) on delete set null,
  note text
);
create index stock_movements_product_id_idx on public.stock_movements (product_id, created_at desc);
create index stock_movements_shipment_id_idx on public.stock_movements (shipment_id);

-- ---------------------------------------------------------------------------
-- geocode_cache — results from the geocoding provider, reused
-- ---------------------------------------------------------------------------
create table public.geocode_cache (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  provider text not null, -- e.g. nominatim, google
  query_norm text not null,
  lat double precision check (lat between -90 and 90),
  lng double precision check (lng between -180 and 180),
  display_name text,
  confidence real,
  raw jsonb not null default '{}'::jsonb,
  fetched_at timestamptz not null default now(),
  unique (provider, query_norm)
);

-- ---------------------------------------------------------------------------
-- tariffs — backup price tables (labelled "ориентировъчна цена" in the UI)
-- ---------------------------------------------------------------------------
create table public.tariffs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  carrier text not null check (carrier in ('econt', 'speedy')),
  service text not null default 'standard',
  delivery_type text not null check (delivery_type in ('office', 'locker', 'address')),
  variant text not null default 'default', -- e.g. town_with_office, town_without_office, promo
  max_weight_g integer not null check (max_weight_g > 0),
  price_cents integer not null check (price_cents >= 0),
  extra_per_kg_cents integer check (extra_per_kg_cents >= 0),
  params jsonb not null default '{}'::jsonb, -- extra rules for the band (Phase 7)
  valid_from date not null,
  valid_to date,
  source text not null, -- where the price comes from (URL / document, date checked)
  notes text,
  check (valid_to is null or valid_to >= valid_from)
);
create index tariffs_lookup_idx on public.tariffs (carrier, delivery_type, variant, valid_from);

-- ---------------------------------------------------------------------------
-- price_quotes — a price for one shipment from one courier
-- ---------------------------------------------------------------------------
create table public.price_quotes (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  shipment_id uuid not null references public.shipments (id) on delete cascade,
  carrier text not null check (carrier in ('econt', 'speedy')),
  delivery_type text not null check (delivery_type in ('office', 'locker', 'address')),
  source text not null check (source in ('api', 'tariff')),
  is_estimate boolean not null default false,
  weight_g integer check (weight_g > 0),
  cod_cents integer check (cod_cents >= 0),
  total_cents integer not null check (total_cents >= 0),
  breakdown jsonb not null default '{}'::jsonb,
  tariff_id uuid references public.tariffs (id) on delete set null,
  quoted_at timestamptz not null default now()
);
create index price_quotes_shipment_id_idx on public.price_quotes (shipment_id, quoted_at desc);
create index price_quotes_tariff_id_idx on public.price_quotes (tariff_id);

-- ---------------------------------------------------------------------------
-- settings — key -> jsonb value (seeded in 20261112120400_seed_settings.sql)
-- ---------------------------------------------------------------------------
create table public.settings (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  key text not null unique check (key ~ '^[a-z][a-z0-9_]*$'),
  value jsonb not null,
  description text
);

-- ---------------------------------------------------------------------------
-- sync_probe — diagnostics only: the "connection check" page and the
-- realtime end-to-end test edit a row here instead of real shop data.
-- ---------------------------------------------------------------------------
create table public.sync_probe (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  label text not null unique,
  value text not null default ''
);

-- ---------------------------------------------------------------------------
-- Triggers: standard columns + audit on every table (audit_log excluded).
-- Cache tables refreshed by background jobs are audited for user edits only.
-- ---------------------------------------------------------------------------
create trigger set_row_meta before insert or update on public.import_batches
  for each row execute function private.set_row_meta();
create trigger audit_row after insert or update or delete on public.import_batches
  for each row execute function private.audit_row();

create trigger set_row_meta before insert or update on public.orders
  for each row execute function private.set_row_meta();
create trigger audit_row after insert or update or delete on public.orders
  for each row execute function private.audit_row();

create trigger set_row_meta before insert or update on public.products
  for each row execute function private.set_row_meta();
create trigger audit_row after insert or update or delete on public.products
  for each row execute function private.audit_row();

create trigger set_row_meta before insert or update on public.order_lines
  for each row execute function private.set_row_meta();
create trigger audit_row after insert or update or delete on public.order_lines
  for each row execute function private.audit_row();

create trigger set_row_meta before insert or update on public.courier_offices
  for each row execute function private.set_row_meta();
create trigger set_office_location before insert or update of lat, lng on public.courier_offices
  for each row execute function private.set_office_location();
create trigger audit_row after insert or update or delete on public.courier_offices
  for each row execute function private.audit_row('user_only');

create trigger set_row_meta before insert or update on public.shipments
  for each row execute function private.set_row_meta();
create trigger audit_row after insert or update or delete on public.shipments
  for each row execute function private.audit_row();

create trigger set_row_meta before insert or update on public.shipment_orders
  for each row execute function private.set_row_meta();
create trigger audit_row after insert or update or delete on public.shipment_orders
  for each row execute function private.audit_row();

create trigger set_row_meta before insert or update on public.flags
  for each row execute function private.set_row_meta();
create trigger audit_row after insert or update or delete on public.flags
  for each row execute function private.audit_row();

create trigger set_row_meta before insert or update on public.product_cost_history
  for each row execute function private.set_row_meta();
create trigger audit_row after insert or update or delete on public.product_cost_history
  for each row execute function private.audit_row();

create trigger set_row_meta before insert or update on public.stock_movements
  for each row execute function private.set_row_meta();
create trigger audit_row after insert or update or delete on public.stock_movements
  for each row execute function private.audit_row();

create trigger set_row_meta before insert or update on public.geocode_cache
  for each row execute function private.set_row_meta();
create trigger audit_row after insert or update or delete on public.geocode_cache
  for each row execute function private.audit_row('user_only');

create trigger set_row_meta before insert or update on public.tariffs
  for each row execute function private.set_row_meta();
create trigger audit_row after insert or update or delete on public.tariffs
  for each row execute function private.audit_row();

create trigger set_row_meta before insert or update on public.price_quotes
  for each row execute function private.set_row_meta();
create trigger audit_row after insert or update or delete on public.price_quotes
  for each row execute function private.audit_row('user_only');

create trigger set_row_meta before insert or update on public.settings
  for each row execute function private.set_row_meta();
create trigger audit_row after insert or update or delete on public.settings
  for each row execute function private.audit_row();

create trigger set_row_meta before insert or update on public.sync_probe
  for each row execute function private.set_row_meta();
create trigger audit_row after insert or update or delete on public.sync_probe
  for each row execute function private.audit_row();
