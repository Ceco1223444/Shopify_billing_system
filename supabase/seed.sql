-- Local development seed (runs after migrations on `supabase db reset`, never on the hosted project).
-- Intentionally empty: settings defaults live in migrations, and people are added with
-- `pnpm member:add` (see docs/STATUS.md). Test users are created by the test setup.
select 1;
