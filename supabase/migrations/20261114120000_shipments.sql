-- Phase 3 / migration 1 — build shipments (1 shipment = 1 parcel = 1 label)
--
--  * shipments: reference ("#2002 + #2007"), why it was combined, COD breakdown,
--    contents, the batch that created it.
--  * shipment_orders: an order is in at most ONE shipment; added by the import or by hand.
--  * private.build_shipments(batch): runs at the end of import_commit, in the same
--    transaction. Rules: docs/STATUS.md "What Phase 3 built" (P3-01 … P3-09, P3-14).
--  * Owner-only RPCs: shipment_split, shipment_merge, shipment_keep_apart (P3-10 … P3-13).
--    RLS: only the owner may create shipments or move orders between them.
--  * public.shipment_overview: the Пратки list (orders, flag counts), with the caller's RLS.
--  * Backfill: shipments for the orders imported before this migration, batch by batch.

-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------
alter table public.shipments
  add column reference text, -- the order numbers, e.g. "#2002 + #2007"
  add column combined_by text[] not null default '{}'::text[],
  add column cod_breakdown jsonb not null default '[]'::jsonb,
  add column contents jsonb not null default '[]'::jsonb,
  add column source_batch_id uuid references public.import_batches (id) on delete set null,
  add column first_order_at timestamptz; -- earliest Shopify "Created at" of its orders
alter table public.shipments add constraint shipments_combined_by_check
  check (combined_by <@ array['phone', 'email', 'manual']::text[]);
comment on column public.shipments.combined_by is
  'Why several orders travel together: phone / email match (automatic) and/or manual (owner merge)';
comment on column public.shipments.cod_breakdown is
  '[{order_id, order, cod, amount_cents, source: outstanding|total|missing|prepaid}]';
create index shipments_source_batch_id_idx on public.shipments (source_batch_id);

alter table public.shipment_orders
  add column added_by text not null default 'import' check (added_by in ('import', 'manual'));
-- P3-01: all lines of an order travel together, so an order is in one shipment only.
drop index public.shipment_orders_order_id_idx;
create unique index shipment_orders_order_once on public.shipment_orders (order_id);

comment on column public.flags.origin is
  'import_check = legacy validation of the CSV; import_change = changed/cancelled after import; '
  'shipments = building shipments (Phase 3); app = other';

-- ---------------------------------------------------------------------------
-- Security (P3-12): only the owner creates shipments or moves orders between them.
-- Packers keep updating shipments (status, printing… in later phases).
-- ---------------------------------------------------------------------------
drop policy shipments_insert on public.shipments;
create policy shipments_insert_owner on public.shipments
  for insert to authenticated
  with check ((select private.is_owner()));

drop policy shipment_orders_insert on public.shipment_orders;
drop policy shipment_orders_update on public.shipment_orders;
create policy shipment_orders_insert_owner on public.shipment_orders
  for insert to authenticated
  with check ((select private.is_owner()));
create policy shipment_orders_update_owner on public.shipment_orders
  for update to authenticated
  using ((select private.is_owner()))
  with check ((select private.is_owner()));

-- ---------------------------------------------------------------------------
-- Normalisation (the database collation is ICU en-US, so lower() and [[:alnum:]]
-- handle Cyrillic; the same locally and on the hosted project).
-- ---------------------------------------------------------------------------

-- Lower case, punctuation and spaces collapsed: "Офис Еконт – Пловдив, бл.5" -> "офис еконт пловдив бл 5".
create or replace function private.norm_key(p text)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(btrim(regexp_replace(lower(coalesce(p, '')), '[^[:alnum:]]+', ' ', 'g')), '')
$$;

