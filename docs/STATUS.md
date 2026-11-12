# HappyHome Shipping Hub — status

Last updated: 12 Nov 2026, end of **Phase 1 — Foundation**.
Phase prompts: `docs/shipping-hub-build-prompts.md` (the resume prompt mentions `docs/PHASES.md`; that file does not exist, use the prompt pack).

| Phase | State |
|---|---|
| 1 Foundation | Done. CI green on GitHub (both jobs, [run 43278493221](https://github.com/Ceco1223444/Shopify_billing_system/actions/runs/43278493221)). Hosted project: migrations **not pushed yet** (needs your project ref, step 9 below). |
| 2–13 | Not started |

## Setup (15 steps)

Local development (everything runs on your computer, nothing touches the hosted project):

1. Install **Node 24**, **Docker Desktop**, and pnpm: `npm install -g pnpm@12.18.0`.
2. `git clone https://github.com/Ceco1223444/Shopify_billing_system.git`, then `pnpm install` in the folder.
3. Start Docker Desktop, then `pnpm db:start`. The first time it downloads the Supabase images (a few minutes). It applies every migration to a fresh local database.
4. `pnpm env:local` writes `apps/web/.env.local` and `tests/.env.test.local` (local URL and keys; both git-ignored).
5. `pnpm member:add --email you@example.com --name "Ceco" --role owner`. With no `--password` it prints a generated one.
6. `pnpm dev`, open http://localhost:5173 and log in. `/dev/sync` is the connection-check page.
7. Checks: `pnpm lint`, `pnpm typecheck`, `pnpm test` (unit), `pnpm test:integration` (DB, RLS, realtime, storage), `pnpm test:e2e` (browser; first time: `pnpm --filter @happyhome/tests exec playwright install chromium`).
8. After changing a migration: `pnpm db:reset` (rebuilds from zero), then `pnpm db:types`, and commit the regenerated `packages/core/src/database.types.ts`.

Hosted Supabase project (EU / Frankfurt):

9. `pnpm exec supabase login`, then `pnpm exec supabase link --project-ref <your project ref>`.
10. `pnpm exec supabase db push` applies the 5 migrations (tables, grants, RLS, realtime, buckets, settings).
11. In the dashboard: **Authentication → Sign In / Providers**: turn **off** "Allow new users to sign up" and keep Email on. **Realtime → Settings**: turn **off** "Allow public access" (the app only uses private channels). Leave Data API on, auto-expose OFF and automatic RLS ON as they are.
12. Create `.env.admin` in the repo root (git-ignored) with `SUPABASE_URL=` and `SUPABASE_SECRET_KEY=` from **Project Settings → API Keys**. The secret key bypasses every rule: keep it only on your own computer.
13. `pnpm member:add --env-file .env.admin --email … --name "Ceco" --role owner`, then the same for Мама and Тате with `--role packer`.
14. Copy `apps/web/.env.example` to `apps/web/.env.hosted.local`, fill in the URL and the **publishable** key, then run `pnpm dev:hosted`.
15. Your check: log in as two people in two browsers (or laptop + phone), open `/dev/sync` in both, and see "… гледа тази пратка" and the shared text update live.

## What Phase 1 built

- **Monorepo** (pnpm workspaces): `apps/web` (React 19 + Vite 8 + TypeScript), `apps/desktop` (placeholder), `packages/core` (pure TS: money/date formatting, domain vocabulary, settings defaults, generated DB types), `supabase/` (config + migrations), `tests/` (integration + e2e), `scripts/` (env, types, members).
- **Toolchain**: TypeScript 6.0 strict (`noUncheckedIndexedAccess`), ESLint 10 (typescript-eslint, React Hooks, and `i18next/no-literal-string`, which fails the lint if a UI string is not in the locale files), Prettier, Vitest 5, Playwright.
- **CI** (`.github/workflows/ci.yml`), on every push and PR:
  - job `checks`: lint + typecheck + unit tests;
  - job `database`: starts Supabase, `db reset` (migrations from zero), checks the generated types are current, then the integration and e2e tests.
- **Database** (`supabase/migrations/`):
  - `…120000_foundation`: PostGIS (in `extensions`), `private` schema, row-meta trigger (created_at / updated_at / updated_by / version), audit trigger, `audit_log`, `members`, `private.is_member()` / `private.is_owner()`.
  - `…120100_domain`: import_batches, orders, order_lines, products, courier_offices (PostGIS `location` kept in sync from lat/lng, GiST index), shipments, shipment_orders, flags, product_cost_history, stock_movements, geocode_cache, tariffs, price_quotes, settings, sync_probe (diagnostics). Required uniques/indexes: `orders.shopify_id` unique (Name is the unique fallback when there is no Id), indexes on phone_norm / email_norm / created_at_shopify, `courier_offices (carrier, external_id)` unique, one waybill number per shipment.
  - `…120200_security`: **explicit GRANTs and RLS policies for every table** (details below).
  - `…120300_realtime_storage`: realtime publication (orders, shipments, flags, products, sync_probe); policies on `realtime.messages` for private `shop:*` channels; private buckets `raw-imports`, `product-photos`, `labels` with member/owner policies.
  - `…120400_seed_settings`: the 14 default settings (`ON CONFLICT DO NOTHING`, so the owner's changes are never overwritten).
- **Web shell**: login, "no access" screen for logins that are not members, top bar (shop name, who else is online, user + role, БГ/EN, sign out), navigation with six empty pages, a presence channel ("Мама гледа тази пратка", `useViewingShipment(id)` + `<ViewersBadge>`), and `/dev/sync` (connection check, dev builds only).
- **i18n**: i18next; `bg` default, `en` complete; keys are type-checked; a unit test checks that both locale files have the same keys and placeholders.

## Security model (hosted settings: Data API on, auto-expose OFF, auto-RLS ON)

| Role | Gets |
|---|---|
| `anon` (signed out) | No GRANT on any table: every request returns *permission denied*. Cannot join private channels or read files. |
| `authenticated`, not a member | Grants exist, but RLS hides every row. Sees the "Нямате достъп" screen. |
| packer | Reads everything; inserts/updates shop data; **cannot** write settings, tariffs, members; cannot delete anything. |
| owner | Everything a packer can do, plus settings, tariffs, members and deletes. |
| `service_role` (Edge Functions / scripts) | All tables; bypasses RLS. `audit_log` is read-only even here. |

- `audit_log`, `courier_offices`, `geocode_cache`: SELECT only for signed-in users. Offices and geocodes come from Edge Functions (the app never invents courier data); the audit log is written only by the trigger.
- Local config sets `auto_expose_new_tables = false`, and migration 1 also revokes default privileges. A missing GRANT therefore fails locally, just as it would on the hosted project.
- Tests that prove it: `tests/integration/schema.test.ts` (RLS on + a policy on every table, anon has zero privileges, exact privileges per role), `rls.test.ts` (anon / outsider / packer / owner through the real API), `storage.test.ts`, `realtime.test.ts`.

## Decisions and assumptions (tell me if any is wrong)

- `raw_csv_retention_days` = **90**. The Phase 1 prompt left the placeholder `<<e.g. 90>>`. Change it in settings later.
- Money is always shown in bg-BG ("12,34 €"), in both languages. Dates are bg-BG in the Bulgarian UI and en-GB in the English UI, always in Europe/Sofia time.
- **Optimistic locking**: every update bumps `version`. A client that sends `version` (the one it loaded) gets HTTP 409 / code `PT409` if someone saved in between. Updates without `version` are last-write-wins.
- `updated_by` and `audit_log.actor` are plain uuids (no foreign key), so history survives deleting a person.
- Audit: every insert/update/delete on every table is logged. On the cache tables (`courier_offices`, `geocode_cache`, `price_quotes`) only edits by a signed-in person are logged, so nightly office syncs don't flood the log.
- `sync_probe` is a tiny diagnostics table: the connection-check page and the e2e test edit it instead of real shop data.
- TypeScript **6.0**, not 7: typescript-eslint does not support TS 7 yet.
- Role label in Bulgarian: "packer" is shown as "опаковане".

## Known gaps

- Hosted project: migrations not pushed and members not created yet (steps 9–13; I need your project ref, and you run `supabase login` yourself).
- PWA install (manifest + service worker) is left for Phase 12, where the prompt pack puts the install prompt.
- `apps/desktop` is only a placeholder (Phase 12).
- The web bundle is 542 kB (159 kB gzipped). Vite warns above 500 kB; code-splitting can wait for Phase 12.
- Packers cannot delete rows, including `shipment_orders`. If Phase 3 lets packers split a combined shipment, that needs an RPC or a "detached" flag instead of a delete.
- The repository is **public**. Never commit real CSV exports, customer data, `.env*` files or keys.

## API / tool differences found

- Supabase CLI 3.x reports **publishable / secret** keys (`sb_publishable_…`, `sb_secret_…`) next to the legacy anon / service_role JWTs. The app and scripts use the new keys and fall back to the legacy ones.
- `supabase db lint` reports errors inside PostGIS's own functions (extension code, not ours). Lint our schemas with `pnpm exec supabase db lint -s public,private`: clean. `supabase db advisors`: no issues.
