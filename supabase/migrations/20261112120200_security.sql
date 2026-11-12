-- Phase 1 / migration 3 — explicit GRANTs and RLS policies for every table
--
-- Hosted project settings this file is written for:
--   Data API on, "automatically expose new tables" OFF, "automatic RLS" ON.
-- So nothing is reachable until it is granted here, and RLS is enabled here
-- explicitly as well (it is idempotent, and local databases have no auto-RLS).
--
-- Roles
--   anon           no privileges on any table. Signed-out visitors get nothing.
--   authenticated  privileges below, then filtered by RLS:
--                    members (owner or packer, active) may read and write shop data;
--                    only the owner may write settings, tariffs and members, and delete.
--   service_role   Edge Functions / admin scripts. Bypasses RLS; still needs GRANTs.
--
-- Helper functions (private schema, SECURITY DEFINER): private.is_member(), private.is_owner().
-- They are wrapped in (select ...) so Postgres evaluates them once per statement.

-- Start from zero so the GRANTs below are the complete list.
revoke all on all tables in schema public from anon, authenticated, service_role;
revoke all on all sequences in schema public from anon, authenticated, service_role;

-- ===========================================================================
-- members — everyone in the shop sees who is who (names for "Мама гледа...").
-- A signed-in user can always see their own row (to explain "account disabled").
-- Only the owner adds, changes or removes people.
-- ===========================================================================
alter table public.members enable row level security;
grant select, insert, update, delete on table public.members to authenticated;
grant select, insert, update, delete on table public.members to service_role;

create policy members_select on public.members
  for select to authenticated
  using ((select private.is_member()) or user_id = (select auth.uid()));
create policy members_insert_owner on public.members
  for insert to authenticated
  with check ((select private.is_owner()));
create policy members_update_owner on public.members
  for update to authenticated
  using ((select private.is_owner()))
  with check ((select private.is_owner()));
create policy members_delete_owner on public.members
  for delete to authenticated
  using ((select private.is_owner()));

-- ===========================================================================
-- audit_log — members read; nobody writes directly (the audit trigger does).
-- ===========================================================================
alter table public.audit_log enable row level security;
grant select on table public.audit_log to authenticated;
grant select on table public.audit_log to service_role;

create policy audit_log_select on public.audit_log
  for select to authenticated
  using ((select private.is_member()));

-- ===========================================================================
-- settings — members read; only the owner writes or deletes.
-- ===========================================================================
alter table public.settings enable row level security;
grant select, insert, update, delete on table public.settings to authenticated;
grant select, insert, update, delete on table public.settings to service_role;

create policy settings_select on public.settings
  for select to authenticated
  using ((select private.is_member()));
create policy settings_insert_owner on public.settings
  for insert to authenticated
  with check ((select private.is_owner()));
create policy settings_update_owner on public.settings
  for update to authenticated
  using ((select private.is_owner()))
  with check ((select private.is_owner()));
create policy settings_delete_owner on public.settings
  for delete to authenticated
  using ((select private.is_owner()));

-- ===========================================================================
-- tariffs — members read; only the owner writes or deletes.
-- ===========================================================================
alter table public.tariffs enable row level security;
grant select, insert, update, delete on table public.tariffs to authenticated;
grant select, insert, update, delete on table public.tariffs to service_role;

create policy tariffs_select on public.tariffs
  for select to authenticated
  using ((select private.is_member()));
create policy tariffs_insert_owner on public.tariffs
  for insert to authenticated
  with check ((select private.is_owner()));
create policy tariffs_update_owner on public.tariffs
  for update to authenticated
  using ((select private.is_owner()))
  with check ((select private.is_owner()));
create policy tariffs_delete_owner on public.tariffs
  for delete to authenticated
  using ((select private.is_owner()));

