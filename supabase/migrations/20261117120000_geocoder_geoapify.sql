-- Geocoder: Geoapify instead of the public Nominatim (owner's choice, 14 Nov 2026).
--
-- On the hosted project every Nominatim request answered 403 "Access denied": Supabase Edge
-- Functions append "(variant; SupabaseEdgeRuntime/…; ref=…)" to the User-Agent, and the public
-- Nominatim refuses that. Geoapify (OpenStreetMap data, EU company, free plan allows commercial
-- use with attribution and sets no storage limit) answers server-side with an API key, kept in
-- the Edge Function secret GEOAPIFY_API_KEY (never in this table).
--
-- Only a setting still at the Phase 4 default is switched: a value the owner changed is kept.
-- Cached results are per provider, so nothing cached from Nominatim is mixed in.
update public.settings
set
  value = '{"provider": "geoapify", "url": "https://api.geoapify.com/v1/geocode", "enabled": true, "email": null}'::jsonb,
  description = 'Geocoder (Geoapify, OpenStreetMap data; API key in the Edge Function secret GEOAPIFY_API_KEY): provider, service URL, on/off'
where key = 'geocoder'
  and value = '{"provider": "nominatim", "url": "https://nominatim.openstreetmap.org", "enabled": true, "email": null}'::jsonb;

-- A fresh database (db reset, CI) gets the same through this update, since the Phase 4 seed
-- inserts the Nominatim default first.

-- Courier points placed by the geocoder (Speedy offices missing from the map page) name the
-- geocoder that placed them: 'nominatim' (Phase 4) or now 'geoapify'.
do $$
declare
  v_name text;
begin
  for v_name in
    select conname from pg_constraint
    where conrelid = 'public.courier_offices'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) like '%coord_source%'
  loop
    execute format('alter table public.courier_offices drop constraint %I', v_name);
  end loop;
end;
$$;
alter table public.courier_offices
  add constraint courier_offices_coord_source_check
    check (coord_source in ('courier', 'speedy_map', 'nominatim', 'geoapify'));

-- Same signature and behaviour as Phase 4; only the source now follows settings.geocoder.
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
      coord_source = case
        when p_lat is null then coord_source
        when (select s.value ->> 'provider' from public.settings s where s.key = 'geocoder')
          = 'geoapify' then 'geoapify'
        else 'nominatim' end,
      coord_confidence = case when p_lat is null then coord_confidence
                              when p_precision in ('street', 'block') then 2
                              when p_precision = 'quarter' then 1 else 0 end,
      geocode_status = case when p_lat is not null then 'done'
                            when geocode_attempts >= 3 then 'failed' else 'pending' end
  where id = p_id and p_precision is not null;
$$;
