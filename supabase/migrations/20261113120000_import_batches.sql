-- Phase 2 / migration 1 — importing Shopify CSV batches
--
--  * import_batches: sha256 (a file can be imported once), uploader, order counts,
--    the columns found in the file, and the archive state of the raw CSV.
--  * import_batch_orders: which orders each batch contained ("seen again in batch X").
--  * orders / order_lines / flags: the extra typed columns and the flag source.
--  * Import is OWNER ONLY: batches, batch orders and the raw-imports bucket.
--  * public.import_commit(): writes one whole batch in one transaction
--    (called only by the import-batch Edge Function, with the service role).
--  * Archive functions: raw CSVs past retention wait for an archive copy on the
--    owner's computer; a raw CSV can only be deleted once that copy is confirmed.

-- ---------------------------------------------------------------------------
-- import_batches
-- ---------------------------------------------------------------------------
alter table public.import_batches
  add column sha256 text,
  add column uploaded_by uuid, -- auth.users.id of the owner who imported it (no FK: history survives)
  add column product_rows integer check (product_rows >= 0),
  add column orders_new integer not null default 0 check (orders_new >= 0),
  add column orders_updated integer not null default 0 check (orders_updated >= 0),
  add column orders_unchanged integer not null default 0 check (orders_unchanged >= 0),
  add column orders_skipped integer not null default 0 check (orders_skipped >= 0),
  add column orders_to_check integer not null default 0 check (orders_to_check >= 0),
  add column columns text[] not null default '{}', -- column names in the file, in file order
  add column archive_state text not null default 'stored'
    check (archive_state in ('stored', 'waiting', 'archived')),
  add column archive_requested_at timestamptz, -- when it started waiting for an archive copy
  add column archived_at timestamptz,
  add column archived_by uuid,
  add column archived_on text, -- which computer saved the copy
  add column archived_path text, -- path inside the chosen folder, e.g. 2026/2026-11-12_orders.csv
  add column archive_method text check (archive_method in ('folder', 'zip'));

-- No batches exist before Phase 2, so the new key can be required straight away.
alter table public.import_batches
  alter column sha256 set not null,
  add constraint import_batches_sha256_format check (sha256 ~ '^[0-9a-f]{64}$'),
  add constraint import_batches_archived_check check (
    archive_state <> 'archived'
    or (archived_at is not null and archive_method is not null)
  );
create unique index import_batches_sha256_key on public.import_batches (sha256);
create index import_batches_archive_state_idx on public.import_batches (archive_state)
  where archive_state <> 'archived' or raw_deleted_at is null;

comment on column public.import_batches.file_hash is 'Legacy FNV-1a hash of the raw bytes';
comment on column public.import_batches.sha256 is 'SHA-256 of the raw file: the same file is imported only once';
comment on column public.import_batches.archive_state is
  'stored = raw CSV in cloud storage; waiting = past retention (or "archive now"), waiting for a copy '
  'on the owner''s computer; archived = copy confirmed (size + sha256). Deleted from storage only after that.';

-- ---------------------------------------------------------------------------
-- orders, order_lines: typed columns used by later phases
-- ---------------------------------------------------------------------------
alter table public.orders
  add column billing_phone text,
  add column customer_phone text, -- Shopify "Phone"
  add column shipping_province text,
  add column discount_cents integer,
  add column refunded_cents integer,
  add column tags text,
  add column payment_terms text;
comment on column public.orders.phone_raw is 'Shipping Phone as typed (Shopify''s leading apostrophe removed)';
comment on column public.orders.last_import_batch_id is 'The batch that last inserted or changed this order';

alter table public.order_lines
  add column source_row integer check (source_row >= 1),
  -- The CSV may hold a quantity that is not a whole number; it is flagged and stored as null.
  alter column quantity drop not null,
  alter column quantity drop default;

-- ---------------------------------------------------------------------------
-- import_batch_orders — every order a batch contained, and what happened to it
-- ---------------------------------------------------------------------------
create table public.import_batch_orders (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  batch_id uuid not null references public.import_batches (id) on delete cascade,
  order_id uuid not null references public.orders (id) on delete cascade,
  outcome text not null check (outcome in ('new', 'updated', 'unchanged')),
  first_row integer check (first_row >= 1), -- row of the order in this batch's file
  diff jsonb, -- for 'updated': what changed compared with the stored order
  unique (batch_id, order_id)
);
create index import_batch_orders_order_id_idx on public.import_batch_orders (order_id);

create trigger set_row_meta before insert or update on public.import_batch_orders
  for each row execute function private.set_row_meta();