-- ===========================================================================
-- courier_offices — members read. Written only by Edge Functions (service
-- role) from courier data: the app never invents offices.
-- ===========================================================================
alter table public.courier_offices enable row level security;
grant select on table public.courier_offices to authenticated;
grant select, insert, update, delete on table public.courier_offices to service_role;

create policy courier_offices_select on public.courier_offices
  for select to authenticated
  using ((select private.is_member()));

-- ===========================================================================
-- geocode_cache — members read. Written only by Edge Functions (service role).
-- ===========================================================================
alter table public.geocode_cache enable row level security;
grant select on table public.geocode_cache to authenticated;
grant select, insert, update, delete on table public.geocode_cache to service_role;

create policy geocode_cache_select on public.geocode_cache
  for select to authenticated
  using ((select private.is_member()));

-- ===========================================================================
-- Shop data — members read, insert and update; only the owner deletes.
-- ===========================================================================

-- import_batches
alter table public.import_batches enable row level security;
grant select, insert, update, delete on table public.import_batches to authenticated;
grant select, insert, update, delete on table public.import_batches to service_role;

create policy import_batches_select on public.import_batches
  for select to authenticated
  using ((select private.is_member()));
create policy import_batches_insert on public.import_batches
  for insert to authenticated
  with check ((select private.is_member()));
create policy import_batches_update on public.import_batches
  for update to authenticated
  using ((select private.is_member()))
  with check ((select private.is_member()));
create policy import_batches_delete_owner on public.import_batches
  for delete to authenticated
  using ((select private.is_owner()));

-- orders
alter table public.orders enable row level security;
grant select, insert, update, delete on table public.orders to authenticated;
grant select, insert, update, delete on table public.orders to service_role;

create policy orders_select on public.orders
  for select to authenticated
  using ((select private.is_member()));
create policy orders_insert on public.orders
  for insert to authenticated
  with check ((select private.is_member()));
create policy orders_update on public.orders
  for update to authenticated
  using ((select private.is_member()))
  with check ((select private.is_member()));
create policy orders_delete_owner on public.orders
  for delete to authenticated
  using ((select private.is_owner()));

-- order_lines
alter table public.order_lines enable row level security;
grant select, insert, update, delete on table public.order_lines to authenticated;
grant select, insert, update, delete on table public.order_lines to service_role;

create policy order_lines_select on public.order_lines
  for select to authenticated
  using ((select private.is_member()));
create policy order_lines_insert on public.order_lines
  for insert to authenticated
  with check ((select private.is_member()));
create policy order_lines_update on public.order_lines
  for update to authenticated
  using ((select private.is_member()))
  with check ((select private.is_member()));
create policy order_lines_delete_owner on public.order_lines
  for delete to authenticated
  using ((select private.is_owner()));

-- products
alter table public.products enable row level security;
grant select, insert, update, delete on table public.products to authenticated;
grant select, insert, update, delete on table public.products to service_role;

create policy products_select on public.products
  for select to authenticated
  using ((select private.is_member()));
create policy products_insert on public.products
  for insert to authenticated
  with check ((select private.is_member()));
create policy products_update on public.products
  for update to authenticated
  using ((select private.is_member()))
  with check ((select private.is_member()));
create policy products_delete_owner on public.products
  for delete to authenticated
  using ((select private.is_owner()));

-- shipments
alter table public.shipments enable row level security;
grant select, insert, update, delete on table public.shipments to authenticated;
grant select, insert, update, delete on table public.shipments to service_role;

create policy shipments_select on public.shipments
  for select to authenticated
  using ((select private.is_member()));
create policy shipments_insert on public.shipments
  for insert to authenticated
  with check ((select private.is_member()));
create policy shipments_update on public.shipments
  for update to authenticated
  using ((select private.is_member()))
  with check ((select private.is_member()));
create policy shipments_delete_owner on public.shipments
  for delete to authenticated
  using ((select private.is_owner()));

