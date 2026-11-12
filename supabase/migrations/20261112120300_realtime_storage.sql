-- Phase 1 / migration 4 — realtime and storage

-- ---------------------------------------------------------------------------
-- Realtime: database changes. Subscribers only receive rows their RLS
-- policies let them SELECT (members only).
-- ---------------------------------------------------------------------------
alter publication supabase_realtime add table
  public.orders,
  public.shipments,
  public.flags,
  public.products,
  public.sync_probe;

-- ---------------------------------------------------------------------------
-- Realtime: presence and broadcast on PRIVATE channels only.
-- The app uses topics starting with "shop:" (e.g. shop:presence). Only active
-- members may join, listen or send. Turn off "Allow public access" in the
-- hosted project's Realtime settings so public channels are refused too.
-- ---------------------------------------------------------------------------
create policy "happyhome members read shop channels" on realtime.messages
  for select to authenticated
  using ((select private.is_member()) and (select realtime.topic()) like 'shop:%');

create policy "happyhome members write shop channels" on realtime.messages
  for insert to authenticated
  with check ((select private.is_member()) and (select realtime.topic()) like 'shop:%');

-- ---------------------------------------------------------------------------
-- Storage: three private buckets. Files are only reachable through signed URLs
-- or authenticated downloads that pass the policies below.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  -- Shopify CSV exports, as uploaded. Deleted after settings.raw_csv_retention_days.
  -- MIME type is not restricted: browsers label CSV files inconsistently.
  ('raw-imports', 'raw-imports', false, 52428800, null),
  ('product-photos', 'product-photos', false, 10485760,
    array['image/jpeg', 'image/png', 'image/webp']),
  ('labels', 'labels', false, 20971520, array['application/pdf', 'image/png'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

create policy "happyhome members read files" on storage.objects
  for select to authenticated
  using (
    bucket_id in ('raw-imports', 'product-photos', 'labels')
    and (select private.is_member())
  );

create policy "happyhome members upload files" on storage.objects
  for insert to authenticated
  with check (
    bucket_id in ('raw-imports', 'product-photos', 'labels')
    and (select private.is_member())
  );

create policy "happyhome members replace files" on storage.objects
  for update to authenticated
  using (
    bucket_id in ('raw-imports', 'product-photos', 'labels')
    and (select private.is_member())
  )
  with check (
    bucket_id in ('raw-imports', 'product-photos', 'labels')
    and (select private.is_member())
  );

create policy "happyhome owner deletes files" on storage.objects
  for delete to authenticated
  using (
    bucket_id in ('raw-imports', 'product-photos', 'labels')
    and (select private.is_owner())
  );