create trigger audit_row after insert or update or delete on public.import_batch_orders
  for each row execute function private.audit_row();

-- ---------------------------------------------------------------------------
-- flags: issues about a whole file, and where each issue came from
-- ---------------------------------------------------------------------------
alter table public.flags
  add column import_batch_id uuid references public.import_batches (id) on delete cascade,
  add column source_batch_id uuid references public.import_batches (id) on delete set null,
  add column source_row integer,
  add column issue_key text, -- same issue on the same order = same key (no duplicates on re-import)
  add column origin text not null default 'app';
comment on column public.flags.import_batch_id is 'Set for an issue about the file itself (no order)';
comment on column public.flags.origin is
  'import_check = legacy validation of the CSV; import_change = changed/cancelled after import; app = other';

alter table public.flags drop constraint flags_check;
alter table public.flags add constraint flags_target_check
  check (order_id is not null or shipment_id is not null or import_batch_id is not null);
create index flags_import_batch_id_idx on public.flags (import_batch_id);
create index flags_source_batch_id_idx on public.flags (source_batch_id);
create index flags_order_issue_key_idx on public.flags (order_id, issue_key);

-- ---------------------------------------------------------------------------
-- settings: the column setting (P2-10). Must match SETTINGS_DEFAULTS.
-- ---------------------------------------------------------------------------
insert into public.settings (key, value, description) values
  ('visible_columns',
    '["Product Photo", "Name", "Lineitem name", "Lineitem price", "Shipping City",
      "Shipping Address1", "Shipping Address2", "Shipping Name", "Shipping Phone",
      "Shipping Zip", "Currency", "Subtotal", "Shipping", "Total", "Email",
      "Fulfillment Status", "Payment Method", "Lineitem sku", "Lineitem quantity"]'::jsonb,
    'Columns shown in the batch view and the Excel export, in order. Never changes stored data.')
on conflict (key) do nothing;
update public.settings
  set description = 'Default columns not in visible_columns (kept for compatibility)'
  where key = 'hidden_columns';

-- ---------------------------------------------------------------------------
-- Security: import is owner only
-- ---------------------------------------------------------------------------
drop policy import_batches_select on public.import_batches;
drop policy import_batches_insert on public.import_batches;
drop policy import_batches_update on public.import_batches;

create policy import_batches_select_owner on public.import_batches
  for select to authenticated
  using ((select private.is_owner()));
create policy import_batches_insert_owner on public.import_batches
  for insert to authenticated
  with check ((select private.is_owner()));
create policy import_batches_update_owner on public.import_batches
  for update to authenticated
  using ((select private.is_owner()))
  with check ((select private.is_owner()));

alter table public.import_batch_orders enable row level security;
grant select, insert, update, delete on table public.import_batch_orders to authenticated;
grant select, insert, update, delete on table public.import_batch_orders to service_role;

create policy import_batch_orders_select_owner on public.import_batch_orders
  for select to authenticated
  using ((select private.is_owner()));
create policy import_batch_orders_insert_owner on public.import_batch_orders
  for insert to authenticated
  with check ((select private.is_owner()));
create policy import_batch_orders_update_owner on public.import_batch_orders
  for update to authenticated
  using ((select private.is_owner()))
  with check ((select private.is_owner()));
create policy import_batch_orders_delete_owner on public.import_batch_orders
  for delete to authenticated
  using ((select private.is_owner()));

-- Storage: raw-imports becomes owner only. Uploads come from the Edge Function
-- (service role). The owner may delete a raw CSV only once its archive copy is
-- confirmed (P2-20): even a bug in the app cannot delete it earlier.
drop policy "happyhome members read files" on storage.objects;
drop policy "happyhome members upload files" on storage.objects;
drop policy "happyhome members replace files" on storage.objects;
drop policy "happyhome owner deletes files" on storage.objects;

create policy "happyhome members read files" on storage.objects
  for select to authenticated
  using (bucket_id in ('product-photos', 'labels') and (select private.is_member()));

create policy "happyhome owner reads raw imports" on storage.objects
  for select to authenticated
  using (bucket_id = 'raw-imports' and (select private.is_owner()));

create policy "happyhome members upload files" on storage.objects
  for insert to authenticated
  with check (bucket_id in ('product-photos', 'labels') and (select private.is_member()));

create policy "happyhome members replace files" on storage.objects
  for update to authenticated
  using (bucket_id in ('product-photos', 'labels') and (select private.is_member()))
  with check (bucket_id in ('product-photos', 'labels') and (select private.is_member()));

create policy "happyhome owner deletes files" on storage.objects
  for delete to authenticated
  using (bucket_id in ('product-photos', 'labels') and (select private.is_owner()));

