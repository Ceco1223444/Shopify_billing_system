# HappyHome Shipping Hub — status

Last updated: 13 Nov 2026, end of **Phase 3 — Build shipments** (branch `phase-3-shipments`).
Phase prompts: `docs/shipping-hub-build-prompts.md` (the resume prompt mentions `docs/PHASES.md`; that file does not exist, use the prompt pack).

| Phase | State |
|---|---|
| 1 Foundation | Done. CI green on GitHub (both jobs, latest: [run 43300056112](https://github.com/Ceco1223444/Shopify_billing_system/actions/runs/43300056112), after the live-sync fixes). Hosted project `Shopify_billing_system` (`nugmzqjdvmzhitgzhhit`, eu-west-1 Ireland): all 5 migrations pushed 12 Nov 2026. Still to do by the owner: steps 11–14. |
| 2 Import Shopify CSV batches | Done. CI green on GitHub (both jobs, [run 43324121555](https://github.com/Ceco1223444/Shopify_billing_system/actions/runs/43324121555)). Hosted (13 Nov 2026): migration `20261113120000_import_batches` pushed and the `import-batch` Edge Function deployed (steps 16–17); advisors show no new warnings. The owner chose to skip the local test and import real exports on the hosted project (step 18). The two brief differences below were accepted by deploying. |
| 3 Build shipments | Built on branch `phase-3-shipments`. Local checks green: lint, typecheck, 71 core + 23 web unit tests, 114 integration tests, 16 e2e tests. Merge to `main` + tag `phase-3` once CI is green; then the hosted migration (step 19). |
| 4–13 | Not started |

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

9. In a normal PowerShell window (not via `!` in Claude Code: login needs an interactive terminal) run `pnpm exec supabase login` and enter the verification code shown in the browser. Then `pnpm exec supabase link --project-ref nugmzqjdvmzhitgzhhit`.
10. `pnpm exec supabase db push --remote --dry-run`, then `pnpm exec supabase db push --remote`. In CLI v3, `db push` targets the local stack unless you pass `--remote`. No database password is needed.
11. In the dashboard: **Authentication → Sign In / Providers**: turn **off** "Allow new users to sign up" and keep Email on. **Realtime → Settings**: turn **off** "Allow public access" (the app only uses private channels). Leave Data API on, auto-expose OFF and automatic RLS ON as they are.
12. Create `.env.admin` in the repo root (git-ignored) with `SUPABASE_URL=` and `SUPABASE_SECRET_KEY=` from **Project Settings → API Keys**. The secret key bypasses every rule: keep it only on your own computer.
13. `pnpm member:add --env-file .env.admin --email … --name "Ceco" --role owner`, then the same for Мама and Тате with `--role packer`.
14. Copy `apps/web/.env.example` to `apps/web/.env.hosted.local`, fill in the URL and the **publishable** key, then run `pnpm dev:hosted`.
15. Your check: log in as two people in two browsers (or laptop + phone), open `/dev/sync` in both, and see "… гледа тази пратка" and the shared text update live.

Phase 2 on the hosted project (after the phase is merged; same terminal as step 9):

16. `pnpm exec supabase db push --remote --dry-run`, then `pnpm exec supabase db push --remote` (adds `20261113120000_import_batches`).
17. `pnpm exec supabase functions deploy import-batch`. It reads `verify_jwt = false` from `supabase/config.toml`: the function checks the login itself and lets only the owner import.
18. Your check (prompt pack): import the same real export twice → the second one is refused. Import an overlapping export → only the new orders count as new. Then open the batch, press **Изтегли Excel**, and compare it with the legacy tool's file.

Locally, `pnpm db:start` already serves the Edge Function (the local stack includes the edge runtime).

Phase 3 on the hosted project (after the phase is merged):

19. `pnpm exec supabase db push --remote --dry-run`, then `pnpm exec supabase db push --remote` (adds `20261114120000_shipments`). The migration also builds shipments for the orders imported before it, batch by batch. No Edge Function change (it passes the new `shipments` summary through).
20. Your check (prompt pack): a CSV with two orders from the same phone number to the same address → one shipment. The same phone to a different address → two shipments + a call flag.

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
- **Realtime helpers** (`apps/web/src/lib/realtime.ts`): every channel goes through `openPrivateChannel()`, and presence updates go through `createLatestSender()`. See "Fixes after the first hosted test" below. A menu link "Проверка на връзката" appears wherever the dev pages are on.
- **One browser = one login**: if another tab of the same browser signs in as someone else, this window shows an amber notice. Otherwise it would silently carry on as that person, and the audit log would record their name.
- **i18n**: i18next; `bg` default, `en` complete; keys are type-checked; a unit test checks that both locale files have the same keys and placeholders.

## What Phase 2 built

- **Ported converter** (`packages/core/src/import/`): decode (UTF-8, UTF-8 BOM, UTF-16 LE/BE, Windows-1251), detectDelimiter, parseCSV, readFile (continuation rows, apostrophe strip), validateOrder, phoneProblem, phoneMatchKey, repeated orders, productsKey, groupCustomers, buildXlsx, zip. The legacy English messages are kept word for word; every code also has a plain Bulgarian text and a "why" line (`messages.ts`).
- **Legacy parity** (`packages/core/test/`): the legacy `<script id="core">` is loaded in Node (`node:vm`) and run next to the port on the legacy `sampleFiles()` plus 19 synthetic files (Windows-1251, semicolon, UTF-16 LE/BE, columns reordered, cut off mid-quote, messy phones and addresses, alias headings…). Orders, lines, issues and the XLSX bytes are identical. A workbook rebuilt later from the stored rows is byte-identical too.
- **Browser → Edge Function → one transaction**: the browser parses the file (`buildImportPayload`) and posts the raw file + the parsed result to `supabase/functions/import-batch`. The function checks the login (owner only), the size (50 MB) and the SHA-256, stores the file as `raw-imports/<year>/<batch id>.csv`, then calls `public.import_commit(...)`. That writes the batch, orders, lines, flags and the audit diff in **one transaction**. If the database part fails, the stored file is removed again. Logs contain only error codes, never customer data.
- **Migration `20261113120000_import_batches`**: batch columns (sha256 unique, uploader, counts, columns found, archive state), more typed order columns (billing / customer phone, province, discount, refunds, tags, payment terms), `order_lines.source_row`, `import_batch_orders` (what each batch did to each order: new / updated / unchanged + diff), flag columns (source batch and row, issue key, origin), the setting `visible_columns`, owner-only RLS on batches, storage policies (raw files: only the owner reads them, and a delete works only once the file is archived), and the functions `import_commit`, `archive_mark_due`, `archive_confirm`, `archive_mark_deleted`.
- **Upsert rule** (key: Shopify Id, else Name): new → insert. Identical → a "seen again" row in `import_batch_orders`. Changed → update + diff in `audit_log` (reason `shopify_reimport: <file>`) + the flag "Поръчката е променена в Shopify след внасянето" (amber; red if a shipment has a waybill). Cancelled later → red flag, and the shipment is set to `cancelled` unless it is already handed over, delivered or returned.
- **Flags**: every legacy issue becomes a flag (error → red, warning → amber, info → grey) with code, Bulgarian + English text, reason, source batch and row. Re-importing does not repeat a flag that is open or was resolved. A check that no longer applies in a newer file is resolved automatically, with a note.
- **Web**:
  - `/import`: a big drop zone (several files at once), progress, a summary card per file ("12 нови поръчки · 3 вече внесени · 1 променена · 2 за проверка"). A duplicate file is refused with a Bulgarian message. History of every file: date, counts, size, SHA-256, archive state.
  - `/import/:id`: batch details, the order lines with the chosen columns (default: photo + the legacy 18), yellow rows like the legacy tool, and the flags. **Изтегли Excel** gives the legacy workbook with the chosen columns, yellow rows and the Warnings sheet. **Изтегли CSV** gives the original file while it is still in the cloud.
  - `/settings` (owner): column chooser (every column found in the imported files; tick, drag, or arrows) and "Архив на CSV файловете".
  - Import is not in the packers' menu. The owner's screens load on demand.
- **Raw CSV archive** (`apps/web/src/archive/`): when the owner opens the app, files older than `raw_csv_retention_days` (90) become "Чака архивиране". If a folder is chosen on that computer (Chrome / Edge: File System Access API; the folder is kept in IndexedDB; permission is asked again when the browser wants it), each file is saved to `<folder>/<year>/<import date>_<file name>.csv`. Nothing is overwritten (" (2)", " (3)"…). The copy is read back and checked by size and SHA-256, then recorded (date, computer, path), and only then deleted from cloud storage. Without a folder nothing is deleted, and a banner says "N CSV файла чакат архивиране". Firefox / Safari: **Изтегли ZIP**, then **Свалих ги**. **Архивирай сега** archives everything at once. The batch history keeps the name, size, SHA-256 and archive date permanently.

### Phase 2 tests

| ID | Where |
|---|---|
| T2-01 legacy parity | `packages/core/test/legacy-parity.test.ts` |
| T2-02 1251 / semicolon / UTF-16 / reordered / cut off | same file (synthetic fixtures in `packages/core/test/synthetic.ts`) |
| T2-03 same file twice | `tests/integration/import.test.ts`, `tests/e2e/import.spec.ts` |
| T2-04 overlapping exports | `tests/integration/import.test.ts` |
| T2-05 changed order (amber; red with a waybill) | `tests/integration/import.test.ts` |
| T2-06 cancelled order (a handed-over shipment stays as it is) | `tests/integration/import.test.ts` |
| T2-07 import as packer / outsider / signed out | `tests/integration/import.test.ts`, `tests/e2e/import.spec.ts` |
| T2-08 hide + reorder columns | `tests/e2e/import.spec.ts` (view + Excel headings + stored data unchanged), `packages/core/src/import/app.test.ts`, `tests/integration/import.test.ts` |
| T2-09 past retention, folder chosen | `apps/web/src/archive/archiver.test.ts`, `tests/integration/archive.test.ts`, `tests/e2e/import.spec.ts` (the real folder API, on the browser's private file system) |
| T2-10 past retention, no folder | `tests/integration/archive.test.ts`, `tests/e2e/import.spec.ts` (banner) |
| T2-11 name already in the folder | `apps/web/src/archive/archiver.test.ts` |
| T2-12 write fails | `apps/web/src/archive/archiver.test.ts` (plus checksum, read-back and record failures) |
| ZIP fallback | `apps/web/src/archive/archiver.test.ts`, `tests/e2e/import.spec.ts` |

## What Phase 3 built

- **Where the rules run:** in the database, at the end of `import_commit`, in the same transaction as the import (`private.build_shipments`, migration `20261114120000_shipments`). An order is never left half-shipped, and the rules see the same data the import just wrote. Display helpers are in `packages/core/src/shipments.ts`.
- **Same customer** = the same `phone_norm` (legacy `phoneMatchKey` of Shipping Phone) **or** the same `email_norm` (trimmed, lower case). Never the name.
- **Same destination** = the office text + city when Address1 or Address2 names a courier office / locker (офис, еконт, спиди, автомат, пакетомат, office, econt, speedy, locker, box now), otherwise Address1 + Address2 + City + Zip. Lower case, punctuation and spaces ignored. An order without any address is never combined.
- **Rules:**
  - P3-01: an order is in one shipment only (unique index).
  - P3-02: same customer + same destination in one batch → one shipment.
  - P3-03: same customer, different destinations in one batch → separate shipments + amber "Един клиент, различни адреси — обадете се" on each order, linked to the others.
  - P3-04: same customer + destination as an unsent shipment from another import → separate + amber "Същият клиент има неизпратена пратка от друго внасяне (#X) — да ги обединим?" on both shipments, with **Обедини** / **Остави ги отделно** for the owner.
  - P3-05: same name only → grey "Същото име като поръчка #X — вероятно различни хора" on both orders.
  - P3-06: the customer + destination already has a shipment with a waybill → separate + flag "Вече има създадена пратка за този клиент (#X)". The old shipment is not touched.
  - P3-07: cancelled, fulfilled and nothing-to-ship orders get no shipment and a grey flag saying why.
  - P3-08 / P3-09: same customer within `settings.duplicate_window_hours` (48 h, by Created at), also across imports → identical products (SKU or name + quantity, any line order) → red flag on both orders with the two orders side by side; overlapping products → amber.
  - P3-14: status `needs_check` with any open red / amber flag on the shipment or its orders, else `ready`.
- **Combined values:** recipient (name, phone, email, address) from the **earliest** order. Fields a person set by hand (`manual_overrides`) are kept. Different names / phones / emails between the combined orders → a grey flag listing them. COD = sum over the COD orders of Outstanding Balance (fallback Total); prepaid orders add 0. `cod_breakdown` stores the amount and its source per order. `contents` lists the products to ship; `reference` = "#2002 + #2007". Weight stays empty (Phase 7).
- **Cancelled in a later import (T3-10):** if every order of the shipment is cancelled, the shipment is cancelled (Phase 2 rule). If other orders still travel and there is no waybill, the cancelled order is taken out and the values are recomputed. With a waybill: a red flag on the shipment, nothing changed automatically.
- **Manual controls (owner only, P3-10 … P3-13):** RPCs `shipment_split`, `shipment_merge`, `shipment_keep_apart`. Each checks the role, writes an explicit `audit_log` row (`manual_split` / `manual_merge`) and accepts the version the owner confirmed (409 if someone changed it meanwhile). RLS: only the owner may create shipments or insert / update / delete `shipment_orders`. A re-import never moves an order that is already in a shipment, and an answered merge suggestion is never asked again.
- **Every automatic decision has its reason** in `shipments.decision_reasons` (code + bg + en), shown as "Защо е така".
- **Web:**
  - **Пратки** lists shipments (not orders): order numbers, recipient, city, COD, status, flag counts and the "Обединени: телефон / имейл / ръчно" chip. Filters: За проверка / Готови / Неизпратени / Всички. Live updates.
  - The owner ticks two shipments → **Обедини избраните**, with a confirmation step.
  - The shipment page shows the recipient (+359 `tel:` link and the number as typed), COD per order with its source, the contents, the flags (merge / keep apart, links to related orders, possible duplicates side by side), **Отдели в отделна пратка** per order (with confirmation), and why it was combined.
  - Packers see only shipments that do not need checking ("N пратки чакат проверка от собственика") and no split / merge controls.
- **Backfill:** the migration builds shipments for the orders imported before it, batch by batch in import order: the same result as if Phase 3 had been there from the start.

### Phase 3 tests

| ID | Where |
|---|---|
| T3-01 … T3-16 | `tests/integration/shipments.test.ts` (table-driven; customers unique per run) |
| COD sum / breakdown, recipient differences, P3-14, merge suggestion answered | same file |
| Phase 2 tests with the new shipments (T2-05, T2-06) | `tests/integration/import.test.ts` |
| RLS: `shipment_orders` owner-only writes | `tests/integration/schema.test.ts` via `OWNER_WRITE_TABLES` |
| Screens: owner list + chip + split + merge; packer view | `tests/e2e/shipments.spec.ts` |
| Helpers (open statuses, packer visibility, `tel:` links, list order) | `packages/core/src/shipments.test.ts` |

## Security model (hosted settings: Data API on, auto-expose OFF, auto-RLS ON)

| Role | Gets |
|---|---|
| `anon` (signed out) | No GRANT on any table: every request returns *permission denied*. Cannot join private channels or read files. |
| `authenticated`, not a member | Grants exist, but RLS hides every row. Sees the "Нямате достъп" screen. |
| packer | Reads everything except import batches and raw CSV files; inserts/updates shop data; **cannot** import, create shipments, move orders between shipments (split / merge), write settings, tariffs, members; cannot delete anything. |
| owner | Everything a packer can do, plus import, raw CSV files, settings, tariffs, members and deletes. A raw CSV can be deleted only after its archive copy is confirmed. |
| `service_role` (Edge Functions / scripts) | All tables; bypasses RLS. `audit_log` is read-only even here. |

- `audit_log`, `courier_offices`, `geocode_cache`: SELECT only for signed-in users. Offices and geocodes come from Edge Functions (the app never invents courier data); the audit log is written only by the trigger.
- Local config sets `auto_expose_new_tables = false`, and migration 1 also revokes default privileges. A missing GRANT therefore fails locally, just as it would on the hosted project.
- Tests that prove it: `tests/integration/schema.test.ts` (RLS on + a policy on every table, anon has zero privileges, exact privileges per role), `rls.test.ts` (anon / outsider / packer / owner through the real API), `storage.test.ts`, `realtime.test.ts`.

## Fixes after the first hosted test (12 Nov 2026)

Reported: "the base changes, but when one person connects the other disconnects; it only works one side at a time." Three causes, found with frame logs and reproduced locally with 120 ms of simulated WebSocket latency:

1. **Double channel joins.** React StrictMode (dev) and quick navigation re-opened a topic while the old channel was still open or closing. realtime-js hands back the old channel, and the server closes the older join (`phx_close`). The late close then killed the new subscription: "Няма връзка", and the person dropped out of presence. Fix: `openPrivateChannel()` waits until the previous channel is gone, creates a fresh one, subscribes once, and ignores events from closed channels.
2. **Presence rate limit.** Opening and leaving a shipment quickly sent many presence updates. The server replied "Client presence rate limit exceeded" and closed the channel, and realtime-js does not re-join after a close. Fix: updates are combined (latest only, after 300 ms of quiet, never a repeat), and a channel closed by the server is re-opened with back-off (2 s, doubling, max 30 s).
3. **Shared login per browser.** Two tabs of one browser are always the same person. Logging in as Мама in one tab turns every tab into Мама. This is browser behaviour, not a bug. The app now warns about it (see "One browser = one login" above). To test with two people, use two browsers or an Incognito window.

Tests: `apps/web/src/lib/realtime.test.ts` (unit) and `tests/e2e/reconnect.spec.ts` (e2e with simulated latency, run 5× without failure). The e2e suite now closes every window it opens, and runs its own dev server on port **5199** against the local stack. It never reuses a `pnpm dev:hosted` server on 5173.

## Git workflow (agreed 12 Nov 2026)

- `main` is always the latest working app. Nobody commits to it directly.
- Each phase: `git checkout main && git pull`, then `git checkout -b phase-N-<name>`. Work and push there until CI is green and the phase's DONE WHEN holds.
- Finish a phase: fast-forward `main` to the phase branch (`git merge --ff-only`), tag it `phase-N`, and push both.
- Tags are frozen snapshots: `git checkout phase-1` shows the app exactly as Phase 1 left it.
- Hosted database: push a phase's migrations (`supabase db push --remote`) when the phase is merged, after a `--dry-run`.

## Decisions and assumptions (tell me if any is wrong)

- `raw_csv_retention_days` = **90**. The Phase 1 prompt left the placeholder `<<e.g. 90>>`. Change it in settings later.
- Money is always shown in bg-BG ("12,34 €"), in both languages. Dates are bg-BG in the Bulgarian UI and en-GB in the English UI, always in Europe/Sofia time.
- **Optimistic locking**: every update bumps `version`. A client that sends `version` (the one it loaded) gets HTTP 409 / code `PT409` if someone saved in between. Updates without `version` are last-write-wins.
- `updated_by` and `audit_log.actor` are plain uuids (no foreign key), so history survives deleting a person.
- Audit: every insert/update/delete on every table is logged. On the cache tables (`courier_offices`, `geocode_cache`, `price_quotes`) only edits by a signed-in person are logged, so nightly office syncs don't flood the log.
- `sync_probe` is a tiny diagnostics table: the connection-check page and the e2e test edit it instead of real shop data.
- TypeScript **6.0**, not 7: typescript-eslint does not support TS 7 yet.
- Role label in Bulgarian: "packer" is shown as "опаковане".

Phase 2:

- **Two differences from the brief (MASTER_PROMPT). I followed the Phase 2 spec (deployed to hosted on 13 Nov 2026 at the owner's request):**
  1. The brief says a packer "can do everything else". Phase 2 says import is owner-only ("Packers MUST NOT see or use it"). Import, the batch screens and the raw files are owner-only (RLS, Edge Function and UI).
  2. The brief says raw CSVs are "deleted automatically after `raw_csv_retention_days`". Phase 2 says a raw CSV must never be deleted before its archive copy is confirmed. So after 90 days a file only becomes "Чака архивиране". It is deleted once the copy on the owner's computer has been checked.
- Hidden by default: **nothing** (P2-11). The prompt pack's `<<LIST THE COLUMNS YOU WANT REMOVED>>` was never filled in; hide columns in Settings.
- If one file contains the same order twice (legacy "repeated order"), the **first** copy is stored and the order gets a red flag.
- Changes are detected only on the columns the newer file has: a column missing from the newer file is not treated as "deleted". Line breaks and spaces around values are ignored when comparing.
- When an order is cancelled in Shopify, the "cancelled" flag replaces the "changed" flag for that import.
- Checks from an older file that no longer apply in a newer file are resolved automatically ("Вече го няма в по-новото внасяне").
- The archive folder is per computer (per browser). The computer name in the archive history is set in Settings; the default is the system and browser, e.g. "Windows · Chrome".
- "Изтегли Excel" keeps the legacy sheet names (Shipping / Warnings / Notes) and headings (`order_id` for Name), because the legacy delivery board reads them.

Phase 3:

- **Two differences from the brief again (the brief says a packer "can do everything else"). I followed the Phase 3 spec; please confirm:**
  1. Split and merge are owner-only (P3-12), enforced by RLS and the RPCs.
  2. Packers do not see shipments in `needs_check` (P3-15 and the acceptance list). This is a **screen filter**, not RLS. The brief says the parents call the customers the app tells them to call; Phase 8 (their workspace) can then show them the "call" items without a database change. Tell me if packers should never be able to read them at all.
- "Different batches" (P3-04) means the existing shipment was created by an earlier import (or by a manual split). Orders already in a shipment are never re-grouped.
- P3-06 looks only at shipments with a waybill that are not handed over yet (`waybill_created`, `printed`, `printed_draft`). A customer whose earlier parcel was already delivered gets no flag (the 48-hour duplicate check still applies).
- Name-only matches (P3-05) are checked within the batch and against unsent shipments, not against every order ever, to avoid noise for common names.
- The same customer with a different address in a **later** import gets no flag (the spec only covers the same batch); the 48-hour duplicate check still applies. Tell me if you want a flag there too.
- "Overlapping products" (P3-09) = at least one product (SKU, else name) in common, ignoring quantities.
- Exclusion flags (cancelled / fulfilled / nothing to ship) are grey: nothing to do. Recipient differences in a combined shipment are grey too, with the values listed.
- A merge deletes the second shipment row (its flags move to the merged one; `audit_log` keeps both). A split makes a new shipment. Both mark `manual_overrides.orders`.

## Known gaps

- Hosted project: migrations are pushed. Still to do by the owner: sign-ups off, Realtime public access off, `.env.admin`, creating the members, `.env.hosted.local` (steps 11–14).
- The hosted project is in **eu-west-1 (Ireland)**, not Frankfurt. That is still EU, as the brief requires. The owner chose to keep it on 12 Nov 2026.
- Hosted advisors show 2 WARN items for `public.rls_auto_enable()`. Supabase created that function for the "automatic RLS" setting; our migrations did not. It is SECURITY DEFINER and `anon` / `authenticated` may EXECUTE it. A live call through `/rest/v1/rpc/rls_auto_enable` fails (`0A000 cannot display a value of type event_trigger`), and the function only works inside an event trigger. Not exploitable as far as we can tell. Optional clean-up: revoke EXECUTE from anon/authenticated (waiting for the owner's OK).
- PWA install (manifest + service worker) is left for Phase 12, where the prompt pack puts the install prompt.
- `apps/desktop` is only a placeholder (Phase 12).
- Web bundle: the import, batch and settings screens are split out and load on first visit. Every user downloads about 570 kB (170 kB gzipped) in two chunks, so Vite no longer warns.
- **Desktop app archive path**: browsers never reveal a folder's full path. The desktop app (Phase 12) must ask for the folder once with its own dialog and provide `window.happyhomeDesktop.archiveFolder`. The web side already uses it when it is there.
- **No real exports tested yet.** The prompt pack asks for 2–3 anonymized real Shopify exports; only the legacy samples and synthetic files were used. If a real export has a column or format the legacy tool does not handle, the Phase 2 spec says to stop and ask.
- CI's database job now also starts the edge runtime, which the import tests need.
- Shipments are built in SQL (plpgsql), not in `packages/core`, so the import stays one transaction. The rules are covered by the integration tests rather than core unit tests.
- Office detection for "same destination" is a keyword heuristic until Phase 5 (real office / locker detection).
- Packers cannot delete rows, including `shipment_orders`. If Phase 3 lets packers split a combined shipment, that needs an RPC or a "detached" flag instead of a delete.
- The repository is **public**. Never commit real CSV exports, customer data, `.env*` files or keys.

## API / tool differences found

- Supabase CLI 3.x reports **publishable / secret** keys (`sb_publishable_…`, `sb_secret_…`) next to the legacy anon / service_role JWTs. The app and scripts use the new keys and fall back to the legacy ones.
- Supabase CLI 3.x: `db push`, `db advisors` etc. default to the **local** stack. Use `--remote` for the linked project. `supabase login` refuses to run without an interactive terminal (`LoginMissingTokenError`).
- Hosted checks run 12 Nov 2026: a signed-out request to `settings`, `members`, `orders` or `audit_log` returns 401 / `42501 permission denied`; a signed-out storage listing returns `[]`. The hosted project has both legacy (anon / service_role) and new (publishable / secret) keys. Use the new ones.
- `supabase db lint` reports errors inside PostGIS's own functions (extension code, not ours). Lint our schemas with `pnpm exec supabase db lint -s public,private`: clean. `supabase db advisors`: no issues.
