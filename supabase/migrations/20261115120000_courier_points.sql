-- Phase 4 / migration 1 — courier points (offices, lockers, mobile stations) and geocoding
--
--  * courier_offices: the Phase 4 column names (P4-14), change detection (content_hash),
--    where the coordinates came from, a Latin search text for pg_trgm (Cyrillic AND Latin, P4-19).
--  * courier_sync_runs: one row per sync of one carrier (counts, stage, errors, lease).
--    private.courier_sync_items: the list a run fetched, applied in batches (P4-16).
--  * Sync RPCs for the courier-sync Edge Function (service role only). A point missing from a
--    successful sync → active = false; points are never deleted (P4-15).
--  * geocode_cache: kind (address | query), precision; private.rate_slots spaces Nominatim
--    requests for the whole app (≥ 1.2 s; 15 s for scheduled jobs).
--  * nearest_points, points_in_city, search_points, courier_points_stats (P4-17 … P4-19, P4-26).
--  * pg_cron every 5 minutes: Econt daily from 03:00 Sofia, Speedy weekly, resume unfinished runs.

create extension if not exists pg_trgm with schema extensions;
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

-- ---------------------------------------------------------------------------
-- Latin search form, same rules as transliterateBg() in packages/core/src/geo/translit.ts
-- (streamlined system; "ия" at the end of a word → "ia"; "България" → "bulgaria"). Lower case.
-- ---------------------------------------------------------------------------
create or replace function private.bg_latin(p_text text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select btrim(regexp_replace(
    translate(
      replace(replace(replace(replace(replace(replace(replace(
        regexp_replace(
          regexp_replace(lower(coalesce(p_text, '')), '(^|[^а-яa-z0-9ѝ])българия(?![а-яa-z0-9ѝ])',
                         '\1bulgaria', 'g'),
          'ия(?![а-яa-z0-9ѝ])', 'ia', 'g'),
      'щ', 'sht'), 'ж', 'zh'), 'ц', 'ts'), 'ч', 'ch'), 'ш', 'sh'), 'ю', 'yu'), 'я', 'ya'),
      'абвгдезийклмнопрстуфхъьѝ',
      'abvgdeziyklmnoprstufhayi'),
    '\s+', ' ', 'g'));
$$;
revoke all on function private.bg_latin(text) from public, anon;
grant execute on function private.bg_latin(text) to authenticated, service_role;

create or replace function private.point_search_text(
  p_name_bg text, p_name_en text, p_city text, p_postcode text, p_address text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select private.bg_latin(
    coalesce(p_name_bg, '') || ' ' || coalesce(p_name_en, '') || ' ' || coalesce(p_city, '')
    || ' ' || coalesce(p_postcode, '') || ' ' || coalesce(p_address, ''));
$$;
revoke all on function private.point_search_text(text, text, text, text, text) from public, anon;
grant execute on function private.point_search_text(text, text, text, text, text)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- courier_offices — Phase 4 names (P4-14). The table is still empty everywhere.
-- ---------------------------------------------------------------------------
alter table public.courier_offices rename column kind to type;
alter table public.courier_offices rename column name to name_bg;
alter table public.courier_offices rename column zip to postcode;
alter table public.courier_offices rename column address to address_text;
alter table public.courier_offices rename column geo_confidence to coord_confidence;
alter table public.courier_offices rename column is_active to active;
alter index public.courier_offices_zip_idx rename to courier_offices_postcode_idx;

alter table public.courier_offices drop constraint courier_offices_kind_check;
alter table public.courier_offices
  add constraint courier_offices_type_check check (type in ('office', 'locker', 'mobile')),
  add constraint courier_offices_coord_confidence_check check (coord_confidence between 0 and 3),
  add column code text,
  add column coord_source text
    check (coord_source in ('courier', 'speedy_map', 'nominatim')),
  add column content_hash text,
  add column geocode_status text not null default 'none'
    check (geocode_status in ('none', 'pending', 'done', 'failed')),
  add column geocode_attempts integer not null default 0,
  add column geocode_tried_at timestamptz,
  add column deactivated_at timestamptz,
  add column last_run_id uuid,
  add column city_latin text generated always as (private.bg_latin(city)) stored,
  add column search_latin text generated always as
    (private.point_search_text(name_bg, name_en, city, postcode, address_text)) stored;

comment on column public.courier_offices.external_id is
  'Econt office code / Speedy office ID: what a waybill needs';
comment on column public.courier_offices.type is
  'office | locker (Econt Еконтомат = APS, Speedy автомат = APT) | mobile (Econt MPS)';
comment on column public.courier_offices.coord_confidence is
  '0–3: 3 = from the courier, 2 = geocoded street/block, 1 = quarter, 0 = city only';
comment on column public.courier_offices.content_hash is
  'md5 of the synced fields (without raw): a different hash = the courier changed the point';
comment on column public.courier_offices.geocode_status is
  'pending = no coordinates from the courier yet (or the address changed): geocode it';
comment on column public.courier_offices.active is
  'false = missing from the latest successful sync. Points are never deleted (P4-15).';

create index courier_offices_search_trgm_idx on public.courier_offices
  using gin (search_latin extensions.gin_trgm_ops);
create index courier_offices_city_latin_idx on public.courier_offices (city_latin);
create index courier_offices_geocode_idx on public.courier_offices (geocode_status)
  where geocode_status = 'pending';

-- ---------------------------------------------------------------------------
-- geocode_cache — one row per normalized address (kind address) and per exact query
-- string sent to the provider (kind query), so nothing is ever asked twice (P4-25).
-- ---------------------------------------------------------------------------
alter table public.geocode_cache
  add column kind text not null default 'address' check (kind in ('address', 'query')),
  add column precision text check (precision in ('street', 'block', 'quarter', 'city', 'failed')),
  add column variant text;
alter table public.geocode_cache drop constraint geocode_cache_provider_query_norm_key;
alter table public.geocode_cache
  add constraint geocode_cache_provider_kind_query_key unique (provider, kind, query_norm);
comment on column public.geocode_cache.query_norm is
  'kind address: normalized address key (packages/core addressKey); kind query: the exact query';

-- ---------------------------------------------------------------------------
-- courier_sync_runs — one sync of one carrier
-- ---------------------------------------------------------------------------
create table public.courier_sync_runs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  carrier text not null check (carrier in ('econt', 'speedy')),
  trigger text not null check (trigger in ('cron', 'manual', 'test')),
  requested_by uuid, -- the owner who pressed "Обнови офисите"
  source text, -- econt_api:production, speedy_public_list, mock:…
  status text not null default 'running' check (status in ('running', 'ok', 'failed')),
  stage text not null default 'fetch' check (stage in ('fetch', 'apply', 'finish', 'done')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  lease_until timestamptz, -- an Edge Function is working on it until then
  attempts integer not null default 0,
  fetched integer,
  skipped integer,
  invalid integer,
  inserted integer not null default 0,
  updated integer not null default 0,
  unchanged integer not null default 0,
  reactivated integer not null default 0,
  deactivated integer not null default 0,
  warnings jsonb not null default '[]'::jsonb,
  error_code text check (error_code in ('fetch_failed', 'parse_failed', 'too_few_points',
    'mode_not_available', 'too_many_attempts', 'error')),
  error_message text
);
comment on table public.courier_sync_runs is
  'Office syncs (Phase 4). A failed run leaves courier_offices as it was.';
create unique index courier_sync_runs_one_running on public.courier_sync_runs (carrier)
  where status = 'running';
create index courier_sync_runs_carrier_started_idx on public.courier_sync_runs
  (carrier, started_at desc);

create trigger set_row_meta before insert or update on public.courier_sync_runs
  for each row execute function private.set_row_meta();
create trigger audit_row after insert or update or delete on public.courier_sync_runs
  for each row execute function private.audit_row('user_only');

alter table public.courier_sync_runs enable row level security;
grant select on table public.courier_sync_runs to authenticated;
grant select, insert, update, delete on table public.courier_sync_runs to service_role;
create policy courier_sync_runs_select on public.courier_sync_runs
  for select to authenticated
  using ((select private.is_member()));

-- Work tables of the sync job (not reachable through the Data API).
create table private.courier_sync_items (
  run_id uuid not null references public.courier_sync_runs (id) on delete cascade,
  external_id text not null,
  point jsonb not null,
  applied boolean not null default false,
  primary key (run_id, external_id)
);

create table private.app_config (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
comment on table private.app_config is
  'functions_url: where pg_cron calls the Edge Functions (recorded by courier-sync on the hosted '
  'project); cron_token: the shared secret pg_cron sends to courier-sync.';
insert into private.app_config (key, value)
values ('cron_token', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
on conflict (key) do nothing;

create table private.rate_slots (
  bucket text primary key,
  next_at timestamptz not null default '-infinity'
);
insert into private.rate_slots (bucket) values ('nominatim'), ('nominatim_bulk')
on conflict (bucket) do nothing;

-- ---------------------------------------------------------------------------
-- Sync RPCs (courier-sync Edge Function, service role only)
-- ---------------------------------------------------------------------------

-- Start a run, or return the one already running for this carrier.
create or replace function public.courier_sync_start(p_carrier text, p_trigger text, p_actor uuid)
returns public.courier_sync_runs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.courier_sync_runs;
begin
  select * into v_run from public.courier_sync_runs
  where carrier = p_carrier and status = 'running';
  if found then
    return v_run;
  end if;
  insert into public.courier_sync_runs (carrier, trigger, requested_by)
  values (p_carrier, p_trigger, p_actor)
  on conflict (carrier) where status = 'running' do nothing
  returning * into v_run;
  if v_run.id is null then
    select * into v_run from public.courier_sync_runs
    where carrier = p_carrier and status = 'running';
  end if;
  return v_run;
end;
$$;

-- Take the run for p_seconds (null when another call is working on it, or it has finished).
create or replace function public.courier_sync_claim(p_run uuid, p_seconds integer)
returns public.courier_sync_runs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.courier_sync_runs;
begin
  update public.courier_sync_runs
  set lease_until = now() + make_interval(secs => p_seconds), attempts = attempts + 1
  where id = p_run and status = 'running' and (lease_until is null or lease_until < now())
  returning * into v_run;
  return v_run;
end;
$$;

create or replace function public.courier_sync_release(p_run uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.courier_sync_runs set lease_until = null
  where id = p_run and lease_until is not null;
$$;

create or replace function public.courier_sync_reset_stage(p_run uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.courier_sync_runs
                 where id = p_run and status = 'running' and stage = 'fetch') then
    raise exception 'courier_sync: run % is not fetching', p_run using errcode = 'P0001';
  end if;
  delete from private.courier_sync_items where run_id = p_run;
end;
$$;

-- Stage fetched points (jsonb array of courier_offices-shaped objects). Idempotent.
create or replace function public.courier_sync_stage(p_run uuid, p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.courier_sync_runs;
  v_count integer;
begin
  select * into v_run from public.courier_sync_runs where id = p_run;
  if not found or v_run.status <> 'running' or v_run.stage <> 'fetch' then
    raise exception 'courier_sync: run % is not fetching', p_run using errcode = 'P0001';
  end if;
  if exists (select 1 from jsonb_array_elements(p_rows) r
             where r->>'carrier' is distinct from v_run.carrier
                or coalesce(r->>'external_id', '') = '') then
    raise exception 'courier_sync: rows must belong to % and have an external_id', v_run.carrier
      using errcode = 'P0001';
  end if;
  insert into private.courier_sync_items (run_id, external_id, point)
  select p_run, r->>'external_id', r from jsonb_array_elements(p_rows) r
  on conflict (run_id, external_id) do update set point = excluded.point, applied = false;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function public.courier_sync_mark_staged(p_run uuid, p_info jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_staged integer;
begin
  select count(*) into v_staged from private.courier_sync_items where run_id = p_run;
  if v_staged <> (p_info->>'total')::integer then
    raise exception 'courier_sync: % points staged, % expected', v_staged, p_info->>'total'
      using errcode = 'P0001';
  end if;
  update public.courier_sync_runs
  set stage = 'apply',
      fetched = v_staged,
      skipped = (p_info->>'skipped')::integer,
      invalid = (p_info->>'invalid')::integer,
      source = p_info->>'source',
      warnings = coalesce(p_info->'warnings', '[]'::jsonb)
  where id = p_run and status = 'running' and stage = 'fetch';
  if not found then
    raise exception 'courier_sync: run % is not fetching', p_run using errcode = 'P0001';
  end if;
end;
$$;

-- Upsert the next p_limit staged points. One transaction per batch: an interruption between
-- batches loses nothing and counts nothing twice (P4-16, T4-07).
create or replace function public.courier_sync_apply(p_run uuid, p_limit integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.courier_sync_runs;
  v_inserted integer;
  v_updated integer;
  v_unchanged integer;
  v_reactivated integer;
  v_remaining integer;
begin
  select * into v_run from public.courier_sync_runs where id = p_run for update;
  if not found or v_run.status <> 'running' or v_run.stage <> 'apply' then
    return jsonb_build_object('applied', 0, 'remaining', 0);
  end if;

  with batch as (
    select i.external_id, i.point, md5((i.point - 'raw')::text) as hash
    from private.courier_sync_items i
    where i.run_id = p_run and not i.applied
    order by i.external_id
    limit greatest(p_limit, 1)
  ),
  before as (
    select o.external_id, o.content_hash, o.active
    from public.courier_offices o
    where o.carrier = v_run.carrier and o.external_id in (select external_id from batch)
  ),
  upserted as (
    insert into public.courier_offices as o (
      carrier, external_id, code, type, name_bg, name_en, city, postcode, address_text,
      lat, lng, coord_confidence, coord_source, working_hours, phone, raw, source,
      content_hash, active, synced_at, last_run_id, geocode_status)
    select
      v_run.carrier, b.external_id, b.point->>'code', b.point->>'type', b.point->>'name_bg',
      b.point->>'name_en', b.point->>'city', b.point->>'postcode', b.point->>'address_text',
      (b.point->>'lat')::double precision, (b.point->>'lng')::double precision,
      (b.point->>'coord_confidence')::smallint, b.point->>'coord_source',
      nullif(b.point->'working_hours', 'null'::jsonb), b.point->>'phone',
      coalesce(nullif(b.point->'raw', 'null'::jsonb), '{}'::jsonb),
      coalesce(v_run.source, v_run.carrier), b.hash, true, now(), p_run,
      case when b.point->>'lat' is null then 'pending' else 'none' end
    from batch b
    on conflict (carrier, external_id) do update set
      code = excluded.code,
      type = excluded.type,
      name_bg = excluded.name_bg,
      name_en = excluded.name_en,
      city = excluded.city,
      postcode = excluded.postcode,
      address_text = excluded.address_text,
      working_hours = excluded.working_hours,
      phone = excluded.phone,
      raw = excluded.raw,
      source = excluded.source,
      -- Coordinates from the courier always win; without them the stored ones stay.
      lat = coalesce(excluded.lat, o.lat),
      lng = case when excluded.lat is not null then excluded.lng else o.lng end,
      coord_confidence = case when excluded.lat is not null
                              then excluded.coord_confidence else o.coord_confidence end,
      coord_source = case when excluded.lat is not null
                          then excluded.coord_source else o.coord_source end,
      geocode_status = case
        when excluded.lat is not null then 'none'
        when o.lat is null or o.address_text is distinct from excluded.address_text then 'pending'
        else o.geocode_status end,
      geocode_attempts = case when o.address_text is distinct from excluded.address_text
                              then 0 else o.geocode_attempts end,
      content_hash = excluded.content_hash,
      active = true,
      deactivated_at = null,
      synced_at = excluded.synced_at,
      last_run_id = excluded.last_run_id
    returning o.external_id
  ),
  marked as (
    update private.courier_sync_items i set applied = true
    from batch b
    where i.run_id = p_run and i.external_id = b.external_id
    returning i.external_id
  )
  select
    count(*) filter (where bf.external_id is null),
    count(*) filter (where bf.active and bf.content_hash is distinct from b.hash),
    count(*) filter (where bf.active and bf.content_hash is not distinct from b.hash),
    count(*) filter (where bf.external_id is not null and not bf.active)
  into v_inserted, v_updated, v_unchanged, v_reactivated
  from batch b left join before bf on bf.external_id = b.external_id;

  select count(*) into v_remaining from private.courier_sync_items
  where run_id = p_run and not applied;

  update public.courier_sync_runs
  set inserted = inserted + v_inserted,
      updated = updated + v_updated,
      unchanged = unchanged + v_unchanged,
      reactivated = reactivated + v_reactivated,
      stage = case when v_remaining = 0 then 'finish' else stage end
  where id = p_run;

  return jsonb_build_object(
    'applied', v_inserted + v_updated + v_unchanged + v_reactivated,
    'remaining', v_remaining);
end;
$$;

-- Points of this carrier that were not in the list → inactive (never deleted). Ends the run.
create or replace function public.courier_sync_finish(p_run uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.courier_sync_runs;
  v_deactivated integer;
begin
  select * into v_run from public.courier_sync_runs where id = p_run for update;
  if not found or v_run.status <> 'running' or v_run.stage <> 'finish' then
    raise exception 'courier_sync: run % is not ready to finish', p_run using errcode = 'P0001';
  end if;
  if not exists (select 1 from private.courier_sync_items where run_id = p_run) then
    raise exception 'courier_sync: run % staged nothing', p_run using errcode = 'P0001';
  end if;

  update public.courier_offices o
  set active = false, deactivated_at = now()
  where o.carrier = v_run.carrier
    and o.active
    and not exists (select 1 from private.courier_sync_items i
                    where i.run_id = p_run and i.external_id = o.external_id);
  get diagnostics v_deactivated = row_count;

  update public.courier_sync_runs
  set status = 'ok', stage = 'done', finished_at = now(), lease_until = null,
      deactivated = v_deactivated
  where id = p_run;
  delete from private.courier_sync_items where run_id = p_run;
  return jsonb_build_object('deactivated', v_deactivated);
end;
$$;

-- The run failed: record why. courier_offices is not touched (P4-10).
create or replace function public.courier_sync_fail(p_run uuid, p_code text, p_message text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.courier_sync_runs
  set status = 'failed', finished_at = now(), lease_until = null,
      error_code = p_code, error_message = left(p_message, 500)
  where id = p_run and status = 'running';
  delete from private.courier_sync_items where run_id = p_run;
end;
$$;

-- Does the bearer token belong to pg_cron?
create or replace function public.courier_sync_check_token(p_token text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from private.app_config where key = 'cron_token' and value = p_token);
$$;

-- Where pg_cron reaches the Edge Functions (recorded by courier-sync on the hosted project).
create or replace function public.courier_sync_set_functions_url(p_url text)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into private.app_config (key, value) values ('functions_url', p_url)
  on conflict (key) do update set value = excluded.value, updated_at = now()
  where private.app_config.value is distinct from excluded.value;
$$;

-- Points without coordinates (or whose address changed) to geocode, at most 3 tries each,
-- an hour apart. Claims them (geocode_tried_at) so two workers never take the same point.
create or replace function public.courier_points_claim_geocode(p_limit integer)
returns setof public.courier_offices
language sql
security definer
set search_path = ''
as $$
  update public.courier_offices o
  set geocode_tried_at = now(), geocode_attempts = o.geocode_attempts + 1
  where o.id in (
    select id from public.courier_offices
    where active and geocode_status = 'pending' and geocode_attempts < 3
      and (geocode_tried_at is null or geocode_tried_at < now() - interval '1 hour')
    order by geocode_tried_at nulls first, id
    limit greatest(p_limit, 1)
    for update skip locked)
  returning o.*;
$$;

-- The geocoder's answer for a claimed point. p_precision null = it could not finish (busy):
-- the try is given back and the point returns to the queue.
create or replace function public.courier_point_geocoded(
  p_id uuid, p_lat double precision, p_lng double precision, p_precision text)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.courier_offices
  set geocode_attempts = greatest(geocode_attempts - 1, 0), geocode_tried_at = null
  where id = p_id and p_precision is null;

  update public.courier_offices
  set lat = case when p_lat is not null then p_lat else lat end,
      lng = case when p_lat is not null then p_lng else lng end,
      coord_source = case when p_lat is not null then 'nominatim' else coord_source end,
      coord_confidence = case when p_lat is null then coord_confidence
                              when p_precision in ('street', 'block') then 2
                              when p_precision = 'quarter' then 1 else 0 end,
      geocode_status = case when p_lat is not null then 'done'
                            when geocode_attempts >= 3 then 'failed' else 'pending' end
  where id = p_id and p_precision is not null;
$$;

-- Reserve the next moment the app may call the geocoder. Returns how long to wait (ms), or
-- null when that would be longer than p_max_wait_ms (nothing is reserved then). The row lock
-- makes concurrent callers queue up, across every Edge Function instance (T4-06).
create or replace function public.geocoder_reserve(
  p_bucket text, p_interval_ms integer, p_max_wait_ms integer)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_at timestamptz;
begin
  select greatest(next_at, v_now) into v_at from private.rate_slots
  where bucket = p_bucket for update;
  if not found then
    raise exception 'geocoder_reserve: unknown bucket %', p_bucket using errcode = 'P0001';
  end if;
  if v_at > v_now + make_interval(secs => p_max_wait_ms / 1000.0) then
    return null;
  end if;
  update private.rate_slots
  set next_at = v_at + make_interval(secs => p_interval_ms / 1000.0)
  where bucket = p_bucket;
  return ceil(extract(epoch from (v_at - v_now)) * 1000)::integer;
end;
$$;

create or replace function public.courier_sync_active_count(p_carrier text)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer from public.courier_offices where carrier = p_carrier and active;
$$;

-- Runs that are still running and nobody is working on (stopped by a time limit or a crash).
create or replace function public.courier_sync_resumable()
returns setof public.courier_sync_runs
language sql
stable
security definer
set search_path = ''
as $$
  select * from public.courier_sync_runs
  where status = 'running' and (lease_until is null or lease_until < now())
  order by started_at;
$$;

-- A setting value for the Edge Functions (they run without a signed-in user).
create or replace function public.app_setting(p_key text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select value from public.settings where key = p_key;
$$;

create or replace function public.geocode_cache_get(p_provider text, p_kind text, p_key text)
returns public.geocode_cache
language sql
stable
security definer
set search_path = ''
as $$
  select * from public.geocode_cache
  where provider = p_provider and kind = p_kind and query_norm = p_key;
$$;

create or replace function public.geocode_cache_put(
  p_provider text, p_kind text, p_key text, p_lat double precision, p_lng double precision,
  p_precision text, p_variant text, p_display_name text, p_raw jsonb)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.geocode_cache
    (provider, kind, query_norm, lat, lng, precision, variant, display_name, raw, fetched_at)
  values (p_provider, p_kind, p_key, p_lat, p_lng, p_precision, p_variant, p_display_name,
          coalesce(p_raw, '{}'::jsonb), now())
  on conflict (provider, kind, query_norm) do update set
    lat = excluded.lat, lng = excluded.lng, precision = excluded.precision,
    variant = excluded.variant, display_name = excluded.display_name, raw = excluded.raw,
    fetched_at = excluded.fetched_at;
$$;

-- The tariff band for a weight (SpeedyManualAdapter.calculate): the smallest band that fits,
-- else the largest one (extra_per_kg_cents then applies). Seeded in Phase 7.
create or replace function public.tariff_find(
  p_carrier text, p_delivery_type text, p_weight_g integer, p_on date)
returns public.tariffs
language sql
stable
security definer
set search_path = ''
as $$
  select * from public.tariffs
  where carrier = p_carrier and delivery_type = p_delivery_type and variant = 'default'
    and valid_from <= p_on and (valid_to is null or valid_to >= p_on)
  order by (max_weight_g >= p_weight_g) desc,
           case when max_weight_g >= p_weight_g then max_weight_g end asc,
           max_weight_g desc
  limit 1;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.courier_sync_active_count(text)',
    'public.courier_sync_resumable()',
    'public.app_setting(text)',
    'public.geocode_cache_get(text, text, text)',
    'public.geocode_cache_put(text, text, text, double precision, double precision, text, text, text, jsonb)',
    'public.tariff_find(text, text, integer, date)',
    'public.courier_sync_start(text, text, uuid)',
    'public.courier_sync_claim(uuid, integer)',
    'public.courier_sync_release(uuid)',
    'public.courier_sync_reset_stage(uuid)',
    'public.courier_sync_stage(uuid, jsonb)',
    'public.courier_sync_mark_staged(uuid, jsonb)',
    'public.courier_sync_apply(uuid, integer)',
    'public.courier_sync_finish(uuid)',
    'public.courier_sync_fail(uuid, text, text)',
    'public.courier_sync_check_token(text)',
    'public.courier_sync_set_functions_url(text)',
    'public.courier_points_claim_geocode(integer)',
    'public.courier_point_geocoded(uuid, double precision, double precision, text)',
    'public.geocoder_reserve(text, integer, integer)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Queries for the app (members; RLS on courier_offices applies: SECURITY INVOKER)
-- ---------------------------------------------------------------------------

-- P4-17: active points within p_max_km of a coordinate, nearest first (PostGIS, exact on the
-- ellipsoid). p_carriers / p_types null = all.
create or replace function public.nearest_points(
  p_lat double precision,
  p_lng double precision,
  p_carriers text[] default null,
  p_types text[] default null,
  p_max_km double precision default 5,
  p_limit integer default 10)
returns table (
  id uuid, carrier text, external_id text, code text, type text, name_bg text, name_en text,
  city text, postcode text, address_text text, lat double precision, lng double precision,
  coord_confidence smallint, working_hours jsonb, distance_km double precision)
language sql
stable
security invoker
set search_path = ''
as $$
  with here as (
    select extensions.st_setsrid(extensions.st_makepoint(p_lng, p_lat), 4326)::extensions.geography as g
  )
  select o.id, o.carrier, o.external_id, o.code, o.type, o.name_bg, o.name_en, o.city,
         o.postcode, o.address_text, o.lat, o.lng, o.coord_confidence, o.working_hours,
         extensions.st_distance(o.location, here.g) / 1000.0 as distance_km
  from public.courier_offices o, here
  where o.active
    and o.location is not null
    and (p_carriers is null or o.carrier = any (p_carriers))
    and (p_types is null or o.type = any (p_types))
    and extensions.st_dwithin(o.location, here.g, greatest(p_max_km, 0) * 1000.0)
  order by distance_km, o.id
  limit least(greatest(p_limit, 1), 200);
$$;

-- P4-18: active points of a city (name in Cyrillic or Latin, with or without "гр."/"с.") or of
-- a postcode (also the other points of the city that postcode belongs to: Speedy's list gives
-- no postcode for the big cities).
create or replace function public.points_in_city(p_query text)
returns table (
  id uuid, carrier text, external_id text, code text, type text, name_bg text, name_en text,
  city text, postcode text, address_text text, lat double precision, lng double precision,
  coord_confidence smallint, coord_source text, working_hours jsonb)
language sql
stable
security invoker
set search_path = ''
as $$
  with q as (
    select btrim(p_query) as raw,
           private.bg_latin(regexp_replace(btrim(p_query),
             '^(гр\.?|град|с\.?|село|gr\.?|grad|s\.?|selo)\s+', '', 'i')) as latin
  ),
  cities as (
    select q.latin as city_latin from q where q.raw !~ '^\d{4}$'
    union
    select distinct o.city_latin from public.courier_offices o, q
    where q.raw ~ '^\d{4}$' and o.postcode = q.raw and o.city_latin is not null
  )
  select o.id, o.carrier, o.external_id, o.code, o.type, o.name_bg, o.name_en, o.city,
         o.postcode, o.address_text, o.lat, o.lng, o.coord_confidence, o.coord_source,
         o.working_hours
  from public.courier_offices o, q
  where o.active
    and (o.city_latin in (select city_latin from cities) or o.postcode = q.raw)
  order by o.carrier, o.type, o.name_bg;
$$;

-- P4-19: fuzzy search on name / city / address, Cyrillic or Latin ("пловдив тракия",
-- "plovdiv trakia"). Both sides are compared in the Latin form with pg_trgm.
create or replace function public.search_points(
  p_query text,
  p_carriers text[] default null,
  p_types text[] default null,
  p_limit integer default 20)
returns table (
  id uuid, carrier text, external_id text, code text, type text, name_bg text, name_en text,
  city text, postcode text, address_text text, lat double precision, lng double precision,
  score real)
language sql
stable
security invoker
set search_path = ''
as $$
  with q as (select private.bg_latin(p_query) as t)
  select o.id, o.carrier, o.external_id, o.code, o.type, o.name_bg, o.name_en, o.city,
         o.postcode, o.address_text, o.lat, o.lng,
         extensions.word_similarity(q.t, o.search_latin) as score
  from public.courier_offices o, q
  where o.active
    and length(q.t) >= 2
    and (p_carriers is null or o.carrier = any (p_carriers))
    and (p_types is null or o.type = any (p_types))
    and (q.t operator(extensions.<%) o.search_latin
         or o.search_latin like '%' || q.t || '%')
  order by score desc, o.name_bg
  limit least(greatest(p_limit, 1), 100);
$$;

-- P4-26: counts per carrier and type.
create or replace function public.courier_points_stats()
returns table (carrier text, type text, active boolean, total bigint, with_coords bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  select carrier, type, active, count(*), count(*) filter (where location is not null)
  from public.courier_offices
  group by carrier, type, active
  order by carrier, type, active desc;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.nearest_points(double precision, double precision, text[], text[], double precision, integer)',
    'public.points_in_city(text)',
    'public.search_points(text, text[], text[], integer)',
    'public.courier_points_stats()'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Schedule (P4-13): every 5 minutes pg_cron asks "is anything due?"
--   Econt: daily, from 03:00 Europe/Sofia (03:00–05:59 window; a failed run is retried after
--          30 minutes).
--   Speedy: weekly: when the last successful run is 6½ days old, in the same night window.
--   Unfinished runs (stopped by the time limit) and points without coordinates: continued.
-- Daylight saving time is handled by converting to Europe/Sofia here, not in the cron string.
-- ---------------------------------------------------------------------------
create or replace function private.courier_sync_due(p_now timestamptz)
returns text[]
language sql
stable
set search_path = ''
as $$
  with t as (select (p_now at time zone 'Europe/Sofia') as local_now)
  select coalesce(array_agg(d.carrier order by d.carrier), '{}'::text[])
  from (
    select 'econt'::text as carrier from t
    where extract(hour from t.local_now) between 3 and 5
      and not exists (
        select 1 from public.courier_sync_runs r
        where r.carrier = 'econt' and r.status in ('ok', 'running')
          and r.started_at >= (date_trunc('day', t.local_now) + interval '3 hours')
                              at time zone 'Europe/Sofia')
      and not exists (
        select 1 from public.courier_sync_runs r
        where r.carrier = 'econt' and r.started_at > p_now - interval '30 minutes')
    union all
    select 'speedy'::text from t
    where extract(hour from t.local_now) between 3 and 5
      and not exists (
        select 1 from public.courier_sync_runs r
        where r.carrier = 'speedy' and r.status in ('ok', 'running')
          and r.started_at > p_now - interval '6 days 12 hours')
      and not exists (
        select 1 from public.courier_sync_runs r
        where r.carrier = 'speedy' and r.started_at > p_now - interval '30 minutes')
  ) d;
$$;

create or replace function private.courier_sync_tick()
returns text
language plpgsql
set search_path = ''
as $$
declare
  v_url text;
  v_token text;
  v_due text[];
  v_body jsonb;
begin
  select value into v_url from private.app_config where key = 'functions_url';
  if v_url is null then
    return 'not_configured'; -- until courier-sync has run once on the hosted project
  end if;
  select value into v_token from private.app_config where key = 'cron_token';
  v_due := private.courier_sync_due(now());
  if cardinality(v_due) > 0 then
    v_body := jsonb_build_object('action', 'start', 'carriers', to_jsonb(v_due), 'trigger', 'cron');
  elsif exists (select 1 from public.courier_sync_runs
                where status = 'running' and (lease_until is null or lease_until < now()))
     or exists (select 1 from public.courier_offices
                where active and geocode_status = 'pending' and geocode_attempts < 3
                  and (geocode_tried_at is null or geocode_tried_at < now() - interval '1 hour')) then
    v_body := jsonb_build_object('action', 'continue', 'trigger', 'cron');
  else
    return 'idle';
  end if;
  perform net.http_post(
    url := v_url || '/courier-sync',
    body := v_body,
    headers := jsonb_build_object(
      'Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_token),
    timeout_milliseconds := 10000);
  return v_body->>'action';
end;
$$;
revoke all on function private.courier_sync_due(timestamptz) from public, anon, authenticated;
revoke all on function private.courier_sync_tick() from public, anon, authenticated;

select cron.schedule('courier-sync-tick', '*/5 * * * *', 'select private.courier_sync_tick()');

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------
insert into public.settings (key, value, description) values
  ('geocoder',
    '{"provider": "nominatim", "url": "https://nominatim.openstreetmap.org", "enabled": true, "email": null}'::jsonb,
    'Free geocoder (OpenStreetMap Nominatim): service URL, on/off, optional contact e-mail')
on conflict (key) do nothing;