create policy "happyhome owner deletes archived raw imports" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'raw-imports'
    and (select private.is_owner())
    and exists (
      select 1 from public.import_batches b
      where b.storage_path = objects.name and b.archive_state = 'archived'
    )
  );

-- ---------------------------------------------------------------------------
-- Helpers for the import
-- ---------------------------------------------------------------------------
-- The new value when the file has the column, else the stored one: a file
-- without a column never wipes what an earlier file brought.
create or replace function private.pick(p_present boolean, p_new anyelement, p_old anyelement)
returns anyelement
language sql
immutable
set search_path = ''
as $$
  select case when p_present then p_new else p_old end
$$;

-- Cell text for comparing two exports: line breaks unified, outer spaces ignored.
create or replace function private.import_text(p jsonb, k text)
returns text
language sql
immutable
set search_path = ''
as $$
  select btrim(regexp_replace(coalesce(p ->> k, ''), E'\r\n?', E'\n', 'g'))
$$;

-- {column: {before, after}} for every column of p_new whose text differs from p_old.
-- Columns missing from the new file are not compared (not a change).
create or replace function private.import_raw_diff(p_old jsonb, p_new jsonb, p_lineitem_only boolean)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    jsonb_object_agg(k, jsonb_build_object('before', p_old -> k, 'after', p_new -> k)),
    '{}'::jsonb
  )
  from jsonb_object_keys(p_new) as k
  where (not p_lineitem_only or k like 'Lineitem %' or k = 'Vendor')
    and private.import_text(p_old, k) is distinct from private.import_text(p_new, k)
$$;