-- shipment_orders
alter table public.shipment_orders enable row level security;
grant select, insert, update, delete on table public.shipment_orders to authenticated;
grant select, insert, update, delete on table public.shipment_orders to service_role;

create policy shipment_orders_select on public.shipment_orders
  for select to authenticated
  using ((select private.is_member()));
create policy shipment_orders_insert on public.shipment_orders
  for insert to authenticated
  with check ((select private.is_member()));
create policy shipment_orders_update on public.shipment_orders
  for update to authenticated
  using ((select private.is_member()))
  with check ((select private.is_member()));
create policy shipment_orders_delete_owner on public.shipment_orders
  for delete to authenticated
  using ((select private.is_owner()));

-- flags
alter table public.flags enable row level security;
grant select, insert, update, delete on table public.flags to authenticated;
grant select, insert, update, delete on table public.flags to service_role;

create policy flags_select on public.flags
  for select to authenticated
  using ((select private.is_member()));
create policy flags_insert on public.flags
  for insert to authenticated
  with check ((select private.is_member()));
create policy flags_update on public.flags
  for update to authenticated
  using ((select private.is_member()))
  with check ((select private.is_member()));
create policy flags_delete_owner on public.flags
  for delete to authenticated
  using ((select private.is_owner()));

-- product_cost_history
alter table public.product_cost_history enable row level security;
grant select, insert, update, delete on table public.product_cost_history to authenticated;
grant select, insert, update, delete on table public.product_cost_history to service_role;

create policy product_cost_history_select on public.product_cost_history
  for select to authenticated
  using ((select private.is_member()));
create policy product_cost_history_insert on public.product_cost_history
  for insert to authenticated
  with check ((select private.is_member()));
create policy product_cost_history_update on public.product_cost_history
  for update to authenticated
  using ((select private.is_member()))
  with check ((select private.is_member()));
create policy product_cost_history_delete_owner on public.product_cost_history
  for delete to authenticated
  using ((select private.is_owner()));

-- stock_movements
alter table public.stock_movements enable row level security;
grant select, insert, update, delete on table public.stock_movements to authenticated;
grant select, insert, update, delete on table public.stock_movements to service_role;

create policy stock_movements_select on public.stock_movements
  for select to authenticated
  using ((select private.is_member()));
create policy stock_movements_insert on public.stock_movements
  for insert to authenticated
  with check ((select private.is_member()));
create policy stock_movements_update on public.stock_movements
  for update to authenticated
  using ((select private.is_member()))
  with check ((select private.is_member()));
create policy stock_movements_delete_owner on public.stock_movements
  for delete to authenticated
  using ((select private.is_owner()));

-- price_quotes
alter table public.price_quotes enable row level security;
grant select, insert, update, delete on table public.price_quotes to authenticated;
grant select, insert, update, delete on table public.price_quotes to service_role;

create policy price_quotes_select on public.price_quotes
  for select to authenticated
  using ((select private.is_member()));
create policy price_quotes_insert on public.price_quotes
  for insert to authenticated
  with check ((select private.is_member()));
create policy price_quotes_update on public.price_quotes
  for update to authenticated
  using ((select private.is_member()))
  with check ((select private.is_member()));
create policy price_quotes_delete_owner on public.price_quotes
  for delete to authenticated
  using ((select private.is_owner()));

-- sync_probe (diagnostics)
alter table public.sync_probe enable row level security;
grant select, insert, update, delete on table public.sync_probe to authenticated;
grant select, insert, update, delete on table public.sync_probe to service_role;

create policy sync_probe_select on public.sync_probe
  for select to authenticated
  using ((select private.is_member()));
create policy sync_probe_insert on public.sync_probe
  for insert to authenticated
  with check ((select private.is_member()));
create policy sync_probe_update on public.sync_probe
  for update to authenticated
  using ((select private.is_member()))
  with check ((select private.is_member()));
create policy sync_probe_delete_owner on public.sync_probe
  for delete to authenticated
  using ((select private.is_owner()));
