-- Phase 5: delivery point detection and certainty.
--
-- The decision itself is made in packages/core (src/detect), run by the detect-delivery Edge
-- Function (it needs the geocoder). This migration stores it on the shipment, turns an uncertain
-- or wrong destination into a flag (so the Phase 3 status rule sends the shipment to "За
-- проверка"), records the calls, and lets a member confirm or change the destination.
--
-- Owner decision (14 Nov 2026): the owner AND the packers (the parents) make the calls, so the
-- call functions are open to every member, not only the owner.

-- ---------------------------------------------------------------------------
-- 1. The decision on the shipment
-- ---------------------------------------------------------------------------
alter table public.shipments
  add column delivery_certainty text
    check (delivery_certainty in ('certain', 'uncertain', 'error')),
  add column delivery_rule text check (delivery_rule in ('A', 'B', 'C', 'D', 'E', 'F', 'manual')),
  add column delivery_reasons jsonb not null default '[]'::jsonb,
  add column delivery_hints jsonb not null default '[]'::jsonb,
  add column delivery_suggestion jsonb,
  add column delivery_alternatives jsonb not null default '[]'::jsonb,
  add column delivery_detected_at timestamptz,
  -- true = the address changed since the last decision (or there was none): detect again
  add column delivery_dirty boolean not null default true,
  add column geo_lat double precision,
  add column geo_lng double precision,
  add column geo_precision text check (geo_precision in ('street', 'block', 'quarter', 'city'));

comment on column public.shipments.delivery_suggestion is
  'Rules C/D/E: the office or locker to propose on the call {id, carrier, type, name_bg, address_text, distance_km}.';
comment on column public.shipments.delivery_dirty is
  'The address (or a note) changed since the last detection; detect-delivery picks these up.';

create index shipments_delivery_dirty_idx on public.shipments (created_at) where delivery_dirty;

-- An address or note edit makes the decision stale (P5-18). A destination a person chose by hand
-- (manual_overrides.delivery) is still never changed by the detection (P5-19).
create or replace function private.shipment_mark_dirty()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.address1, new.address2, new.city, new.zip, new.notes)
     is distinct from (old.address1, old.address2, old.city, old.zip, old.notes) then
    new.delivery_dirty := true;
  end if;
  return new;
end;
$$;
create trigger shipment_mark_dirty before update on public.shipments
for each row execute function private.shipment_mark_dirty();

-- The customer's note and Shipping Company are read too: a re-import that changes them counts.
create or replace function private.order_mark_shipment_dirty()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.notes, new.shipping_company) is distinct from (old.notes, old.shipping_company) then
    update public.shipments s set delivery_dirty = true
    where s.id in (select so.shipment_id from public.shipment_orders so where so.order_id = new.id)
      and not s.delivery_dirty;
  end if;
  return new;
end;
$$;
create trigger order_mark_shipment_dirty after update on public.orders
for each row execute function private.order_mark_shipment_dirty();

-- ---------------------------------------------------------------------------
-- 2. Calls (P5-20, P5-21)
-- ---------------------------------------------------------------------------
create table public.shipment_calls (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  shipment_id uuid not null references public.shipments (id) on delete cascade,
  outcome text not null
    check (outcome in ('confirmed', 'other_point', 'home_address', 'no_answer', 'refused')),
  point_id uuid references public.courier_offices (id) on delete set null,
  note text,
  called_by uuid default auth.uid()
);
comment on table public.shipment_calls is
  'One row per call outcome button press: who, when, what the customer said.';
create index shipment_calls_shipment_idx on public.shipment_calls (shipment_id, created_at);

create trigger set_row_meta before insert or update on public.shipment_calls
for each row execute function private.set_row_meta();
create trigger audit_row after insert or update or delete on public.shipment_calls
for each row execute function private.audit_row();

alter table public.shipment_calls enable row level security;
create policy shipment_calls_select on public.shipment_calls
  for select to authenticated using ((select private.is_member()));
-- Written only through delivery_call_outcome().
grant select on public.shipment_calls to authenticated;
grant all on public.shipment_calls to service_role;
alter publication supabase_realtime add table public.shipment_calls;