revoke all on function private.pick(boolean, anyelement, anyelement) from public, anon, authenticated;
revoke all on function private.import_text(jsonb, text) from public, anon, authenticated;
revoke all on function private.import_raw_diff(jsonb, jsonb, boolean) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- public.import_commit — one batch, one transaction (P2-15)
--
-- p_actor        the signed-in owner (checked again here)
-- p_batch_id     id for the new batch (the Edge Function stored the raw file under it)
-- p_storage_path object path in the raw-imports bucket
-- p_payload      the browser's parse result (packages/core/src/import/payload.ts)
--
-- Upsert rules (key = Shopify Id, fallback Name):
--   new order            -> insert
--   same as stored       -> "unchanged": recorded in import_batch_orders only
--   different            -> update + diff in audit_log + amber flag (red with a waybill)
--   cancelled since then -> red flag; its shipments become 'cancelled' unless handed over
-- ---------------------------------------------------------------------------
create or replace function public.import_commit(
  p_actor uuid,
  p_batch_id uuid,
  p_storage_path text,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_file jsonb := p_payload -> 'file';
  v_cols text[];
  v_order jsonb;
  v_line jsonb;
  v_r public.orders%rowtype;
  v_existing public.orders%rowtype;
  v_found boolean;
  v_order_id uuid;
  v_outcome text;
  v_field_diff jsonb;
  v_line_diff jsonb;
  v_one jsonb;
  v_diff jsonb;
  v_old_line_raw jsonb;
  v_old_count integer;
  v_new_count integer;
  v_hash text;
  v_keys text[];
  v_changed text;
  v_has_waybill boolean;
  v_new_cancel boolean;
  v_handed_over boolean;
  v_cancelled_shipments jsonb;
  v_new integer := 0;
  v_updated integer := 0;
  v_unchanged integer := 0;
  v_skipped integer := coalesce(jsonb_array_length(p_payload -> 'skipped'), 0);
  v_to_check integer;
  v_has_sku boolean;
  v_has_price boolean;
  v_has_ship boolean;
begin
  if (p_payload ->> 'version') is distinct from '1' then
    raise exception 'unsupported_payload_version' using errcode = '22023';
  end if;

  -- Triggers (updated_by, audit_log.actor) record the owner, not the service role.
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', p_actor, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', p_actor::text, true);

  if not exists (
    select 1 from public.members m where m.user_id = p_actor and m.active and m.role = 'owner'
  ) then
    raise exception 'owner_only' using errcode = '42501';
  end if;

  -- One import at a time, so two overlapping files never race each other.
  perform pg_advisory_xact_lock(hashtext('happyhome.import_commit'));

  if exists (select 1 from public.import_batches b where b.sha256 = v_file ->> 'sha256') then
    raise exception 'duplicate_file' using errcode = '23505';
  end if;

  v_cols := array(select jsonb_array_elements_text(v_file -> 'columns'));
  v_has_sku := 'Lineitem sku' = any (v_cols);
  v_has_price := 'Lineitem price' = any (v_cols);
  v_has_ship := 'Lineitem requires shipping' = any (v_cols);

  insert into public.import_batches (
    id, file_name, file_hash, file_size_bytes, encoding, delimiter, storage_path,
    row_count, order_count, status, sha256, uploaded_by, product_rows, columns, summary
  ) values (
    p_batch_id, v_file ->> 'name', v_file ->> 'fnv', (v_file ->> 'size')::integer,
    v_file ->> 'encoding', v_file ->> 'delimiter', p_storage_path,
    (v_file ->> 'row_count')::integer, coalesce(jsonb_array_length(p_payload -> 'orders'), 0),
    'imported', v_file ->> 'sha256', p_actor, (v_file ->> 'product_rows')::integer, v_cols,
    jsonb_build_object('skipped', coalesce(p_payload -> 'skipped', '[]'::jsonb))
  );

  -- Issues about the file itself.
  insert into public.flags (
    import_batch_id, source_batch_id, source_row, severity, code, message_bg, message_en,
    reason_bg, reason_en, details, issue_key, origin
  )
  select p_batch_id, p_batch_id, (f ->> 'source_row')::integer, f ->> 'severity', f ->> 'code',
         f ->> 'message_bg', f ->> 'message_en', f ->> 'reason_bg', f ->> 'reason_en',
         coalesce(f -> 'details', '{}'::jsonb), f ->> 'issue_key', 'import_check'
  from jsonb_array_elements(coalesce(p_payload -> 'batch_flags', '[]'::jsonb)) f;

  for v_order in select * from jsonb_array_elements(coalesce(p_payload -> 'orders', '[]'::jsonb))
  loop
    v_r := jsonb_populate_record(null::public.orders, v_order -> 'fields');
    v_hash := md5(jsonb_build_array(
      v_order -> 'raw',
      (select jsonb_agg(l -> 'raw' order by (l ->> 'line_no')::integer)
       from jsonb_array_elements(v_order -> 'lines') l)
    )::text);

    -- Find the stored order: Shopify Id first, then the order number.
    v_found := false;
    if nullif(v_order ->> 'shopify_id', '') is not null then
      select * into v_existing from public.orders o
        where o.shopify_id = v_order ->> 'shopify_id' for update;
      v_found := found;
    end if;
    if not v_found then
      select * into v_existing from public.orders o
        where o.name = v_order ->> 'name'
          and (o.shopify_id is null or nullif(v_order ->> 'shopify_id', '') is null)
        order by (o.shopify_id is null) desc, o.created_at
        limit 1
        for update;
      v_found := found;
    end if;

    v_diff := null;
    if not v_found then
      -- New order.
      insert into public.orders (
        shopify_id, name, first_import_batch_id, last_import_batch_id, created_at_shopify,
        email, email_norm, phone_raw, phone_norm, billing_phone, customer_phone,
        shipping_name, shipping_company, shipping_address1, shipping_address2, shipping_city,
        shipping_zip, shipping_province, shipping_country, shipping_method, payment_method,
        is_cod, financial_status, fulfillment_status, currency, subtotal_cents, shipping_cents,
        total_cents, outstanding_cents, discount_cents, refunded_cents, notes, note_attributes,
        tags, payment_terms, cancelled_at, content_hash, raw
      ) values (
        nullif(v_order ->> 'shopify_id', ''), v_order ->> 'name', p_batch_id, p_batch_id,
        v_r.created_at_shopify, v_r.email, v_r.email_norm, v_r.phone_raw, v_r.phone_norm,
        v_r.billing_phone, v_r.customer_phone, v_r.shipping_name, v_r.shipping_company,
        v_r.shipping_address1, v_r.shipping_address2, v_r.shipping_city, v_r.shipping_zip,
        v_r.shipping_province, v_r.shipping_country, v_r.shipping_method, v_r.payment_method,
        v_r.is_cod, v_r.financial_status, v_r.fulfillment_status, coalesce(v_r.currency, 'EUR'),
        v_r.subtotal_cents, v_r.shipping_cents, v_r.total_cents, v_r.outstanding_cents,
        v_r.discount_cents, v_r.refunded_cents, v_r.notes, coalesce(v_r.note_attributes, '[]'::jsonb),
        v_r.tags, v_r.payment_terms, v_r.cancelled_at, v_hash, v_order -> 'raw'
      )
      returning id into v_order_id;

      insert into public.order_lines (
        order_id, line_no, source_row, name, sku, quantity, price_cents, requires_shipping, raw
      )
      select v_order_id, (l ->> 'line_no')::integer, (l ->> 'source_row')::integer,
             coalesce(l ->> 'name', ''), nullif(l ->> 'sku', ''), (l ->> 'quantity')::integer,
             (l ->> 'price_cents')::integer, (l ->> 'requires_shipping')::boolean, l -> 'raw'
      from jsonb_array_elements(v_order -> 'lines') l;

      v_outcome := 'new';
      v_new := v_new + 1;
    else
      v_order_id := v_existing.id;

      -- What changed? Order columns (first row) and the product columns of each line.
      v_field_diff := private.import_raw_diff(v_existing.raw, v_order -> 'raw', false);
      v_line_diff := '{}'::jsonb;
      for v_line in select * from jsonb_array_elements(v_order -> 'lines')
      loop
        select ol.raw into v_old_line_raw from public.order_lines ol
          where ol.order_id = v_order_id and ol.line_no = (v_line ->> 'line_no')::integer;
        if not found then
          v_line_diff := v_line_diff || jsonb_build_object(v_line ->> 'line_no', 'added'::text);
        else
          v_one := private.import_raw_diff(v_old_line_raw, v_line -> 'raw', true);
          if v_one <> '{}'::jsonb then
            v_line_diff := v_line_diff || jsonb_build_object(v_line ->> 'line_no', v_one);
          end if;
        end if;
      end loop;
      select count(*) into v_old_count from public.order_lines ol where ol.order_id = v_order_id;
      v_new_count := jsonb_array_length(v_order -> 'lines');
      if v_old_count > v_new_count then
        select v_line_diff || coalesce(jsonb_object_agg(ol.line_no::text, 'removed'::text), '{}'::jsonb)
          into v_line_diff
          from public.order_lines ol
          where ol.order_id = v_order_id and ol.line_no > v_new_count;
      end if;

      if v_field_diff = '{}'::jsonb and v_line_diff = '{}'::jsonb then
        v_outcome := 'unchanged';
        v_unchanged := v_unchanged + 1;
      else
        v_outcome := 'updated';
        v_updated := v_updated + 1;
        v_diff := jsonb_strip_nulls(jsonb_build_object(
          'fields', nullif(v_field_diff, '{}'::jsonb),
          'lines', nullif(v_line_diff, '{}'::jsonb)
        ));

        v_has_waybill := exists (
          select 1 from public.shipment_orders so
          join public.shipments s on s.id = so.shipment_id
          where so.order_id = v_order_id
            and (s.waybill_number is not null
                 or s.status in ('waybill_created', 'printed', 'handed_over', 'delivered', 'returned'))
        );
        v_new_cancel := v_existing.cancelled_at is null and v_r.cancelled_at is not null
          and 'Cancelled at' = any (v_cols);

        update public.orders o set
          shopify_id = coalesce(o.shopify_id, nullif(v_order ->> 'shopify_id', '')),
          last_import_batch_id = p_batch_id,
          created_at_shopify = private.pick('Created at' = any (v_cols), v_r.created_at_shopify, o.created_at_shopify),
          email = private.pick('Email' = any (v_cols), v_r.email, o.email),
          email_norm = private.pick('Email' = any (v_cols), v_r.email_norm, o.email_norm),
          phone_raw = private.pick('Shipping Phone' = any (v_cols), v_r.phone_raw, o.phone_raw),
          phone_norm = private.pick('Shipping Phone' = any (v_cols), v_r.phone_norm, o.phone_norm),
          billing_phone = private.pick('Billing Phone' = any (v_cols), v_r.billing_phone, o.billing_phone),
          customer_phone = private.pick('Phone' = any (v_cols), v_r.customer_phone, o.customer_phone),
          shipping_name = private.pick('Shipping Name' = any (v_cols), v_r.shipping_name, o.shipping_name),
          shipping_company = private.pick('Shipping Company' = any (v_cols), v_r.shipping_company, o.shipping_company),
          shipping_address1 = private.pick('Shipping Address1' = any (v_cols), v_r.shipping_address1, o.shipping_address1),
          shipping_address2 = private.pick('Shipping Address2' = any (v_cols), v_r.shipping_address2, o.shipping_address2),
          shipping_city = private.pick('Shipping City' = any (v_cols), v_r.shipping_city, o.shipping_city),
          shipping_zip = private.pick('Shipping Zip' = any (v_cols), v_r.shipping_zip, o.shipping_zip),
          shipping_province = private.pick('Shipping Province' = any (v_cols), v_r.shipping_province, o.shipping_province),
          shipping_country = private.pick('Shipping Country' = any (v_cols), v_r.shipping_country, o.shipping_country),
          shipping_method = private.pick('Shipping Method' = any (v_cols), v_r.shipping_method, o.shipping_method),
          payment_method = private.pick('Payment Method' = any (v_cols), v_r.payment_method, o.payment_method),
          is_cod = private.pick('Payment Method' = any (v_cols), v_r.is_cod, o.is_cod),
          financial_status = private.pick('Financial Status' = any (v_cols), v_r.financial_status, o.financial_status),
          fulfillment_status = private.pick('Fulfillment Status' = any (v_cols), v_r.fulfillment_status, o.fulfillment_status),
          currency = private.pick('Currency' = any (v_cols), coalesce(v_r.currency, o.currency), o.currency),
          subtotal_cents = private.pick('Subtotal' = any (v_cols), v_r.subtotal_cents, o.subtotal_cents),
          shipping_cents = private.pick('Shipping' = any (v_cols), v_r.shipping_cents, o.shipping_cents),
          total_cents = private.pick('Total' = any (v_cols), v_r.total_cents, o.total_cents),
          outstanding_cents = private.pick('Outstanding Balance' = any (v_cols), v_r.outstanding_cents, o.outstanding_cents),
          discount_cents = private.pick('Discount Amount' = any (v_cols), v_r.discount_cents, o.discount_cents),
          refunded_cents = private.pick('Refunded Amount' = any (v_cols), v_r.refunded_cents, o.refunded_cents),
          notes = private.pick('Notes' = any (v_cols), v_r.notes, o.notes),
          note_attributes = private.pick('Note Attributes' = any (v_cols), coalesce(v_r.note_attributes, '[]'::jsonb), o.note_attributes),
          tags = private.pick('Tags' = any (v_cols), v_r.tags, o.tags),
          payment_terms = private.pick('Payment Terms Name' = any (v_cols), v_r.payment_terms, o.payment_terms),
          cancelled_at = private.pick('Cancelled at' = any (v_cols), v_r.cancelled_at, o.cancelled_at),
          content_hash = v_hash,
          raw = o.raw || (v_order -> 'raw')
        where o.id = v_order_id;

        insert into public.order_lines as ol (
          order_id, line_no, source_row, name, sku, quantity, price_cents, requires_shipping, raw
        )
        select v_order_id, (l ->> 'line_no')::integer, (l ->> 'source_row')::integer,
               coalesce(l ->> 'name', ''), nullif(l ->> 'sku', ''), (l ->> 'quantity')::integer,
               (l ->> 'price_cents')::integer, (l ->> 'requires_shipping')::boolean, l -> 'raw'
        from jsonb_array_elements(v_order -> 'lines') l
        on conflict (order_id, line_no) do update set
          source_row = excluded.source_row,
          name = excluded.name,
          sku = case when v_has_sku then excluded.sku else ol.sku end,
          quantity = excluded.quantity,
          price_cents = case when v_has_price then excluded.price_cents else ol.price_cents end,
          requires_shipping = case when v_has_ship then excluded.requires_shipping else ol.requires_shipping end,
          raw = ol.raw || excluded.raw;
        delete from public.order_lines ol where ol.order_id = v_order_id and ol.line_no > v_new_count;

        -- The diff itself, in the audit log (the triggers also log the full rows).
        insert into public.audit_log (actor, updated_by, table_name, row_id, action, before, after, reason)
        values (
          p_actor, p_actor, 'orders', v_order_id, 'update',
          jsonb_build_object(
            'fields', (select coalesce(jsonb_object_agg(k, v_field_diff -> k -> 'before'), '{}'::jsonb)
                       from jsonb_object_keys(v_field_diff) k),
            'lines', v_line_diff),
          jsonb_build_object(
            'fields', (select coalesce(jsonb_object_agg(k, v_field_diff -> k -> 'after'), '{}'::jsonb)
                       from jsonb_object_keys(v_field_diff) k),
            'lines', v_line_diff),
          'shopify_reimport: ' || (v_file ->> 'name')
        );

        v_changed := array_to_string(
          array(select k from jsonb_object_keys(v_field_diff) k order by k), ', ');

        if v_new_cancel then
          with done as (
            update public.shipments s set status = 'cancelled', cancelled_at = now()
            where s.id in (select so.shipment_id from public.shipment_orders so where so.order_id = v_order_id)
              and s.status not in ('handed_over', 'delivered', 'returned', 'cancelled')
            returning s.id
          )
          select coalesce(jsonb_agg(done.id), '[]'::jsonb) into v_cancelled_shipments from done;
          v_handed_over := exists (
            select 1 from public.shipment_orders so join public.shipments s on s.id = so.shipment_id
            where so.order_id = v_order_id and s.status in ('handed_over', 'delivered', 'returned')
          );
          insert into public.flags (
            order_id, source_batch_id, source_row, severity, code, message_bg, message_en,
            reason_bg, reason_en, details, issue_key, origin
          ) values (
            v_order_id, p_batch_id, (v_order ->> 'first_row')::integer, 'red',
            'ORDER_CANCELLED_AFTER_IMPORT',
            'Поръчката е отказана в Shopify след внасянето — не я изпращайте.'
              || case when v_handed_over
                   then ' Пратката вече е предадена на куриера — свържете се с куриера, за да я спре.'
                   else '' end,
            'The order was cancelled in Shopify after it was imported — do not ship it.'
              || case when v_handed_over
                   then ' The parcel was already handed over — contact the courier to stop it.'
                   else '' end,
            'Отказана поръчка не се изпраща.',
            'A cancelled order is never shipped.',
            jsonb_build_object('diff', v_diff, 'cancelled_shipments', v_cancelled_shipments,
                               'handed_over', v_handed_over, 'batch_file', v_file ->> 'name'),
            'ORDER_CANCELLED_AFTER_IMPORT:' || p_batch_id::text,
            'import_change'
          );
        else
          insert into public.flags (
            order_id, source_batch_id, source_row, severity, code, message_bg, message_en,
            reason_bg, reason_en, details, issue_key, origin
          ) values (
            v_order_id, p_batch_id, (v_order ->> 'first_row')::integer,
            case when v_has_waybill then 'red' else 'amber' end,
            'ORDER_CHANGED_AFTER_IMPORT',
            'Поръчката е променена в Shopify след внасянето.'
              || case when v_changed <> '' then ' Променено: ' || v_changed else '' end
              || case when v_line_diff <> '{}'::jsonb
                   then case when v_changed <> '' then ', продуктите' else ' Променени са продуктите' end
                   else '' end
              || '.'
              || case when v_has_waybill
                   then ' Вече има товарителница — проверете дали етикетът още е верен.' else '' end,
            'The order was changed in Shopify after it was imported.'
              || case when v_changed <> '' then ' Changed: ' || v_changed else '' end
              || case when v_line_diff <> '{}'::jsonb
                   then case when v_changed <> '' then ', products' else ' The products changed' end
                   else '' end
              || '.'
              || case when v_has_waybill
                   then ' A waybill already exists — check that the label is still right.' else '' end,
            'Новите данни от Shopify заместиха старите. Проверете промяната, преди да изпратите.',
            'The new Shopify data replaced the old data. Check the change before shipping.',
            jsonb_build_object('diff', v_diff, 'has_waybill', v_has_waybill,
                               'batch_file', v_file ->> 'name'),
            'ORDER_CHANGED_AFTER_IMPORT:' || p_batch_id::text,
            'import_change'
          );
        end if;

        -- Check results the new data no longer produces are resolved, with the reason.
        v_keys := array(select f ->> 'issue_key' from jsonb_array_elements(v_order -> 'flags') f);
        update public.flags f set
          resolved_at = now(),
          resolution_note = 'Вече го няма в по-новото внасяне („' || (v_file ->> 'name')
            || '“). / No longer in the newer import (' || (v_file ->> 'name') || ').'
        where f.order_id = v_order_id
          and f.origin = 'import_check'
          and f.resolved_at is null
          and not (f.issue_key = any (v_keys));
      end if;
    end if;

    -- Check results of this file: one flag per issue per order, never duplicated.
    insert into public.flags (
      order_id, source_batch_id, source_row, severity, code, message_bg, message_en,
      reason_bg, reason_en, details, issue_key, origin
    )
    select v_order_id, p_batch_id, (f ->> 'source_row')::integer, f ->> 'severity', f ->> 'code',
           f ->> 'message_bg', f ->> 'message_en', f ->> 'reason_bg', f ->> 'reason_en',
           coalesce(f -> 'details', '{}'::jsonb), f ->> 'issue_key', 'import_check'
    from jsonb_array_elements(coalesce(v_order -> 'flags', '[]'::jsonb)) f
    where not exists (
      select 1 from public.flags x where x.order_id = v_order_id and x.issue_key = f ->> 'issue_key'
    );

    insert into public.import_batch_orders (batch_id, order_id, outcome, first_row, diff)
    values (p_batch_id, v_order_id, v_outcome, (v_order ->> 'first_row')::integer, v_diff)
    on conflict (batch_id, order_id) do nothing;
  end loop;

  select count(distinct bo.order_id) into v_to_check
  from public.import_batch_orders bo
  join public.flags f on f.order_id = bo.order_id
  where bo.batch_id = p_batch_id and f.resolved_at is null and f.severity in ('red', 'amber');

  update public.import_batches b set
    orders_new = v_new,
    orders_updated = v_updated,
    orders_unchanged = v_unchanged,
    orders_skipped = v_skipped,
    orders_to_check = v_to_check
  where b.id = p_batch_id;

  return jsonb_build_object(
    'batch_id', p_batch_id,
    'new', v_new,
    'updated', v_updated,
    'unchanged', v_unchanged,
    'skipped', v_skipped,
    'to_check', v_to_check
  );
