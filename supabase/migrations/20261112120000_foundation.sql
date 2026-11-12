-- Phase 1 / migration 1 — foundation
-- Extensions, the private schema, default privileges, shared trigger functions,
-- the audit log and the members table (who may use the app, and with which role).

-- PostGIS for "nearest office" searches (Phase 4). Installed outside `public`.
create extension if not exists postgis with schema extensions;

-- ---------------------------------------------------------------------------
-- Default privileges
-- The hosted project has "Automatically expose new tables" turned OFF. Repeat
-- that here so local databases behave the same: nothing that `postgres`
-- creates in `public` is reachable through the Data API roles until a
-- migration GRANTs it explicitly (see 20261112120200_security.sql).
-- ---------------------------------------------------------------------------
alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke all on functions from anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Private schema: helper and trigger functions. Not exposed by the Data API.
-- ---------------------------------------------------------------------------
create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;

-- Keeps the standard row columns honest on every table:
--   created_at  set once on insert, never changed
--   updated_at  set on every write
--   updated_by  the signed-in user who wrote the row (null = system / service role)
--   version     1 on insert, +1 on every update (optimistic locking)
-- Optimistic locking: an UPDATE may include `version` = the version the user
-- was looking at. If the row has moved on, the update fails with SQLSTATE
-- PT409, which the Data API returns as HTTP 409. An UPDATE without `version`
-- is accepted (last write wins); clients can also filter `.eq('version', v)`.
create or replace function private.set_row_meta()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.updated_at := new.created_at;
    new.version := 1;
  else
    if new.version is distinct from old.version then
      raise exception 'version_conflict: %.% is at version %, the edit was based on version %',
        tg_table_name, old.id, old.version, new.version
        using errcode = 'PT409',
              hint = 'Someone else changed this row. Reload it and apply the edit again.';
    end if;
    new.id := old.id;
    new.created_at := old.created_at;
    new.updated_at := now();
    new.version := old.version + 1;
  end if;
  new.updated_by := auth.uid();
  return new;
end;
$$;

-- Writes one audit_log row per insert / update / delete: who, when, table,
-- row, before and after (jsonb). Updates that change nothing except the
-- standard columns are skipped. Trigger argument 'user_only' skips writes made
-- without a signed-in user (used on cache tables that background jobs refresh).
create or replace function private.audit_row()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_before jsonb;
  v_after jsonb;
  v_row_id uuid;
  v_meta constant text[] := array['updated_at', 'updated_by', 'version'];
begin
  if tg_nargs > 0 and tg_argv[0] = 'user_only' and v_actor is null then
    return null;
  end if;

  if tg_op = 'INSERT' then
    v_after := to_jsonb(new);
    v_row_id := new.id;
  elsif tg_op = 'UPDATE' then
    v_before := to_jsonb(old);
    v_after := to_jsonb(new);
    v_row_id := new.id;
    if (v_before - v_meta) = (v_after - v_meta) then
      return null;
    end if;
  else
    v_before := to_jsonb(old);
    v_row_id := old.id;
  end if;

  insert into public.audit_log (actor, updated_by, table_name, row_id, action, before, after)
  values (v_actor, v_actor, tg_table_name, v_row_id, lower(tg_op), v_before, v_after);
  return null;
end;
$$;

revoke all on function private.set_row_meta() from public, anon, authenticated, service_role;
revoke all on function private.audit_row() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- audit_log — append-only history of every user edit.
-- Written only by private.audit_row(); nobody gets INSERT/UPDATE/DELETE on it.
-- ---------------------------------------------------------------------------
create table public.audit_log (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  actor uuid, -- auth.users.id of the person; null = system / service role
  table_name text not null,
  row_id uuid,
  action text not null check (action in ('insert', 'update', 'delete')),
  before jsonb,
  after jsonb,
  reason text -- written reason, e.g. for an owner override (later phases)
);
comment on table public.audit_log is
  'Append-only: who changed what, when, with before/after. Written by private.audit_row().';

create index audit_log_row_idx on public.audit_log (table_name, row_id, created_at desc);
create index audit_log_created_at_idx on public.audit_log (created_at desc);
create index audit_log_actor_idx on public.audit_log (actor);

-- ---------------------------------------------------------------------------
-- members — one row per person allowed into the app (one shop).
-- ---------------------------------------------------------------------------
create table public.members (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  user_id uuid not null unique references auth.users (id) on delete cascade,
  display_name text not null check (char_length(btrim(display_name)) between 1 and 60),
  role text not null check (role in ('owner', 'packer')),
  active boolean not null default true
);
comment on table public.members is
  'People allowed into the app. role owner = settings, tariffs, deletes; packer = everything else.';

create trigger set_row_meta before insert or update on public.members
  for each row execute function private.set_row_meta();
create trigger audit_row after insert or update or delete on public.members
  for each row execute function private.audit_row();

-- Used by every RLS policy. SECURITY DEFINER so the lookup on members does not
-- recurse through members' own policies.
create or replace function private.is_member()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.members m
    where m.user_id = (select auth.uid()) and m.active
  );
$$;

create or replace function private.is_owner()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.members m
    where m.user_id = (select auth.uid()) and m.active and m.role = 'owner'
  );
$$;

revoke all on function private.is_member() from public, anon;
revoke all on function private.is_owner() from public, anon;
grant execute on function private.is_member() to authenticated, service_role;
grant execute on function private.is_owner() to authenticated, service_role;