-- ---------------------------------------------------------------------------
-- 3. Settings (Phase 5 owner decisions: 1 km, Econt on a tie). Only rows nobody changed by hand.
-- ---------------------------------------------------------------------------
update public.settings set value = '1'::jsonb
where key = 'office_range_km' and value = '5'::jsonb and updated_by is null;
update public.settings set value = '"econt"'::jsonb
where key = 'home_carrier_tie_break' and value = '"speedy"'::jsonb and updated_by is null;
insert into public.settings (key, value, description) values
  ('detection_dictionary', '{}'::jsonb,
   'Extra detection words added by the owner, per category: econt, speedy, other, office, locker, home.')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 4. Flags: an uncertain destination = amber "Обадете се", an error = red "Грешка"
-- ---------------------------------------------------------------------------
create or replace function private.set_delivery_flag(
  p_shipment_id uuid,
  p_certainty text,
  p_reason_bg text,
  p_reason_en text,
  p_note text
)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_flag uuid;
begin
  select f.id into v_flag from public.flags f
  where f.shipment_id = p_shipment_id and f.issue_key = 'delivery' and f.resolved_at is null
  limit 1;

  if p_certainty in ('uncertain', 'error') then
    if v_flag is null then
      insert into public.flags (
        shipment_id, severity, code, message_bg, message_en, reason_bg, reason_en, issue_key, origin
      ) values (
        p_shipment_id,
        case when p_certainty = 'error' then 'red' else 'amber' end,
        case when p_certainty = 'error' then 'delivery_error' else 'delivery_call' end,
        case when p_certainty = 'error' then 'Грешка в доставката — обадете се'
             else 'Обадете се: не е ясно къде да изпратим пратката' end,
        case when p_certainty = 'error' then 'Delivery error — call the customer'
             else 'Call: it is not clear where to send the parcel' end,
        p_reason_bg, p_reason_en, 'delivery', 'detection'
      );
    else
      update public.flags f set
        severity = case when p_certainty = 'error' then 'red' else 'amber' end,
        code = case when p_certainty = 'error' then 'delivery_error' else 'delivery_call' end,
        message_bg = case when p_certainty = 'error' then 'Грешка в доставката — обадете се'
                          else 'Обадете се: не е ясно къде да изпратим пратката' end,
        message_en = case when p_certainty = 'error' then 'Delivery error — call the customer'
                          else 'Call: it is not clear where to send the parcel' end,
        reason_bg = p_reason_bg,
        reason_en = p_reason_en
      where f.id = v_flag
        and (f.severity, f.code, f.reason_bg) is distinct from (
          case when p_certainty = 'error' then 'red' else 'amber' end,
          case when p_certainty = 'error' then 'delivery_error' else 'delivery_call' end,
          p_reason_bg);
    end if;
  elsif v_flag is not null then
    update public.flags f set resolved_at = now(), resolved_by = auth.uid(), resolution_note = p_note
    where f.id = v_flag;
  end if;
  perform private.refresh_shipment_status(p_shipment_id);