-- Destination of an order: the office text (+ city) when the address names a courier
-- office or locker, else Address1 + Address2 + City + Zip. null = no address at all.
create or replace function private.dest_of(p_a1 text, p_a2 text, p_city text, p_zip text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_a1 text := private.norm_key(p_a1);
  v_a2 text := private.norm_key(p_a2);
  v_city text := private.norm_key(p_city);
  v_zip text := nullif(regexp_replace(coalesce(p_zip, ''), '[^0-9]', '', 'g'), '');
  v_office constant text :=
    '(офис|еконт|спиди|автомат|пакетомат|office|econt|speedy|locker|box ?now)';
begin
  if v_a1 ~ v_office then
    return 'office:' || v_a1 || '|' || coalesce(v_city, '');
  end if;
  if v_a2 ~ v_office then
    return 'office:' || v_a2 || '|' || coalesce(v_city, '');
  end if;
  if coalesce(v_a1, v_a2, v_city, v_zip) is null then
    return null;
  end if;
  return 'addr:' || concat_ws('|', coalesce(v_a1, ''), coalesce(v_a2, ''), coalesce(v_city, ''),
                               coalesce(v_zip, ''));
end;
$$;

-- Product set of an order: SKU (else name) + quantity, ignoring line order.
create or replace function private.order_products(p_order_id uuid)
returns text[]
language sql
stable
set search_path = ''
as $$
  select coalesce(array_agg(t.k || '×' || t.q order by t.k), '{}'::text[])
  from (
    select coalesce('sku:' || lower(nullif(btrim(l.sku), '')),
                    'name:' || coalesce(private.norm_key(l.name), '')) as k,
           sum(coalesce(l.quantity, 1)) as q
    from public.order_lines l
    where l.order_id = p_order_id
    group by 1
  ) t
$$;

-- The same products, without quantities (for "overlapping" products).
create or replace function private.order_product_keys(p_order_id uuid)
returns text[]
language sql
stable
set search_path = ''
as $$
  select coalesce(array_agg(distinct coalesce('sku:' || lower(nullif(btrim(l.sku), '')),
                                              'name:' || coalesce(private.norm_key(l.name), ''))),
                  '{}'::text[])
  from public.order_lines l
  where l.order_id = p_order_id
$$;

-- "Before waybill_created": the shipment can still change.
create or replace function private.shipment_is_open(p_status text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_status in ('imported', 'needs_check', 'ready', 'waiting_manual_waybill')
$$;

-- Products of an order as text, for the side-by-side view of a possible duplicate.
create or replace function private.order_summary(p_order_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'order_id', o.id,
    'order', o.name,
    'created_at', o.created_at_shopify,
    'name', o.shipping_name,
    'phone', o.phone_raw,
    'email', o.email,
    'address', concat_ws(', ', nullif(o.shipping_address1, ''), nullif(o.shipping_address2, ''),
                         nullif(o.shipping_city, ''), nullif(o.shipping_zip, '')),
    'total_cents', o.total_cents,
    'products', (
      select coalesce(jsonb_agg(jsonb_build_object('sku', l.sku, 'name', l.name,
                                                   'quantity', l.quantity) order by l.line_no),
                      '[]'::jsonb)
      from public.order_lines l where l.order_id = o.id
    )
  )
  from public.orders o
  where o.id = p_order_id
$$;

-- One flag per issue: never repeated, also not after it was resolved (decisions are remembered).
create or replace function private.add_flag(
  p_order_id uuid,
  p_shipment_id uuid,
  p_severity text,
  p_code text,
  p_message_bg text,
  p_message_en text,
  p_reason_bg text,
  p_reason_en text,
  p_details jsonb,
  p_issue_key text,
  p_batch_id uuid
)
returns boolean
language plpgsql
set search_path = ''
as $$
begin
  if exists (
    select 1 from public.flags f
    where f.issue_key = p_issue_key
      and f.order_id is not distinct from p_order_id
      and f.shipment_id is not distinct from p_shipment_id
  ) then
    return false;
  end if;
  insert into public.flags (
    order_id, shipment_id, severity, code, message_bg, message_en, reason_bg, reason_en,
    details, issue_key, origin, source_batch_id
  ) values (
    p_order_id, p_shipment_id, p_severity, p_code, p_message_bg, p_message_en, p_reason_bg,
    p_reason_en, coalesce(p_details, '{}'::jsonb), p_issue_key, 'shipments', p_batch_id
  );
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- private.refresh_shipment_status — P3-14: needs_check with any open red/amber flag
-- (on the shipment or one of its orders), else ready. Only while the shipment is
-- imported / needs_check / ready, and never when a person set the status by hand.
-- ---------------------------------------------------------------------------
create or replace function private.refresh_shipment_status(p_shipment_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_status text;
  v_new text;
begin
  select s.status into v_status from public.shipments s
  where s.id = p_shipment_id and not (s.manual_overrides ? 'status');
  if not found or v_status not in ('imported', 'needs_check', 'ready') then
    return;
  end if;
  v_new := case when exists (
      select 1 from public.flags f
      where f.resolved_at is null
        and f.severity in ('red', 'amber')
        and (f.shipment_id = p_shipment_id
             or f.order_id in (select so.order_id from public.shipment_orders so
                               where so.shipment_id = p_shipment_id))
    ) then 'needs_check' else 'ready' end;
  if v_new is distinct from v_status then
    update public.shipments s set status = v_new where s.id = p_shipment_id;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- private.refresh_shipment — the combined values (section 3.3), from its orders:
-- recipient from the EARLIEST order (fields a person set by hand stay), COD = sum of
-- Outstanding Balance (fallback Total) over the COD orders, contents, reference,
-- why combined; differences between the orders become grey flags; then the status.
-- Writes only when something changed (no version bump, no audit row otherwise).
-- ---------------------------------------------------------------------------
create or replace function private.refresh_shipment(p_shipment_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_s public.shipments%rowtype;
  v_n public.shipments%rowtype;
  v_first public.orders%rowtype;
  v_ov jsonb;
  v_count integer;
  v_by text[];
  v_field text;
  v_values jsonb;
  v_key text;
  v_label_bg text;
  v_label_en text;
  v_list text;
begin
  select * into v_s from public.shipments s where s.id = p_shipment_id for update;
  if not found then
    return;
  end if;
  select count(*) into v_count from public.shipment_orders so where so.shipment_id = p_shipment_id;
  if v_count = 0 then
    return;
  end if;
  v_ov := v_s.manual_overrides;
  v_n := v_s;

  select o.* into v_first
  from public.shipment_orders so join public.orders o on o.id = so.order_id
  where so.shipment_id = p_shipment_id
  order by o.created_at_shopify nulls last, o.name, o.id
  limit 1;

  select string_agg(o.name, ' + ' order by o.created_at_shopify nulls last, o.name, o.id),
         min(o.created_at_shopify),
         jsonb_agg(jsonb_build_object(
           'order_id', o.id,
           'order', o.name,
           'cod', coalesce(o.is_cod, false),
           'amount_cents', case when coalesce(o.is_cod, false)
                                then coalesce(o.outstanding_cents, o.total_cents, 0) else 0 end,
           'source', case when not coalesce(o.is_cod, false) then 'prepaid'
                          when o.outstanding_cents is not null then 'outstanding'
                          when o.total_cents is not null then 'total'
                          else 'missing' end
         ) order by o.created_at_shopify nulls last, o.name, o.id)
    into v_n.reference, v_n.first_order_at, v_n.cod_breakdown
  from public.shipment_orders so join public.orders o on o.id = so.order_id
  where so.shipment_id = p_shipment_id;

  if not (v_ov ? 'cod_cents') then
    select coalesce(sum((e ->> 'amount_cents')::integer), 0) into v_n.cod_cents
    from jsonb_array_elements(v_n.cod_breakdown) e;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'order', o.name, 'sku', l.sku, 'name', l.name, 'quantity', l.quantity
         ) order by o.created_at_shopify nulls last, o.name, l.line_no), '[]'::jsonb)
    into v_n.contents
  from public.shipment_orders so
  join public.orders o on o.id = so.order_id
  join public.order_lines l on l.order_id = o.id
  where so.shipment_id = p_shipment_id and coalesce(l.requires_shipping, true);

  if not (v_ov ? 'recipient_name') then v_n.recipient_name := v_first.shipping_name; end if;
  if not (v_ov ? 'recipient_phone') then
    v_n.recipient_phone_raw := v_first.phone_raw;
    v_n.recipient_phone_norm := v_first.phone_norm;
  end if;
  if not (v_ov ? 'recipient_email') then v_n.recipient_email := v_first.email; end if;
  if not (v_ov ? 'address') then
    v_n.address1 := v_first.shipping_address1;
    v_n.address2 := v_first.shipping_address2;
    v_n.city := v_first.shipping_city;
    v_n.zip := v_first.shipping_zip;
  end if;

  if v_count > 1 then
    v_by := array_remove(array[
      case when exists (
        select 1 from public.shipment_orders a join public.orders oa on oa.id = a.order_id,
                      public.shipment_orders b join public.orders ob on ob.id = b.order_id
        where a.shipment_id = p_shipment_id and b.shipment_id = p_shipment_id
          and a.order_id < b.order_id and oa.phone_norm = ob.phone_norm
      ) then 'phone' end,
      case when exists (
        select 1 from public.shipment_orders a join public.orders oa on oa.id = a.order_id,
                      public.shipment_orders b join public.orders ob on ob.id = b.order_id
        where a.shipment_id = p_shipment_id and b.shipment_id = p_shipment_id
          and a.order_id < b.order_id and oa.email_norm = ob.email_norm
      ) then 'email' end,
      case when v_ov ? 'orders' then 'manual' end
    ], null);
  else
    v_by := '{}'::text[];
  end if;
  v_n.combined_by := v_by;

  if v_n is distinct from v_s then
    update public.shipments s set
      reference = v_n.reference,
      first_order_at = v_n.first_order_at,
      cod_breakdown = v_n.cod_breakdown,
      cod_cents = v_n.cod_cents,
      contents = v_n.contents,
      combined_by = v_n.combined_by,
      recipient_name = v_n.recipient_name,
      recipient_phone_raw = v_n.recipient_phone_raw,
      recipient_phone_norm = v_n.recipient_phone_norm,
      recipient_email = v_n.recipient_email,
      address1 = v_n.address1,
      address2 = v_n.address2,
      city = v_n.city,
      zip = v_n.zip
    where s.id = p_shipment_id;
  end if;

  -- Every difference between the combined orders becomes a (grey) flag on the shipment.
  foreach v_field in array array['name', 'phone', 'email']
  loop
    v_key := 'RECIPIENT_DIFFERS:' || v_field;
    select jsonb_agg(jsonb_build_object('order', o.name, 'value',
             case v_field when 'name' then o.shipping_name
                          when 'phone' then o.phone_raw
                          else o.email end)
             order by o.created_at_shopify nulls last, o.name)
      into v_values
    from public.shipment_orders so join public.orders o on o.id = so.order_id
    where so.shipment_id = p_shipment_id
      and (select count(distinct case v_field when 'name' then private.norm_key(x.shipping_name)
                                              when 'phone' then x.phone_norm
                                              else x.email_norm end)
           from public.shipment_orders sx join public.orders x on x.id = sx.order_id
           where sx.shipment_id = p_shipment_id) > 1;

    if v_values is not null then
      v_label_bg := case v_field when 'name' then 'имена' when 'phone' then 'телефони' else 'имейли' end;
      v_label_en := case v_field when 'name' then 'names' when 'phone' then 'phone numbers' else 'emails' end;
      select string_agg(coalesce(nullif(e ->> 'value', ''), '—') || ' (' || (e ->> 'order') || ')', ', ')
        into v_list from jsonb_array_elements(v_values) e;
      if not exists (select 1 from public.flags f
                     where f.shipment_id = p_shipment_id and f.issue_key = v_key) then
        insert into public.flags (shipment_id, severity, code, message_bg, message_en, reason_bg,
                                  reason_en, details, issue_key, origin)
        values (p_shipment_id, 'info', 'SHIPMENT_RECIPIENT_DIFFERS',
          'Обединените поръчки имат различни ' || v_label_bg || ': ' || v_list || '.',
          'The combined orders have different ' || v_label_en || ': ' || v_list || '.',
          'На етикета е най-ранната поръчка. Проверете, ако не сте сигурни.',
          'The label uses the earliest order. Check if you are not sure.',
          jsonb_build_object('field', v_field, 'values', v_values), v_key, 'shipments');
      else
        update public.flags f set
          message_bg = 'Обединените поръчки имат различни ' || v_label_bg || ': ' || v_list || '.',
          message_en = 'The combined orders have different ' || v_label_en || ': ' || v_list || '.',
          details = jsonb_build_object('field', v_field, 'values', v_values)
        where f.shipment_id = p_shipment_id and f.issue_key = v_key and f.resolved_at is null
          and f.details is distinct from jsonb_build_object('field', v_field, 'values', v_values);
      end if;
    else
      update public.flags f set
        resolved_at = now(),
        resolution_note = 'Вече не се отнася: пратката е променена. / No longer applies: the shipment changed.'
      where f.shipment_id = p_shipment_id and f.issue_key = v_key and f.resolved_at is null;
    end if;
  end loop;

  perform private.refresh_shipment_status(p_shipment_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- private.build_shipments — turns the orders of one batch into shipments.
--
--  P3-07 cancelled / fulfilled / nothing to ship -> no shipment, grey flag why
--  P3-02 same customer (phone_norm OR email_norm) + same destination, same batch -> one shipment
--  P3-03 same customer, different destinations, same batch -> separate + amber flag on each
--  P3-04 same customer + destination as an UNSENT shipment from another import -> separate
--        + amber "merge?" flag on both (one-click merge for the owner)
--  P3-05 same name only -> grey flag only
--  P3-06 same customer + destination as a shipment that already has a waybill -> separate
--        + flag; the old shipment is not touched
--  P3-08/09 same customer within settings.duplicate_window_hours: identical products -> red
--        on both orders; overlapping products -> amber on both
--  P3-14 status from the flags (private.refresh_shipment)
--
-- Orders already in a shipment are never moved (manual decisions stay, P3-13).
-- Returns {created, combined, excluded}.
-- ---------------------------------------------------------------------------
create or replace function private.build_shipments(p_batch_id uuid)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_o public.orders%rowtype;
  v_window interval;
  v_part record;
  v_r record;
  v_sid uuid;
  v_new uuid[] := '{}'::uuid[];
  v_touched uuid[] := '{}'::uuid[];
  v_flagged uuid[] := '{}'::uuid[];
  v_excluded integer := 0;
  v_combined integer := 0;
  v_names jsonb;
  v_ref_a text;
  v_ref_b text;
  v_set_a text[];
  v_set_b text[];
begin
  v_window := make_interval(hours => coalesce(
    (select (s.value #>> '{}')::integer from public.settings s where s.key = 'duplicate_window_hours'),
    48));

  create temp table if not exists happyhome_ship_plan (
    order_id uuid primary key,
    comp text not null,
    dest text,
    phone text,
    email text,
    name_key text,
    created timestamptz,
    name text not null,
    shipment_id uuid
  ) on commit drop;
  truncate pg_temp.happyhome_ship_plan;

  -- P3-07: what never goes into a shipment.
  for v_o in
    select o.* from public.import_batch_orders bo join public.orders o on o.id = bo.order_id
    where bo.batch_id = p_batch_id
      and not exists (select 1 from public.shipment_orders so where so.order_id = o.id)
    order by o.created_at_shopify nulls last, o.name
  loop
    if v_o.cancelled_at is not null then
      v_excluded := v_excluded + 1;
      perform private.add_flag(v_o.id, null, 'info', 'SHIPMENT_EXCLUDED_CANCELLED',
        'Не е включена в пратка: поръчката е отказана в Shopify.',
        'Not put in a shipment: the order is cancelled in Shopify.',
        'Отказана поръчка никога не се изпраща.',
        'A cancelled order is never shipped.',
        '{}'::jsonb, 'SHIPMENT_EXCLUDED_CANCELLED', p_batch_id);
    elsif lower(btrim(coalesce(v_o.fulfillment_status, ''))) = 'fulfilled' then
      v_excluded := v_excluded + 1;
      perform private.add_flag(v_o.id, null, 'info', 'SHIPMENT_EXCLUDED_FULFILLED',
        'Не е включена в пратка: в Shopify поръчката вече е изпратена („fulfilled“).',
        'Not put in a shipment: Shopify says the order is already fulfilled.',
        'Изпратена поръчка не се изпраща втори път.',
        'An order that was already sent is not sent again.',
        '{}'::jsonb, 'SHIPMENT_EXCLUDED_FULFILLED', p_batch_id);
    elsif not exists (select 1 from public.order_lines l
                      where l.order_id = v_o.id and coalesce(l.requires_shipping, true)) then
      v_excluded := v_excluded + 1;
      perform private.add_flag(v_o.id, null, 'info', 'SHIPMENT_EXCLUDED_NO_SHIPPING',
        'Не е включена в пратка: нито един продукт не изисква доставка.',
        'Not put in a shipment: no product needs shipping.',
        'В Shopify всеки ред е с „Lineitem requires shipping“ = false (напр. подаръчна карта).',
        'In Shopify every line has "Lineitem requires shipping" = false (e.g. a gift card).',
        '{}'::jsonb, 'SHIPMENT_EXCLUDED_NO_SHIPPING', p_batch_id);
    else
      insert into pg_temp.happyhome_ship_plan (order_id, comp, dest, phone, email, name_key, created, name)
      values (v_o.id, v_o.id::text,
              private.dest_of(v_o.shipping_address1, v_o.shipping_address2, v_o.shipping_city,
                              v_o.shipping_zip),
              v_o.phone_norm, v_o.email_norm, private.norm_key(v_o.shipping_name),
              v_o.created_at_shopify, v_o.name);
    end if;
  end loop;

  -- Same customer = same phone_norm OR same email_norm (never the name). Connected
  -- groups by label propagation: every order takes the smallest label of its matches.
  loop
    with m as (
      select a.order_id, min(b.comp) as mc
      from pg_temp.happyhome_ship_plan a
      join pg_temp.happyhome_ship_plan b on (a.phone = b.phone or a.email = b.email)
      group by a.order_id
    )
    update pg_temp.happyhome_ship_plan p set comp = m.mc
    from m where p.order_id = m.order_id and m.mc < p.comp;
    exit when not found;
  end loop;

  -- P3-02: one shipment per customer + destination (an order without an address stays alone).
  for v_part in
    select p.comp, p.dest, array_agg(p.order_id order by p.created nulls last, p.name) as ids,
           jsonb_agg(p.name order by p.created nulls last, p.name) as names
    from pg_temp.happyhome_ship_plan p
    where p.dest is not null
    group by p.comp, p.dest
    union all
    select p.comp, null, array[p.order_id], jsonb_build_array(p.name)
    from pg_temp.happyhome_ship_plan p
    where p.dest is null
  loop
    insert into public.shipments (status, source_batch_id, decision_reasons)
    values ('imported', p_batch_id, jsonb_build_array(
      case
        when cardinality(v_part.ids) > 1 then jsonb_build_object(
          'code', 'COMBINED_SAME_CUSTOMER_SAME_DESTINATION',
          'bg', 'Обединени: един клиент (същият телефон или имейл) и един и същ адрес или офис, в едно внасяне.',
          'en', 'Combined: one customer (same phone or email) and the same address or office, in one import.',
          'orders', v_part.names)
        when v_part.dest is null then jsonb_build_object(
          'code', 'NO_DESTINATION',
          'bg', 'Поръчката няма адрес, затова не се обединява с други.',
          'en', 'The order has no address, so it is not combined with others.',
          'orders', v_part.names)
        else jsonb_build_object(
          'code', 'ONE_ORDER',
          'bg', 'Една поръчка — една пратка.',
          'en', 'One order, one parcel.',
          'orders', v_part.names)
      end))
    returning id into v_sid;
    insert into public.shipment_orders (shipment_id, order_id, added_by)
    select v_sid, x, 'import' from unnest(v_part.ids) x;
    update pg_temp.happyhome_ship_plan p set shipment_id = v_sid where p.order_id = any (v_part.ids);
    v_new := v_new || v_sid;
    if cardinality(v_part.ids) > 1 then
      v_combined := v_combined + 1;
    end if;
    perform private.refresh_shipment(v_sid); -- reference etc. for the checks below
  end loop;

  -- P3-03: one customer, several destinations in this batch -> amber on each order.
  for v_r in
    select a.order_id, a.dest,
           jsonb_agg(jsonb_build_object('order_id', b.order_id, 'order', b.name,
                                        'shipment_id', b.shipment_id)
                     order by b.created nulls last, b.name) as related
    from pg_temp.happyhome_ship_plan a
    join pg_temp.happyhome_ship_plan b
      on b.comp = a.comp and b.order_id <> a.order_id and b.dest is not null
     and b.dest is distinct from a.dest
    where a.dest is not null
    group by a.order_id, a.dest
  loop
    perform private.add_flag(v_r.order_id, null, 'amber', 'CUSTOMER_DIFFERENT_ADDRESSES',
      'Един клиент, различни адреси — обадете се',
      'One customer, different addresses — call them',
      'Поръчките са от един клиент (същият телефон или имейл), но до различни адреси, затова не са обединени. Попитайте клиента къде да ги изпратите.',
      'The orders are from one customer (same phone or email) but to different addresses, so they were not combined. Ask the customer where to send them.',
      jsonb_build_object('related', v_r.related), 'CUSTOMER_DIFFERENT_ADDRESSES', p_batch_id);
    v_flagged := v_flagged || v_r.order_id;
  end loop;

  -- P3-04 / P3-06: the same customer + destination already has a shipment from before.
  for v_r in
    select distinct p.shipment_id as new_id, t.id as old_id, t.status as old_status,
           t.reference as old_ref, sn.reference as new_ref
    from pg_temp.happyhome_ship_plan p
    join public.shipments sn on sn.id = p.shipment_id
    join public.orders q on (q.phone_norm = p.phone or q.email_norm = p.email)
    join public.shipment_orders tq on tq.order_id = q.id
    join public.shipments t on t.id = tq.shipment_id
    where p.dest is not null
      and not (t.id = any (v_new))
      and private.dest_of(q.shipping_address1, q.shipping_address2, q.shipping_city, q.shipping_zip) = p.dest
      and (private.shipment_is_open(t.status) or t.status in ('waybill_created', 'printed', 'printed_draft'))
  loop
    if private.shipment_is_open(v_r.old_status) then
      perform private.add_flag(null, v_r.new_id, 'amber', 'MERGE_SUGGESTED',
        'Същият клиент има неизпратена пратка от друго внасяне (' || coalesce(v_r.old_ref, '—') || ') — да ги обединим?',
        'The same customer has an unsent shipment from another import (' || coalesce(v_r.old_ref, '—') || ') — merge them?',
        'Един клиент (същият телефон или имейл) и един и същ адрес, но от различни внасяния. Такива пратки не се обединяват сами — решете вие.',
        'One customer (same phone or email) and the same address, but from different imports. These are never combined automatically — you decide.',
        jsonb_build_object('other_shipment_id', v_r.old_id, 'other_reference', v_r.old_ref),
        'MERGE_SUGGESTED:' || v_r.old_id, p_batch_id);
      perform private.add_flag(null, v_r.old_id, 'amber', 'MERGE_SUGGESTED',
        'Същият клиент има неизпратена пратка от друго внасяне (' || coalesce(v_r.new_ref, '—') || ') — да ги обединим?',
        'The same customer has an unsent shipment from another import (' || coalesce(v_r.new_ref, '—') || ') — merge them?',
        'Един клиент (същият телефон или имейл) и един и същ адрес, но от различни внасяния. Такива пратки не се обединяват сами — решете вие.',
        'One customer (same phone or email) and the same address, but from different imports. These are never combined automatically — you decide.',
        jsonb_build_object('other_shipment_id', v_r.new_id, 'other_reference', v_r.new_ref),
        'MERGE_SUGGESTED:' || v_r.new_id, p_batch_id);
      v_touched := v_touched || v_r.old_id;
    else
      perform private.add_flag(null, v_r.new_id, 'amber', 'CUSTOMER_HAS_WAYBILLED_SHIPMENT',
        'Вече има създадена пратка за този клиент (' || coalesce(v_r.old_ref, '—') || ')',
        'A shipment already exists for this customer (' || coalesce(v_r.old_ref, '—') || ')',
        'Старата пратка вече има товарителница, затова не се променя. Новата поръчка е в отделна пратка.',
        'The older shipment already has a waybill, so it is not changed. The new order is in a separate shipment.',
        jsonb_build_object('other_shipment_id', v_r.old_id, 'other_reference', v_r.old_ref,
                           'other_status', v_r.old_status),
        'WAYBILLED:' || v_r.old_id, p_batch_id);
    end if;
  end loop;

  -- P3-05: the same name, but a different phone AND email -> grey flag only, on both.
  for v_r in
    select distinct p.order_id as a_id, p.name as a_name, q.id as b_id, q.name as b_name
    from pg_temp.happyhome_ship_plan p
    join public.orders q on q.id <> p.order_id and private.norm_key(q.shipping_name) = p.name_key
    where p.name_key is not null
      and coalesce(q.phone_norm = p.phone, false) = false
      and coalesce(q.email_norm = p.email, false) = false
      and (
        exists (select 1 from pg_temp.happyhome_ship_plan x where x.order_id = q.id)
        or exists (select 1 from public.shipment_orders so join public.shipments t on t.id = so.shipment_id
                   where so.order_id = q.id and private.shipment_is_open(t.status))
      )
  loop
    perform private.add_flag(v_r.a_id, null, 'info', 'SAME_NAME_DIFFERENT_CUSTOMER',
      'Същото име като поръчка ' || v_r.b_name || ' — вероятно различни хора',
      'Same name as order ' || v_r.b_name || ' — probably different people',
      'Имената са еднакви, но телефонът и имейлът са различни. Само по име поръчки никога не се обединяват.',
      'The names match, but the phone and the email differ. Orders are never combined on the name alone.',
      jsonb_build_object('related', jsonb_build_array(jsonb_build_object('order_id', v_r.b_id, 'order', v_r.b_name))),
      'SAME_NAME:' || v_r.b_id, p_batch_id);
    perform private.add_flag(v_r.b_id, null, 'info', 'SAME_NAME_DIFFERENT_CUSTOMER',
      'Същото име като поръчка ' || v_r.a_name || ' — вероятно различни хора',
      'Same name as order ' || v_r.a_name || ' — probably different people',
      'Имената са еднакви, но телефонът и имейлът са различни. Само по име поръчки никога не се обединяват.',
      'The names match, but the phone and the email differ. Orders are never combined on the name alone.',
      jsonb_build_object('related', jsonb_build_array(jsonb_build_object('order_id', v_r.a_id, 'order', v_r.a_name))),
      'SAME_NAME:' || v_r.a_id, p_batch_id);
    v_flagged := v_flagged || v_r.b_id;
  end loop;

  -- P3-08 / P3-09: two orders of one customer close together in time (across batches too).
  for v_r in
    select distinct p.order_id as a_id, q.id as b_id
    from pg_temp.happyhome_ship_plan p
    join public.orders q on q.id <> p.order_id and (q.phone_norm = p.phone or q.email_norm = p.email)
    where q.cancelled_at is null
      and p.created is not null
      and q.created_at_shopify is not null
      and q.created_at_shopify between p.created - v_window and p.created + v_window
  loop
    v_set_a := private.order_products(v_r.a_id);
    v_set_b := private.order_products(v_r.b_id);
    v_names := jsonb_build_array(private.order_summary(v_r.a_id), private.order_summary(v_r.b_id));
    select o.name into v_ref_a from public.orders o where o.id = v_r.a_id;
    select o.name into v_ref_b from public.orders o where o.id = v_r.b_id;
    if cardinality(v_set_a) > 0 and v_set_a = v_set_b then
      perform private.add_flag(v_r.a_id, null, 'red', 'DUPLICATE_ORDER_SUSPECTED',
        'Възможна грешка: две еднакви поръчки една след друга — обадете се преди изпращане',
        'Possible mistake: two identical orders one after the other — call before shipping',
        'Същият клиент е поръчал същите продукти (' || v_ref_a || ' и ' || v_ref_b || ') в рамките на '
          || extract(epoch from v_window)::integer / 3600 || ' часа. Често това е двойно натискане.',
        'The same customer ordered the same products (' || v_ref_a || ' and ' || v_ref_b || ') within '
          || extract(epoch from v_window)::integer / 3600 || ' hours. Often this is a double click.',
        jsonb_build_object('orders', v_names), 'DUPLICATE:' || v_r.b_id, p_batch_id);
      perform private.add_flag(v_r.b_id, null, 'red', 'DUPLICATE_ORDER_SUSPECTED',
        'Възможна грешка: две еднакви поръчки една след друга — обадете се преди изпращане',
        'Possible mistake: two identical orders one after the other — call before shipping',
        'Същият клиент е поръчал същите продукти (' || v_ref_b || ' и ' || v_ref_a || ') в рамките на '
          || extract(epoch from v_window)::integer / 3600 || ' часа. Често това е двойно натискане.',
        'The same customer ordered the same products (' || v_ref_b || ' and ' || v_ref_a || ') within '
          || extract(epoch from v_window)::integer / 3600 || ' hours. Often this is a double click.',
        jsonb_build_object('orders', jsonb_build_array(private.order_summary(v_r.b_id),
                                                       private.order_summary(v_r.a_id))),
        'DUPLICATE:' || v_r.a_id, p_batch_id);
      v_flagged := v_flagged || v_r.b_id;
    elsif private.order_product_keys(v_r.a_id) && private.order_product_keys(v_r.b_id) then
      perform private.add_flag(v_r.a_id, null, 'amber', 'SIMILAR_ORDER_SUSPECTED',
        'Подобни поръчки една след друга (' || v_ref_a || ' и ' || v_ref_b || ') — проверете дали клиентът не е поръчал два пъти',
        'Similar orders one after the other (' || v_ref_a || ' and ' || v_ref_b || ') — check that the customer did not order twice',
        'Същият клиент има поръчки с общи продукти в рамките на '
          || extract(epoch from v_window)::integer / 3600 || ' часа.',
        'The same customer has orders with products in common within '
          || extract(epoch from v_window)::integer / 3600 || ' hours.',
        jsonb_build_object('orders', v_names), 'SIMILAR:' || v_r.b_id, p_batch_id);
      perform private.add_flag(v_r.b_id, null, 'amber', 'SIMILAR_ORDER_SUSPECTED',
        'Подобни поръчки една след друга (' || v_ref_b || ' и ' || v_ref_a || ') — проверете дали клиентът не е поръчал два пъти',
        'Similar orders one after the other (' || v_ref_b || ' and ' || v_ref_a || ') — check that the customer did not order twice',
        'Същият клиент има поръчки с общи продукти в рамките на '
          || extract(epoch from v_window)::integer / 3600 || ' часа.',
        'The same customer has orders with products in common within '
          || extract(epoch from v_window)::integer / 3600 || ' hours.',
        jsonb_build_object('orders', jsonb_build_array(private.order_summary(v_r.b_id),
                                                       private.order_summary(v_r.a_id))),
        'SIMILAR:' || v_r.a_id, p_batch_id);
      v_flagged := v_flagged || v_r.b_id;
    end if;
  end loop;

  -- Values and status of every shipment this batch touched (also orders that changed).
  for v_sid in
    select distinct so.shipment_id
    from public.shipment_orders so
    where so.order_id = any (v_flagged)
       or so.order_id in (select bo.order_id from public.import_batch_orders bo
                          where bo.batch_id = p_batch_id)
    union
    select unnest(v_touched || v_new)
  loop
    perform private.refresh_shipment(v_sid);
  end loop;

  return jsonb_build_object('created', cardinality(v_new), 'combined', v_combined,
                            'excluded', v_excluded);
end;
$$;

-- ---------------------------------------------------------------------------
-- public.import_commit — one batch, one transaction (P2-15), now also building the
-- shipments of the batch (Phase 3, private.build_shipments) in the same transaction.
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
--   cancelled since then -> red flag. Its shipment: every order cancelled -> 'cancelled'
--                           (unless handed over); still open -> the order is taken out
--                           (T3-10); waybill already created -> red flag on the shipment
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
  v_removed_from jsonb;
  v_ship public.shipments%rowtype;
  v_built jsonb;
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
                 or s.status in ('waybill_created', 'printed', 'printed_draft', 'handed_over',
                                 'delivered', 'returned'))
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
          v_cancelled_shipments := '[]'::jsonb;
          v_removed_from := '[]'::jsonb;
          for v_ship in
            select s.* from public.shipments s
            join public.shipment_orders so on so.shipment_id = s.id
            where so.order_id = v_order_id
            for update of s
          loop
            if v_ship.status in ('handed_over', 'delivered', 'returned', 'cancelled') then
              null; -- the flag below says it was already handed over
            elsif not exists (
              select 1 from public.shipment_orders so2 join public.orders o2 on o2.id = so2.order_id
              where so2.shipment_id = v_ship.id and o2.cancelled_at is null
            ) then
              -- Every order of the parcel is cancelled: the parcel is cancelled.
              update public.shipments s set status = 'cancelled', cancelled_at = now()
              where s.id = v_ship.id;
              v_cancelled_shipments := v_cancelled_shipments || to_jsonb(v_ship.id);
            elsif private.shipment_is_open(v_ship.status) then
              -- T3-10: other orders still travel; take only this one out.
              delete from public.shipment_orders so
              where so.shipment_id = v_ship.id and so.order_id = v_order_id;
              perform private.refresh_shipment(v_ship.id);
              v_removed_from := v_removed_from || jsonb_build_array(jsonb_build_object(
                'shipment_id', v_ship.id, 'reference', v_ship.reference));
            else
              -- A waybill exists: never change it automatically (P3-06).
              perform private.add_flag(null, v_ship.id, 'red', 'SHIPMENT_CONTAINS_CANCELLED_ORDER',
                'Поръчка ' || (v_order ->> 'name') || ' от тази пратка е отказана, но товарителницата вече е създадена — наложеният платеж и съдържанието вече не са верни.',
                'Order ' || (v_order ->> 'name') || ' in this shipment was cancelled, but the waybill already exists — the COD amount and the contents are no longer right.',
                'Товарителница не се променя автоматично. Коригирайте или анулирайте товарителницата при куриера.',
                'A waybill is never changed automatically. Correct or cancel the waybill with the courier.',
                jsonb_build_object('order_id', v_order_id, 'order', v_order ->> 'name'),
                'CANCELLED_IN_WAYBILL:' || v_order_id, p_batch_id);
            end if;
          end loop;
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
              || case when v_removed_from <> '[]'::jsonb
                   then ' Махната е от пратка ' || coalesce(v_removed_from -> 0 ->> 'reference', '') || '.'
                   else '' end
              || case when v_handed_over
                   then ' Пратката вече е предадена на куриера — свържете се с куриера, за да я спре.'
                   else '' end,
            'The order was cancelled in Shopify after it was imported — do not ship it.'
              || case when v_removed_from <> '[]'::jsonb
                   then ' It was taken out of shipment ' || coalesce(v_removed_from -> 0 ->> 'reference', '') || '.'
                   else '' end
              || case when v_handed_over
                   then ' The parcel was already handed over — contact the courier to stop it.'
                   else '' end,
            'Отказана поръчка не се изпраща.',
            'A cancelled order is never shipped.',
            jsonb_build_object('diff', v_diff, 'cancelled_shipments', v_cancelled_shipments,
                               'removed_from', v_removed_from,
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

  -- Phase 3: shipments for the orders of this batch (same transaction).
  v_built := private.build_shipments(p_batch_id);

  select count(distinct bo.order_id) into v_to_check
  from public.import_batch_orders bo
  join public.flags f on f.order_id = bo.order_id
  where bo.batch_id = p_batch_id and f.resolved_at is null and f.severity in ('red', 'amber');

  update public.import_batches b set
    orders_new = v_new,
    orders_updated = v_updated,
    orders_unchanged = v_unchanged,
    orders_skipped = v_skipped,
    orders_to_check = v_to_check,
    summary = b.summary || jsonb_build_object('shipments', v_built)
  where b.id = p_batch_id;

  return jsonb_build_object(
    'batch_id', p_batch_id,
    'new', v_new,
    'updated', v_updated,
    'unchanged', v_unchanged,
    'skipped', v_skipped,
    'to_check', v_to_check,
    'shipments', v_built
  );
end;
$$;

revoke all on function public.import_commit(uuid, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.import_commit(uuid, uuid, text, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- Manual controls, owner only (P3-10 … P3-13). Each one checks the role itself and
-- writes an explicit audit_log row with the reason, next to the trigger rows.
-- Optional p_*_version: the versions the owner saw when confirming (409 if changed).
-- ---------------------------------------------------------------------------

-- P3-10: move one order out of its shipment into a shipment of its own.
create or replace function public.shipment_split(p_order_id uuid, p_shipment_version integer default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old public.shipments%rowtype;
  v_new uuid;
  v_name text;
  v_count integer;
begin
  if not (select private.is_owner()) then
    raise exception 'owner_only' using errcode = '42501';
  end if;
  select s.* into v_old
  from public.shipments s join public.shipment_orders so on so.shipment_id = s.id
  where so.order_id = p_order_id
  for update of s;
  if not found then
    raise exception 'not_in_shipment' using errcode = 'P0002';
  end if;
  if p_shipment_version is not null and p_shipment_version <> v_old.version then
    raise exception 'version_conflict' using errcode = 'PT409';
  end if;
  if not private.shipment_is_open(v_old.status) then
    raise exception 'shipment_locked' using errcode = '55000';
  end if;
  select count(*) into v_count from public.shipment_orders so where so.shipment_id = v_old.id;
  if v_count < 2 then
    raise exception 'single_order' using errcode = '22023';
  end if;
  select o.name into v_name from public.orders o where o.id = p_order_id;

  insert into public.shipments (status, source_batch_id, manual_overrides, decision_reasons)
  values ('imported', v_old.source_batch_id, jsonb_build_object('orders', true),
    jsonb_build_array(jsonb_build_object(
      'code', 'MANUAL_SPLIT',
      'bg', 'Ръчно отделена от пратка ' || coalesce(v_old.reference, '—') || '.',
      'en', 'Split out of shipment ' || coalesce(v_old.reference, '—') || ' by hand.',
      'by', auth.uid(), 'at', now())))
  returning id into v_new;
  update public.shipment_orders so set shipment_id = v_new, added_by = 'manual'
  where so.order_id = p_order_id;
  update public.shipments s set
    manual_overrides = s.manual_overrides || jsonb_build_object('orders', true),
    decision_reasons = s.decision_reasons || jsonb_build_array(jsonb_build_object(
      'code', 'MANUAL_SPLIT_FROM',
      'bg', 'Поръчка ' || v_name || ' е отделена ръчно в своя пратка.',
      'en', 'Order ' || v_name || ' was split out into its own shipment by hand.',
      'by', auth.uid(), 'at', now()))
  where s.id = v_old.id;

  perform private.refresh_shipment(v_old.id);
  perform private.refresh_shipment(v_new);

  insert into public.audit_log (actor, updated_by, table_name, row_id, action, before, after, reason)
  values (auth.uid(), auth.uid(), 'shipment_orders', p_order_id, 'update',
          jsonb_build_object('shipment_id', v_old.id, 'reference', v_old.reference, 'order', v_name),
          jsonb_build_object('shipment_id', v_new, 'order', v_name),
          'manual_split');
  return v_new;
end;
$$;

-- P3-11: put every order of p_source into p_target; p_source is removed.
create or replace function public.shipment_merge(
  p_target uuid,
  p_source uuid,
  p_target_version integer default null,
  p_source_version integer default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_t public.shipments%rowtype;
  v_s public.shipments%rowtype;
begin
  if not (select private.is_owner()) then
    raise exception 'owner_only' using errcode = '42501';
  end if;
  if p_target = p_source then
    raise exception 'same_shipment' using errcode = '22023';
  end if;
  perform 1 from public.shipments s where s.id in (p_target, p_source) order by s.id for update;
  select * into v_t from public.shipments s where s.id = p_target;
  select * into v_s from public.shipments s where s.id = p_source;
  if v_t.id is null or v_s.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if (p_target_version is not null and p_target_version <> v_t.version)
     or (p_source_version is not null and p_source_version <> v_s.version) then
    raise exception 'version_conflict' using errcode = 'PT409';
  end if;
  if not private.shipment_is_open(v_t.status) or not private.shipment_is_open(v_s.status) then
    raise exception 'shipment_locked' using errcode = '55000';
  end if;

  update public.shipment_orders so set shipment_id = p_target, added_by = 'manual'
  where so.shipment_id = p_source;

  -- The source's own flags move to the target (unless the target already has the same one);
  -- the merge suggestion between the two is now done.
  delete from public.flags f
  where f.shipment_id = p_source
    and (f.code = 'SHIPMENT_RECIPIENT_DIFFERS'
         or exists (select 1 from public.flags x
                    where x.shipment_id = p_target and x.issue_key = f.issue_key));
  update public.flags f set shipment_id = p_target where f.shipment_id = p_source;
  update public.flags f set
    resolved_at = now(),
    resolved_by = auth.uid(),
    resolution_note = 'Обединени ръчно. / Merged by hand.'
  where f.shipment_id = p_target and f.code = 'MERGE_SUGGESTED' and f.resolved_at is null
    and f.issue_key in ('MERGE_SUGGESTED:' || p_source, 'MERGE_SUGGESTED:' || p_target);
  -- Suggestions elsewhere that pointed at the source now point at the target.
  update public.flags f set
    details = f.details || jsonb_build_object('other_shipment_id', p_target),
    issue_key = 'MERGE_SUGGESTED:' || p_target
  where f.code = 'MERGE_SUGGESTED' and f.issue_key = 'MERGE_SUGGESTED:' || p_source
    and f.shipment_id <> p_target
    and not exists (select 1 from public.flags x
                    where x.shipment_id = f.shipment_id and x.issue_key = 'MERGE_SUGGESTED:' || p_target);

  update public.shipments s set
    manual_overrides = s.manual_overrides || jsonb_build_object('orders', true),
    decision_reasons = s.decision_reasons || jsonb_build_array(jsonb_build_object(
      'code', 'MANUAL_MERGE',
      'bg', 'Ръчно обединена с пратка ' || coalesce(v_s.reference, '—') || '.',
      'en', 'Merged with shipment ' || coalesce(v_s.reference, '—') || ' by hand.',
      'by', auth.uid(), 'at', now()))
  where s.id = p_target;

  insert into public.audit_log (actor, updated_by, table_name, row_id, action, before, after, reason)
  values (auth.uid(), auth.uid(), 'shipments', p_target, 'update',
          jsonb_build_object('target', p_target, 'target_reference', v_t.reference,
                             'source', p_source, 'source_reference', v_s.reference),
          jsonb_build_object('shipment_id', p_target),
          'manual_merge');

  delete from public.shipments s where s.id = p_source;
  perform private.refresh_shipment(p_target);
  return p_target;
end;
$$;

-- "Остави ги отделно": the merge suggestion between two shipments is answered (remembered).
create or replace function public.shipment_keep_apart(p_shipment_a uuid, p_shipment_b uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not (select private.is_owner()) then
    raise exception 'owner_only' using errcode = '42501';
  end if;
  update public.flags f set
    resolved_at = now(),
    resolved_by = auth.uid(),
    resolution_note = 'Оставени отделно (решение на собственика). / Kept apart (owner''s decision).'
  where f.code = 'MERGE_SUGGESTED' and f.resolved_at is null
    and ((f.shipment_id = p_shipment_a and f.issue_key = 'MERGE_SUGGESTED:' || p_shipment_b)
      or (f.shipment_id = p_shipment_b and f.issue_key = 'MERGE_SUGGESTED:' || p_shipment_a));
  perform private.refresh_shipment_status(p_shipment_a);
  perform private.refresh_shipment_status(p_shipment_b);
end;
$$;

-- ---------------------------------------------------------------------------
-- The Пратки list: one row per shipment, with its orders and open flag counts
-- (on the shipment and on its orders). security_invoker: the caller's RLS applies.
-- ---------------------------------------------------------------------------
create view public.shipment_overview
with (security_invoker = true)
as
select
  s.id, s.created_at, s.updated_at, s.version, s.status, s.reference, s.combined_by,
  s.recipient_name, s.recipient_phone_raw, s.recipient_phone_norm, s.recipient_email,
  s.address1, s.address2, s.city, s.zip, s.cod_cents, s.cod_breakdown, s.contents,
  s.first_order_at, s.source_batch_id, s.manual_overrides, s.decision_reasons,
  coalesce(o.order_count, 0) as order_count,
  coalesce(o.orders, '[]'::jsonb) as orders,
  coalesce(f.red, 0) as flags_red,
  coalesce(f.amber, 0) as flags_amber,
  coalesce(f.info, 0) as flags_info
from public.shipments s
left join lateral (
  select count(*)::integer as order_count,
         jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name,
                                      'created_at_shopify', o.created_at_shopify)
                   order by o.created_at_shopify nulls last, o.name) as orders
  from public.shipment_orders so join public.orders o on o.id = so.order_id
  where so.shipment_id = s.id
) o on true
left join lateral (
  select count(*) filter (where fl.severity = 'red')::integer as red,
         count(*) filter (where fl.severity = 'amber')::integer as amber,
         count(*) filter (where fl.severity = 'info')::integer as info
  from public.flags fl
  where fl.resolved_at is null
    and (fl.shipment_id = s.id
         or fl.order_id in (select so.order_id from public.shipment_orders so
                            where so.shipment_id = s.id))
) f on true;

revoke all on public.shipment_overview from public, anon;
grant select on public.shipment_overview to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Function privileges: helpers are internal; the RPCs are for signed-in users
-- (they check the owner role themselves).
-- ---------------------------------------------------------------------------
revoke all on function private.norm_key(text) from public, anon, authenticated;
revoke all on function private.dest_of(text, text, text, text) from public, anon, authenticated;
revoke all on function private.order_products(uuid) from public, anon, authenticated;
revoke all on function private.order_product_keys(uuid) from public, anon, authenticated;
revoke all on function private.shipment_is_open(text) from public, anon, authenticated;
revoke all on function private.order_summary(uuid) from public, anon, authenticated;
revoke all on function private.add_flag(uuid, uuid, text, text, text, text, text, text, jsonb, text, uuid)
  from public, anon, authenticated;
revoke all on function private.refresh_shipment_status(uuid) from public, anon, authenticated;
revoke all on function private.refresh_shipment(uuid) from public, anon, authenticated;
revoke all on function private.build_shipments(uuid) from public, anon, authenticated;

revoke all on function public.shipment_split(uuid, integer) from public, anon;
revoke all on function public.shipment_merge(uuid, uuid, integer, integer) from public, anon;
revoke all on function public.shipment_keep_apart(uuid, uuid) from public, anon;
grant execute on function public.shipment_split(uuid, integer) to authenticated;
grant execute on function public.shipment_merge(uuid, uuid, integer, integer) to authenticated;
grant execute on function public.shipment_keep_apart(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Backfill: shipments for the orders imported before Phase 3, batch by batch in
-- import order — the same result as if Phase 3 had been there from the start.
-- ---------------------------------------------------------------------------
do $$
declare
  v_batch record;
begin
  for v_batch in select b.id from public.import_batches b order by b.created_at, b.id
  loop
    perform private.build_shipments(v_batch.id);
  end loop;
end;
$$;
