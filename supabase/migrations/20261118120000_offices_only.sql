-- Offices only (owner, 14 Nov 2026): the products are too big for lockers (автомат, пакетомат,
-- Еконтомат) and for Econt's mobile offices. The app no longer decides, suggests or offers them.
--
-- settings.point_types lists the kinds of points the shop ships to ('office', 'locker',
-- 'mobile'). The courier lists still sync every point (nothing is deleted), so the setting can
-- be widened later without a new import of the lists.
insert into public.settings (key, value, description) values
  ('point_types', '["office"]'::jsonb,
    'Kinds of courier points the shop ships to: office, locker, mobile (owner: offices only, the parcels are big)')
on conflict (key) do nothing;

-- Detect every open shipment again (never one chosen by hand): earlier decisions may name a
-- locker, and rule E now sends complete street addresses with no office near to the address.
update public.shipments s set delivery_dirty = true
where s.status in ('imported', 'needs_check', 'ready')
  and not (s.manual_overrides ? 'delivery')
  and not s.delivery_dirty;