end;
$$;
revoke all on function private.set_delivery_flag(uuid, text, text, text, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. Service functions for detect-delivery
-- ---------------------------------------------------------------------------

-- Shipments to detect, with everything the detection reads (P5-01): the address of the shipment,
-- the Company and customer notes of its orders, the internal comment (shipments.notes).
create or replace function public.delivery_pending(p_limit integer default 50, p_ids uuid[] default null)
returns table (
  id uuid, version integer, address1 text, address2 text, city text, zip text, country text,
  company text, notes text[], shipping_method text, reference text, manual boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select s.id, s.version, s.address1, s.address2, s.city, s.zip,
         (select o.shipping_country from public.shipment_orders so
            join public.orders o on o.id = so.order_id
          where so.shipment_id = s.id order by o.created_at_shopify nulls last limit 1),
         (select string_agg(distinct nullif(btrim(o.shipping_company), ''), ' , ')
            from public.shipment_orders so join public.orders o on o.id = so.order_id
          where so.shipment_id = s.id),
         array_remove(array(
           select distinct nullif(btrim(o.notes), '') from public.shipment_orders so
             join public.orders o on o.id = so.order_id where so.shipment_id = s.id
         ) || nullif(btrim(s.notes), ''), null),
         (select o.shipping_method from public.shipment_orders so
            join public.orders o on o.id = so.order_id
          where so.shipment_id = s.id order by o.created_at_shopify nulls last limit 1),
         s.reference,
         s.manual_overrides ? 'delivery'
  from public.shipments s
  where (p_ids is null and s.delivery_dirty or s.id = any (p_ids))
    and s.status in ('imported', 'needs_check', 'ready')
  order by s.created_at
  limit greatest(1, least(coalesce(p_limit, 50), 500));
$$;

-- Store a decision. Skipped when the shipment changed since it was read (the next run detects
-- again) and never touches a destination a person chose (P5-19).
create or replace function public.delivery_apply(p_shipment_id uuid, p_version integer, p_decision jsonb)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_s public.shipments%rowtype;
  v_certainty text := p_decision->>'certainty';
  v_point uuid := nullif(p_decision->>'office_id', '')::uuid;
  v_first jsonb := p_decision->'reasons'->0;
begin
  select * into v_s from public.shipments s where s.id = p_shipment_id for update;
  if not found then
    return 'missing';
  end if;
  if v_s.version <> p_version then
    return 'stale';
  end if;
  if v_s.manual_overrides ? 'delivery' then
    update public.shipments s set delivery_dirty = false where s.id = p_shipment_id;
    return 'manual';
  end if;
  if v_certainty not in ('certain', 'uncertain', 'error') then
    raise exception 'bad_decision' using errcode = '22023';
  end if;
  if v_point is not null and not exists (
    select 1 from public.courier_offices o where o.id = v_point and o.active
  ) then
    raise exception 'unknown_point' using errcode = '22023';
  end if;

  update public.shipments s set
    carrier = p_decision->>'carrier',
    delivery_type = p_decision->>'delivery_type',
    office_id = v_point,
    delivery_certainty = v_certainty,
    delivery_rule = p_decision->>'rule',
    delivery_reasons = coalesce(p_decision->'reasons', '[]'::jsonb),
    delivery_hints = coalesce(p_decision->'hints', '[]'::jsonb),
    delivery_suggestion = p_decision->'suggestion',
    delivery_alternatives = coalesce(p_decision->'alternatives', '[]'::jsonb),
    delivery_detected_at = now(),
    delivery_dirty = false,
    geo_lat = (p_decision->'geo'->>'lat')::double precision,
    geo_lng = (p_decision->'geo'->>'lng')::double precision,
    geo_precision = p_decision->'geo'->>'precision'
  where s.id = p_shipment_id;

  perform private.set_delivery_flag(
    p_shipment_id, v_certainty, v_first->>'bg', v_first->>'en',
    'Доставката е изяснена автоматично');
  return 'applied';
end;
$$;

-- Points of a courier by ID or code ("автомат 123"): for the detection.
create or replace function public.points_by_code(p_carrier text, p_codes text[])
returns table (
  id uuid, carrier text, external_id text, code text, type text, name_bg text, city text,
  postcode text, address_text text, lat double precision, lng double precision)
language sql
stable
security invoker
set search_path = ''
as $$
  select o.id, o.carrier, o.external_id, o.code, o.type, o.name_bg, o.city, o.postcode,
         o.address_text, o.lat, o.lng
  from public.courier_offices o
  where o.active and o.carrier = p_carrier
    and (o.external_id = any (p_codes) or o.code = any (p_codes))
  limit 20;
$$;

-- ---------------------------------------------------------------------------
-- 6. Member functions: call outcomes and address edits
-- ---------------------------------------------------------------------------

-- P5-21. confirmed = the suggestion (or the home address) is right; other_point = the person picked
-- an office / locker (also the manual picker of rule F); home_address = deliver to the address;
-- no_answer = only counted; refused = the customer cancels (a reason is required).
-- Every outcome except no_answer is a destination chosen by a person: manual_overrides.delivery.
create or replace function public.delivery_call_outcome(
  p_shipment_id uuid,
  p_outcome text,
  p_point_id uuid default null,
  p_note text default null,
  p_version integer default null
)
returns public.shipments
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_s public.shipments%rowtype;
  v_point public.courier_offices%rowtype;
  v_by text;
  v_override jsonb;
  v_reason_bg text;
  v_reason_en text;
begin
  if not (select private.is_member()) then
    raise exception 'members_only' using errcode = '42501';
  end if;
  select * into v_s from public.shipments s where s.id = p_shipment_id for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if p_version is not null and v_s.version <> p_version then
    raise exception 'version_conflict' using errcode = 'PT409';
  end if;
  if v_s.status not in ('imported', 'needs_check', 'ready') then
    raise exception 'shipment_locked' using errcode = '55000';
  end if;
  if p_outcome not in ('confirmed', 'other_point', 'home_address', 'no_answer', 'refused') then
    raise exception 'bad_outcome' using errcode = '22023';
  end if;
  if p_outcome = 'refused' and nullif(btrim(p_note), '') is null then
    raise exception 'reason_required' using errcode = '22023';
  end if;

  select coalesce(m.display_name, '?') into v_by from public.members m where m.user_id = auth.uid();

  if p_outcome = 'confirmed' and v_s.delivery_suggestion is not null then
    p_point_id := (v_s.delivery_suggestion->>'id')::uuid;
  end if;
  if p_outcome in ('other_point') or (p_outcome = 'confirmed' and p_point_id is not null) then
    select * into v_point from public.courier_offices o where o.id = p_point_id and o.active;
    if not found then
      raise exception 'unknown_point' using errcode = '22023';
    end if;
  end if;
  if p_outcome = 'confirmed' and p_point_id is null and v_s.delivery_type is distinct from 'address' then
    raise exception 'nothing_to_confirm' using errcode = '22023';
  end if;

  insert into public.shipment_calls (shipment_id, outcome, point_id, note)
  values (p_shipment_id, p_outcome, p_point_id, nullif(btrim(p_note), ''));

  if p_outcome = 'no_answer' then
    return v_s;
  end if;

  v_override := jsonb_build_object('by', auth.uid(), 'at', now(), 'how', p_outcome);

  if p_outcome = 'refused' then
    update public.shipments s set
      status = 'cancelled',
      cancelled_at = now(),
      manual_overrides = s.manual_overrides
        || jsonb_build_object('status', v_override || jsonb_build_object('reason', btrim(p_note)))
    where s.id = p_shipment_id
    returning * into v_s;
    update public.flags f set resolved_at = now(), resolved_by = auth.uid(),
      resolution_note = 'Клиентът отказа поръчката: ' || btrim(p_note)
    where f.shipment_id = p_shipment_id and f.issue_key = 'delivery' and f.resolved_at is null;
    return v_s;
  end if;

  if v_point.id is not null then
    v_reason_bg := format('Избрано по телефона от %s: %s %s.', v_by,
      case v_point.carrier when 'econt' then 'Еконт' else 'Спиди' end, v_point.name_bg);
    v_reason_en := format('Chosen on the phone by %s: %s %s.', v_by,
      case v_point.carrier when 'econt' then 'Econt' else 'Speedy' end, v_point.name_bg);
    update public.shipments s set
      carrier = v_point.carrier,
      delivery_type = case when v_point.type = 'locker' then 'locker' else 'office' end,
      office_id = v_point.id
    where s.id = p_shipment_id;
  else
    -- home address (or confirming a home-address suggestion)
    v_reason_bg := format('Доставка до адрес, потвърдено по телефона от %s.', v_by);
    v_reason_en := format('Delivery to the address, confirmed on the phone by %s.', v_by);
    update public.shipments s set
      carrier = coalesce(s.carrier,
        (select st.value #>> '{}' from public.settings st where st.key = 'home_carrier_tie_break'),
        'econt'),
      delivery_type = 'address',
      office_id = null
    where s.id = p_shipment_id;
  end if;

  update public.shipments s set
    delivery_certainty = 'certain',
    delivery_rule = 'manual',
    delivery_reasons = jsonb_build_array(jsonb_build_object(
      'code', 'confirmed_by_phone', 'bg', v_reason_bg, 'en', v_reason_en)) || s.delivery_reasons,
    delivery_dirty = false,
    manual_overrides = s.manual_overrides || jsonb_build_object('delivery', v_override)
  where s.id = p_shipment_id;

  perform private.set_delivery_flag(p_shipment_id, 'certain', null, null, v_reason_bg);
  select * into v_s from public.shipments s where s.id = p_shipment_id;
  return v_s;
end;
$$;

-- P5-18: a member corrects the address. The values become manual (a re-import keeps them), and the
-- detection runs again (delivery_dirty).
create or replace function public.shipment_update_address(
  p_shipment_id uuid,
  p_address1 text,
  p_address2 text,
  p_city text,
  p_zip text,
  p_version integer default null
)
returns public.shipments
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_s public.shipments%rowtype;
begin
  if not (select private.is_member()) then
    raise exception 'members_only' using errcode = '42501';
  end if;
  select * into v_s from public.shipments s where s.id = p_shipment_id for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if p_version is not null and v_s.version <> p_version then
    raise exception 'version_conflict' using errcode = 'PT409';
  end if;
  if v_s.status not in ('imported', 'needs_check', 'ready') then
    raise exception 'shipment_locked' using errcode = '55000';
  end if;
  update public.shipments s set
    address1 = nullif(btrim(p_address1), ''),
    address2 = nullif(btrim(p_address2), ''),
    city = nullif(btrim(p_city), ''),
    zip = nullif(btrim(p_zip), ''),
    manual_overrides = s.manual_overrides
      || jsonb_build_object('address', jsonb_build_object('by', auth.uid(), 'at', now()))
  where s.id = p_shipment_id
  returning * into v_s;
  return v_s;
end;
$$;

-- The owner lets the detection decide again (undoes a manual destination).
create or replace function public.delivery_reset(p_shipment_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not (select private.is_owner()) then
    raise exception 'owner_only' using errcode = '42501';
  end if;
  update public.shipments s set
    manual_overrides = s.manual_overrides - 'delivery',
    delivery_dirty = true
  where s.id = p_shipment_id and s.status in ('imported', 'needs_check', 'ready');
end;
$$;

-- After the owner changes the detection settings (range, home courier, words): decide again for
-- every open shipment that no person has decided by hand. Returns how many were marked.
create or replace function public.delivery_redetect_open()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if not (select private.is_owner()) then
    raise exception 'owner_only' using errcode = '42501';
  end if;
  update public.shipments s set delivery_dirty = true
  where s.status in ('imported', 'needs_check', 'ready')
    and not (s.manual_overrides ? 'delivery')
    and not s.delivery_dirty;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.delivery_pending(integer, uuid[])',
    'public.delivery_apply(uuid, integer, jsonb)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
  foreach f in array array[
    'public.points_by_code(text, text[])',
    'public.delivery_call_outcome(uuid, text, uuid, text, integer)',
    'public.shipment_update_address(uuid, text, text, text, text, integer)',
    'public.delivery_reset(uuid)',
    'public.delivery_redetect_open()'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Schedule: new or changed shipments are detected within 2 minutes even if nobody presses
-- anything (the import screen also starts it at once).
-- ---------------------------------------------------------------------------
create or replace function private.delivery_detect_tick()
returns text
language plpgsql
set search_path = ''
as $$
declare
  v_url text;
  v_token text;
begin
  select value into v_url from private.app_config where key = 'functions_url';
  if v_url is null then
    return 'not_configured';
  end if;
  if not exists (
    select 1 from public.shipments s
    where s.delivery_dirty and s.status in ('imported', 'needs_check', 'ready')
  ) then
    return 'idle';
  end if;
  select value into v_token from private.app_config where key = 'cron_token';
  perform net.http_post(
    url := v_url || '/detect-delivery',
    body := jsonb_build_object('action', 'pending', 'trigger', 'cron'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_token),
    timeout_milliseconds := 10000);
  return 'pending';
end;
$$;
revoke all on function private.delivery_detect_tick() from public, anon, authenticated;
select cron.schedule('delivery-detect-tick', '*/2 * * * *', 'select private.delivery_detect_tick()');

-- ---------------------------------------------------------------------------
-- 8. The shipments list shows the destination: courier, type, office, certainty, reasons, the
-- suggestion, calls so far, and the open checks that are NOT about the destination (packers see
-- a shipment that only needs a call; the other checks stay with the owner).
-- ---------------------------------------------------------------------------
create or replace view public.shipment_overview
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
  coalesce(f.info, 0) as flags_info,
  s.carrier, s.delivery_type, s.office_id,
  po.name_bg as office_name, po.address_text as office_address, po.type as office_type,
  s.delivery_certainty, s.delivery_rule, s.delivery_reasons, s.delivery_hints,
  s.delivery_suggestion, s.delivery_alternatives, s.delivery_dirty, s.delivery_detected_at,
  coalesce(f.other, 0) as flags_other,
  coalesce(c.calls, 0) as call_attempts,
  c.last_call_at
from public.shipments s
left join public.courier_offices po on po.id = s.office_id
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
         count(*) filter (where fl.severity = 'info')::integer as info,
         count(*) filter (where fl.severity in ('red', 'amber')
                            and fl.issue_key is distinct from 'delivery')::integer as other
  from public.flags fl
  where fl.resolved_at is null
    and (fl.shipment_id = s.id
         or fl.order_id in (select so.order_id from public.shipment_orders so
                            where so.shipment_id = s.id))
) f on true
left join lateral (
  select count(*) filter (where sc.outcome = 'no_answer')::integer as calls,
         max(sc.created_at) as last_call_at
  from public.shipment_calls sc where sc.shipment_id = s.id
) c on true;

revoke all on public.shipment_overview from public, anon;
grant select on public.shipment_overview to authenticated, service_role;