end;
$$;

revoke all on function public.import_commit(uuid, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.import_commit(uuid, uuid, text, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- Archiving raw CSV files (owner only). The browser writes the copy; these
-- functions keep the state honest.
-- ---------------------------------------------------------------------------

-- Moves raw CSVs past settings.raw_csv_retention_days (or all of them, for
-- "Архивирай сега") to 'waiting'. Never deletes anything. Returns how many moved.
create or replace function public.archive_mark_due(p_all boolean default false)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_days integer;
  v_count integer;
begin
  if not (select private.is_owner()) then
    raise exception 'owner_only' using errcode = '42501';
  end if;
  select coalesce((s.value #>> '{}')::integer, 90) into v_days
    from public.settings s where s.key = 'raw_csv_retention_days';
  v_days := coalesce(v_days, 90);
  update public.import_batches b set archive_state = 'waiting', archive_requested_at = now()
  where b.archive_state = 'stored'
    and b.raw_deleted_at is null
    and b.storage_path is not null
    and (p_all or b.created_at < now() - make_interval(days => v_days));
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Records a verified archive copy. The size and SHA-256 must match the stored ones.
create or replace function public.archive_confirm(
  p_batch_id uuid,
  p_sha256 text,
  p_size_bytes bigint,
  p_computer text,
  p_path text,
  p_method text
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_batch public.import_batches%rowtype;
begin
  if not (select private.is_owner()) then
    raise exception 'owner_only' using errcode = '42501';
  end if;
  select * into v_batch from public.import_batches b where b.id = p_batch_id for update;
  if not found then
    raise exception 'batch_not_found' using errcode = 'P0002';
  end if;
  if v_batch.archive_state = 'archived' then
    return; -- already recorded (a retry after a lost connection)
  end if;
  if v_batch.archive_state <> 'waiting' then
    raise exception 'archive_not_requested' using errcode = '22023';
  end if;
  if p_sha256 is distinct from v_batch.sha256
     or p_size_bytes is distinct from v_batch.file_size_bytes::bigint then
    raise exception 'archive_checksum_mismatch' using errcode = '22000',
      detail = 'The saved copy does not match the imported file.';
  end if;
  update public.import_batches b set
    archive_state = 'archived',
    archived_at = now(),
    archived_by = auth.uid(),
    archived_on = left(coalesce(nullif(btrim(p_computer), ''), 'unknown'), 120),
    archived_path = left(p_path, 500),
    archive_method = p_method
  where b.id = p_batch_id;
end;
$$;

-- After the owner deleted the archived raw CSV from storage: records the date.
-- Refuses while the file is still in the bucket.
create or replace function public.archive_mark_deleted(p_batch_id uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_batch public.import_batches%rowtype;
begin
  if not (select private.is_owner()) then
    raise exception 'owner_only' using errcode = '42501';
  end if;
  select * into v_batch from public.import_batches b where b.id = p_batch_id for update;
  if not found or v_batch.archive_state <> 'archived' then
    raise exception 'not_archived' using errcode = '22023';
  end if;
  if exists (
    select 1 from storage.objects o
    where o.bucket_id = 'raw-imports' and o.name = v_batch.storage_path
  ) then
    raise exception 'raw_csv_still_stored' using errcode = '22023';
  end if;
  update public.import_batches b set raw_deleted_at = coalesce(b.raw_deleted_at, now())
  where b.id = p_batch_id;
end;
$$;

revoke all on function public.archive_mark_due(boolean) from public, anon;
revoke all on function public.archive_confirm(uuid, text, bigint, text, text, text) from public, anon;
revoke all on function public.archive_mark_deleted(uuid) from public, anon;
grant execute on function public.archive_mark_due(boolean) to authenticated, service_role;
grant execute on function public.archive_confirm(uuid, text, bigint, text, text, text)
  to authenticated, service_role;
grant execute on function public.archive_mark_deleted(uuid) to authenticated, service_role;
