# HappyHome Shipping Hub — status

Last updated: 14 Nov 2026, after **Phase 5 — Delivery point detection and certainty** and its hosted set-up (Geoapify instead of Nominatim, see "Phase 5 on the hosted project").
Phase prompts: `docs/shipping-hub-build-prompts.md` (the resume prompt mentions `docs/PHASES.md`; that file does not exist, use the prompt pack).

| Phase | State |
|---|---|
| 1 Foundation | Done. CI green on GitHub (both jobs, latest: [run 43300056112](https://github.com/Ceco1223444/Shopify_billing_system/actions/runs/43300056112), after the live-sync fixes). Hosted project `Shopify_billing_system` (`nugmzqjdvmzhitgzhhit`, eu-west-1 Ireland): all 5 migrations pushed 12 Nov 2026. Still to do by the owner: steps 11–14. |
| 2 Import Shopify CSV batches | Done. CI green on GitHub (both jobs, [run 43324121555](https://github.com/Ceco1223444/Shopify_billing_system/actions/runs/43324121555)). Hosted (13 Nov 2026): migration `20261113120000_import_batches` pushed and the `import-batch` Edge Function deployed (steps 16–17); advisors show no new warnings. The owner chose to skip the local test and import real exports on the hosted project (step 18). The two brief differences below were accepted by deploying. |
| 3 Build shipments | Done. Merged to `main` and tagged `phase-3` (CI green). Hosted migration pushed (step 19, 14 Nov 2026). **Still to do by the owner:** the check in step 20. |
| 4 Courier points + geocoding | Done. Merged to `main` and tagged `phase-4`, CI green ([run 43520647629](https://github.com/Ceco1223444/Shopify_billing_system/actions/runs/43520647629)). Local: 180 core + 29 web + 15 unit tests, 161 integration tests, 20 e2e tests. Hosted (14 Nov 2026): migration pushed, `courier-sync` + `geocode` deployed, Econt secrets set, first "Обнови офисите" done (639 Econt + 1 389 Speedy points, all on the map). **Still to do by the owner:** look at the Plovdiv map (step 25). |
| 5 Delivery point detection | Done. Merged to `main` and tagged `phase-5`, CI green ([run 43547677232](https://github.com/Ceco1223444/Shopify_billing_system/actions/runs/43547677232)). Local: 333 core + 29 web + 16 unit tests, 182 integration tests, 26 e2e tests. Hosted (14 Nov 2026): migration pushed and `detect-delivery` deployed (steps 26–28); 3 of 17 shipments decided. The other 14 need a map, and the public Nominatim refuses Supabase: **branch `phase-5-hosted-geocoder` switches to Geoapify; still to do by the owner: steps 30–34, then step 29.** |
| 6–13 | Not started |

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

Phase 4 on the hosted project (after the phase is merged; same terminal as step 9):

21. `pnpm exec supabase db push --remote --dry-run`, then `pnpm exec supabase db push --remote`. It adds `20261115120000_courier_points` (and `20261114120000_shipments` too, if step 19 is not done yet). It turns on `pg_trgm`, `pg_net` and `pg_cron` and schedules the 5-minute "courier-sync-tick" job.
22. `pnpm exec supabase functions deploy courier-sync`, then `pnpm exec supabase functions deploy geocode`.
23. **Econt production login: done by the owner on 14 Nov 2026.** (Where: **Edge Functions → Secrets** in the Supabase dashboard, `ECONT_USERNAME` and `ECONT_PASSWORD`.) The office list does not need them (it is public). Price calculations use them once `settings.econt_env` is switched from `demo` to `production`; the first production call is also the first check that they are right.
24. Log in as the owner → **Офиси** → **Обнови офисите**. Wait about a minute. This first press also tells the scheduled job where the function lives. After that, Econt updates every night at 03:00 and Speedy once a week (also at night), with no further action.
25. Your check: about 640 Econt and 1 390 Speedy points, all "На картата". Choose Пловдив and check that the points are where you expect them.

Phase 5 on the hosted project (after the phase is merged; same terminal as step 9):

26. `pnpm exec supabase db push --remote --dry-run`, then `pnpm exec supabase db push --remote`. It adds `20261116120000_delivery_detection` (and the Phase 3 / 4 migrations too, if steps 19 / 21 are not done yet). It schedules the 2-minute "delivery-detect-tick" job, and it sets `office_range_km` to 1 and `home_carrier_tie_break` to Econt **only if you never changed them**. Every shipment that is not sent yet is marked "to detect".
27. `pnpm exec supabase functions deploy detect-delivery --yes`.
28. Log in as the owner and open **Пратки**. If step 24 (Обнови офисите) is done, the 2-minute job already knows where the functions are. If not, import a file, or open **Настройки → Доставка** and press **Запази** once: either one tells the job. The chips then appear within a few minutes. The first time, each new address takes about 3 seconds (Nominatim's pace), so a hundred shipments take about 5 minutes.
29. Your check (prompt pack): every shipment in Пратки shows the courier, the type, the office and a chip **Сигурно / Обадете се / Грешка** with the reason. Open an "Обадете се" one: the phone link, the script and the buttons are there. Log in as Мама: the "Обадете се" shipments are in her list too. (Do it after steps 30–34: until then the shipments that need a map stay "Проверява се…".)

Geocoder on the hosted project: Geoapify (after branch `phase-5-hosted-geocoder` is merged):

30. Create a free account at https://myprojects.geoapify.com, create a project (any name), and copy its **API key**.
31. Supabase dashboard → **Edge Functions → Secrets** → add `GEOAPIFY_API_KEY` with that key. Type it there yourself: the key never goes into the code, the database or a log.
32. `pnpm exec supabase db push --remote --dry-run`, then `pnpm exec supabase db push --remote --yes`. It adds `20261117120000_geocoder_geoapify`: `settings.geocoder` becomes Geoapify (only if you never changed it).
33. Deploy the three functions that use the geocoder: `pnpm exec supabase functions deploy detect-delivery --yes`, then the same for `geocode` and `courier-sync`.
34. Your check: within about 2 minutes every shipment in **Пратки** has a chip (no more "Проверява се…"), and the "Доставка" card ends with "Powered by Geoapify · © OpenStreetMap". If they stay grey, the function log says why (for example "GEOAPIFY_API_KEY is not set" or "geoapify answered HTTP 401" = wrong key).

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

## What Phase 4 built

- **Courier adapters** (`packages/core/src/couriers/adapter.ts`, P4-01): `CourierAdapter` with `capabilities()` and every method of the spec. Errors are typed codes (`not_supported_in_manual_mode`, `not_available_yet`, `credentials_missing`, `http_error`, `bad_response`, …), never exceptions. Implementations in `supabase/functions/_shared/couriers/` (P4-02):
  - `EcontApiAdapter`: `listOffices`, `resolveSite` (cities), streets, quarters (P4-07) and `calculate`. The waybill methods answer `not_available_yet` (they belong to Phase 9; tracking and COD payments to Phase 11), because §4 forbids creating waybills now.
  - `SpeedyManualAdapter`: `listOffices` (public pages) and `calculate` (from the `tariffs` table). Everything else answers `not_supported_in_manual_mode`.
  - `MockAdapter` (`packages/core`) for tests.
  - `selectAdapter()` picks by `settings.courier_modes` (P4-03).
- **Econt types** generated from `https://ee.econt.com/services/openapi.yaml` (P4-06): `pnpm econt:types` → `packages/core/src/couriers/econt-openapi.ts`.
- **Econt offices** (P4-04, P4-05): `getOffices` with `countryCode: "BGR"`. `id` → `external_id`, `code`, `isAPS` → locker, `isMPS` → mobile, names bg/en, phones, address with coordinates and Econt's confidence, business hours (weekdays + Saturday). The office list always comes from **production** (read-only, needs no login), because the demo list is test data (see "API differences").
- **Speedy offices** (P4-08, P4-09): the public list page (ID, name, "(АВТОМАТ)" → locker, address with postcode, hours for weekdays / Saturday / Sunday). The public map page `officesmap_v2` embeds the coordinates of **every** office in its page data, so **one** request gives them all, and no per-office requests are needed. Offices missing from the map page get coordinates from Nominatim later (4 per minute, `coord_source = nominatim`, lower confidence).
  - **P4-11: this source is a public web page, not an API.** Phase 13 replaces it with the Speedy `location/office` API (`SpeedyApiAdapter`).
  - **P4-12, Speedy widget v3** (`office_locator_widget_v3`): it can be embedded in an `<iframe>`. When a person picks an office, it sends only the office **ID** to the parent page with `window.parent.postMessage(…, "*")` (any origin). Phase 8 must accept the message only from `https://services.speedy.bg` and look the ID up in `courier_offices`. The widget draws its map with **Google Maps**, which the brief does not want, so Phase 8 should use our own searchable list (`search_points`, `points_in_city`) and keep the widget as a fallback at most.
- **Sync** (P4-13 … P4-16, `packages/core/src/couriers/sync.ts` + `supabase/functions/courier-sync`):
  - One run per courier in `courier_sync_runs` (status, stage, counts, warnings, error code). Stages: fetch (whole list, checked, staged in `private.courier_sync_items`) → apply (upsert in batches of 300, one transaction each) → finish (points not in the list → `active = false`, `deactivated_at`; **never deleted**). Each stage survives an interruption; the next call resumes the same run (lease + attempt counter, at most 10 attempts). Unchanged points are recognised by a content hash, so they are not rewritten.
  - **Broken source guard (P4-10):** an empty list, an unreadable page, or a list shorter than half of the active points (once 20+ are active) fails the run with a code. Nothing is changed or deactivated, and the owner sees the red banner.
  - **Schedule:** pg_cron calls `private.courier_sync_tick()` every 5 minutes. It starts Econt once a day from 03:00 Europe/Sofia, and Speedy from 03:00 when the last good Speedy run is more than 6½ days old. Within that night window it retries a failed run after 30 minutes. Every tick also continues unfinished runs and geocodes Speedy offices without coordinates. The call to the function uses a random token kept in `private.app_config` (never in the code).
  - **"Обнови офисите"** (owner only) starts both couriers. The work runs in the background (`EdgeRuntime.waitUntil`); the page follows the progress.
- **SQL helpers** (P4-17 … P4-19), for members:
  - `nearest_points(lat, lng, carriers[], types[], max_km = 5, limit = 10)`: PostGIS distance on the GiST index, closest first, at most 200.
  - `points_in_city(city or postcode)`: the city in Cyrillic or Latin, with or without "гр."; a postcode gives every point of that town.
  - `search_points(text, carriers[], types[], limit)`: `pg_trgm` word similarity on a Latin search column, so "Пловдив Тракия" and "plovdiv trakia" find the same points.
  - `courier_points_stats()`: counts for the admin page.
- **Geocoder** (P4-20 … P4-25, `packages/core/src/geo/` + `supabase/functions/geocode`):
  - Input: the Shopify address fields. Flat details (вх., ет., ап.) are removed first, so they never leave the database and two flats in one block share one cache entry.
  - Query variants, most precise first: original, without postcode, the street without the ж.к./бл. parts, the street name without "ул.", Latin (Bulgarian streamlined system), ж.к. + бл., ж.к. alone, postcode + town, town.
  - Nominatim with `countrycodes=bg` and only results inside Bulgaria (P4-23). A hit must also lie in the town the address names (spelling-tolerant check on Nominatim's address details).
  - Precision street | block | quarter | city | failed (P4-24).
  - Cache (P4-25): by normalized address key ("ул." = "улица", "гр. Пловдив" = "Пловдив", spacing, punctuation, flat details). Every query string is cached as well, so "4000 Пловдив" is asked once for everyone. Failures are cached too: an address is never sent twice.
  - Rate (P4-22): each request reserves a slot in the database (`geocoder_reserve`), at least 1.2 s apart across all callers, and 15 s apart for scheduled jobs. A caller that would wait too long gets "busy" instead. The User-Agent names the app. The service URL and an optional contact e-mail are in `settings.geocoder`, so the service can be switched without a software update.
- **Owner page "Офиси"** (P4-26, P4-27): counts per courier and type, how many are on the map, closed points kept, last successful update, the last run's counts, the current error in plain Bulgarian, the source, and **Обнови офисите**. A Leaflet + OpenStreetMap map of one town (quick buttons for the big towns, or type a town or postcode), with markers that show the courier letter on a shape per type (square office, circle locker, diamond mobile), popups, and the list of the same points below it. Search by name or address. The red banner "Списъкът с офиси на Спиди / Еконт не се обнови" is shown to the owner on every screen until the next good update. Packers see none of it. The page loads on demand (Leaflet is only downloaded by the owner).

### Phase 4 tests

| ID | Where |
|---|---|
| T4-01 sync: new / changed / missing points, never deleted | `tests/integration/courier-sync.test.ts` (real DB, mock adapters through the real Edge Function), `packages/core/src/couriers/sync.test.ts` |
| T4-02 haversine within 0.5 % | `packages/core/src/geo/distance.test.ts` (against a Vincenty WGS84 reference), `tests/integration/points.test.ts` (PostGIS against the same pairs) |
| T4-03 same address twice → cache, no request | `tests/integration/geocode.test.ts` |
| T4-04 Speedy parser on a saved snapshot | `packages/core/test/speedy-parser.test.ts` (124 entries, 61 lockers; the map page with every coordinate), `packages/core/test/econt-offices.test.ts` |
| T4-05 broken snapshot → data kept, red banner | `packages/core/test/speedy-parser.test.ts`, `tests/integration/courier-sync.test.ts`, `tests/e2e/offices.spec.ts` (banner) |
| T4-06 never more than 1 request per second | `tests/integration/geocode.test.ts` (concurrent callers, the reservation itself, scheduled pace) |
| T4-07 interrupted sync → resume, no duplicates | `tests/integration/courier-sync.test.ts`, `packages/core/src/couriers/sync.test.ts` |
| T4-08 live smoke test | manual, results below |
| No Speedy REST API, no Google anywhere | `tests/unit/no-forbidden-services.test.ts` (scans the code) |
| Adapter capabilities and manual-mode answers | `tests/unit/courier-adapters.test.ts` |
| nearest / city / search, RLS on the new tables and functions | `tests/integration/points.test.ts`, `tests/integration/schema.test.ts` |
| Admin page, search, button, packer view | `tests/e2e/offices.spec.ts`, `apps/web/src/offices/syncStatus.test.ts` |

### T4-08 live smoke test (14 Nov 2026, local stack, read-only calls)

| Source | Points | By type | With coordinates |
|---|---|---|---|
| Econt **demo** `getOffices` | 586 | 572 offices, 2 lockers, 12 mobile | 582 |
| Econt **production** `getOffices` | 639 | 569 offices, 47 lockers, 23 mobile | 639 |
| Speedy public list + map page | 1 389 | 459 offices, 930 lockers | 1 389 |

A full sync stored all 2 028 points in 0.7 s (Econt) + 2.0 s (Speedy). `nearest_points(42.1475, 24.7495, max 1 km)` (central Plovdiv) returned Speedy "ПЛОВДИВ - ОФИС" at 0.11 km, Econt "Пловдив Капана" at 0.28 km, then Speedy lockers and an Econt ВИП office. `points_in_city('Русе')`: 17 Econt + 34 Speedy points. `search_points('plovdiv trakia')` → first hit Econt "Еконтомат Тракия".

### Geocoder hit rate (escalation rule: "report the hit rate")

Measured on 18 **public** courier office addresses whose true coordinates the couriers publish (no customer data), through the real `geocode` function and the live Nominatim:

| | Street | Block | Quarter | Town only | Failed | ≤ 250 m | ≤ 1 km |
|---|---|---|---|---|---|---|---|
| First version | 6 | 1 | 2 | 9 | 0 | 7 | 12 |
| Final | 12 | 1 | 2 | 3 | 0 | 13 | 15 |

All final hits are in the right town. About 2.4 requests per new address (cached afterwards). Two fixes made the difference: many OpenStreetMap streets in Bulgaria are named without "ул.", so "Хаджи Димитър 42, Плевен" is found but "ул. Хаджи Димитър 42, Плевен" is not; and a check that the hit is in the named town (without it, "ул. София 7, Айдемир" landed in Sofia, 349 km away). **Good enough for choosing the nearest office (Phase 5), with one caveat:** for "town only" results the nearest office is a guess, so Phase 5 should treat precision `city` as "ask" rather than "decide". Real customer addresses (ж.к. + бл. without a street) may score lower than office addresses. Phase 5 will show the real rate on the imported orders.

## What Phase 5 built

- **Detection** (`packages/core/src/detect/`, pure TypeScript, run by the Edge Function and the tests):
  - Input (owner's decision): Address1, Address2, Company and the Notes of every order in the shipment. **Shipping Method is never read** (T5-08 tests it on 40 cases), and Note Attributes are not used.
  - `normalize.ts`: lower case, no punctuation, and a Latin and a Cyrillic copy of the text with the words aligned, so "Ekont", "spidi", "Еконт" and "СПИДИ" are the same word. Words are matched whole ("apt" never matches inside "аптека"). One typo is allowed for words of 5+ letters with the same first letter.
  - `dictionary.ts`: Appendix B (Econt, Speedy, other couriers, office, locker, home words) plus the owner's words from Settings. The owner's words are added and never replace the built-in ones (P5-05).
  - `match.ts` (P5-06 … P5-09): the office name, without the town, courier and street words, is compared to every active point of the town with pg_trgm-style trigram similarity. A match needs ≥ 0.75 and a lead of ≥ 0.10 over the next point. Office vs locker comes from the matched point (P5-09). An office ID or code counts only for a point in the order's town.
  - `decide.ts`: rules A–F exactly as P5-10 … P5-17. Every decision has at least one reason in Bulgarian and English, and optional hints ("Адресът изглежда като домашен", "Адресът е намерен само до града: разстоянието е приблизително").
  - `call.ts`: the Bulgarian call script (1–2 questions, P5-20) and the plain Google Maps / Google search **links** for rule F (P5-15). The links are plain URLs a person opens; the app never calls Google. The guard test allows exactly these two link forms in that one file, and checks that the file never fetches anything.
- **Database** (migration `20261116120000_delivery_detection`):
  - Shipments get the decision: certainty, rule, reasons, hints, suggestion, alternatives, where the address was found, and a "to detect" mark. Triggers set the mark whenever the address, the notes or the company change.
  - The flag "Обадете се: не е ясно къде да изпратим пратката" (amber) or "Грешка в доставката — обадете се" (red) makes the shipment `needs_check` (Phase 3 rule). A certain decision resolves it.
  - `shipment_calls`: every call outcome, who and when. RPC `delivery_call_outcome` (owner and packers): confirm the suggestion, another office, home address, no answer (only counted), refused (a reason is required; the shipment is cancelled and the reason kept).
  - **P5-19:** every outcome except "no answer" stores `manual_overrides.delivery`. The detection never changes a shipment chosen by hand. Only the owner can hand it back ("Нека приложението реши отново").
  - `shipment_update_address` (owner and packers): the corrected address is kept over a re-import (`manual_overrides.address`) and detected again.
  - `delivery_redetect_open` (owner): after a settings change, every open shipment not chosen by hand is detected again.
  - pg_cron "delivery-detect-tick" every 2 minutes: calls the function when something waits.
  - The view `shipment_overview` has the decision, the office name / address / type, the other open flags and the call count.
- **Edge Function `detect-delivery`**: `pending` (after an import, and from the 2-minute job) or `ids` (after an address correction). It uses the Phase 4 geocoder at Nominatim's pace. A busy geocoder leaves the shipment for the next run. Nothing about the customer is logged. **On the local stack the geocoder is off** (no test address ever goes to Nominatim) unless `GEOCODER_LOCAL=on`.
- **Web:**
  - **Пратки:** a "Доставка" column with the courier badge (Еконт blue, Спиди red, always with the word), the type (🏢 Офис, 📦 Автомат, 🚐 Подвижен офис, 🏠 До адрес), the office name (or "Предложение: …" with the distance) and the chip **Сигурно** (green ✅) / **Обадете се** (amber 📞) / **Грешка** (red ⛔) / **Проверява се…** (grey) with the main reason. New filter "Обадете се".
  - **Shipment page, "Доставка" card:** the reasons and hints, the suggestion with its distance, close alternatives (each with **Избери**), the Google links for an error, and the shipping method "for information only". For an uncertain or error shipment: the `tel:+359…` link, the call script, the buttons **Потвърди предложението / Друг офис / Личен адрес / Не вдига — опитай пак / Отказва поръчката**, and every unanswered call with its time and who called. **Друг офис** opens a picker (the town's points, or search by name or address). **Поправи адреса** edits the address; the detection runs 600 ms after saving.
  - **Settings → Доставка (owner):** the office range in km, the courier for home deliveries, and extra words per category.
  - After an import the web starts the detection at once (the 2-minute job is the safety net).

### Phase 5 tests

| ID | Where |
|---|---|
| T5-01 ≥ 60 cases (Appendix B + real offices) | `packages/core/test/detect-cases.test.ts` (81 cases) |
| T5-02 Latin text and typos | same file, "T5-02 / T5-03" block; `packages/core/src/detect/detect-units.test.ts` |
| T5-03 "Офис Еконт – Пловдив Тест", "еконтомат", "автомат спиди" → point and type | same file, "T5-03" block |
| T5-04 "до адрес" + full street → certain, address | `detect-cases.test.ts` (rule B cases) |
| T5-05 street address + office words → uncertain (D) | `detect-cases.test.ts` (rule D cases) |
| T5-06 BOX NOW; empty address → error | `detect-cases.test.ts` (rule F cases), `tests/integration/delivery.test.ts` |
| T5-07 0.8 km vs 1.5 km with range 1 km | `detect-cases.test.ts` |
| T5-08 Shipping Method has no effect | `detect-cases.test.ts` (40 cases with and without "Free shipping") |
| T5-09 every decision has a reason | `packages/core/test/detect-properties.test.ts` (2 000 random inputs), `tests/integration/delivery.test.ts` |
| T5-10 certain → the point is resolved | `detect-properties.test.ts` |
| T5-11 edit after a manual choice → kept | `tests/integration/delivery.test.ts` |
| Flags, status, calls by a packer, refusal, outsiders, owner reset, settings re-detect, stale decisions, the function and the 2-minute job | `tests/integration/delivery.test.ts` (19 tests) |
| Chips, packer call, picker, refusal, address correction, settings | `tests/e2e/delivery.spec.ts` |
| Packer visibility (`waitsForCall`, `packerCanSee`) | `packages/core/src/shipments.test.ts` |
| Legacy samples | `packages/core/test/detect-legacy.test.ts` (table below) |

### Legacy sample shipments (acceptance)

The legacy samples (#2001–#2011, invented people and addresses), grouped as the import groups them, with the real office list of the tests. The sample streets do not exist, so the first table has no map answer. The second table shows what the hosted geocoder will do for them: it falls back to the town.

| Shipment | Address | Rule | Chip | Courier / type | Reason |
|---|---|---|---|---|---|
| #2001 | ул. Примерна 12, вх. Б ет. 3 ап. 12, София | F | Грешка | — | Адресът не е намерен на картата |
| #2002 + #2007 | Офис Еконт – Пловдив Тест, Пловдив | C | Обадете се | Еконт, офис | Посочен е Еконт, но офисът не е ясен (there is no Econt office "Пловдив Тест") |
| #2003 | ж.к. Тестов, бл. 5, ет. 2, Варна | F | Грешка | — | Адресът не е намерен на картата |
| #2004 | бул. Демо 7, Бургас | F | Грешка | — | Адресът не е намерен на картата |
| #2005 | Via di Prova 3, Roma (IT) | F | Грешка | — | Not in Bulgaria |
| #2006 + #2011 | ул. Опитна 21, Русе | F | Грешка | — | Адресът не е намерен на картата |
| #2008 | Офис Спиди – София Тест, София | C | Обадете се | Спиди, офис | Посочен е Спиди, но офисът не е ясен |
| #2009 | ул. Пробна 4, Стара Загора | F | Грешка | — | Адресът не е намерен на картата (no phone either: the call box says to e-mail) |
| #2010 | ул. Макетна 9, Плевен | — | — | — | Cancelled in Shopify: not detected |

With only the town found on the map (the hosted geocoder's fallback):

| Shipment | Rule | Chip | Result |
|---|---|---|---|
| #2001 (София) | E | Обадете се | No office within 1 km of the town centre in the test list → "предложен е личен адрес", hints "only to the town" and "looks like a home address" |
| #2006 + #2011 (Русе) | E | Обадете се | Nearest: Спиди "РУСЕ - ТЕХНОПОЛИС", hints "only to the town" and "looks like a home address" |

When the T5-03 test office "Пловдив Тест" exists, #2002 + #2007 is rule A, **Сигурно**, Econt office.

No sample contradicts the rules, and the thresholds 0.75 / 0.10 gave no clearly wrong match on the test data. Real exports will show more.

## Phase 5 on the hosted project (14 Nov 2026)

What happened after steps 26–28, and what was changed:

- **Every shipment stayed "Проверява се…".** The 2-minute job ran and the function answered 202, but nothing was decided. The function logs showed why, step by step (only error codes, never an address):
  1. Nominatim answered **HTTP 403 "Access denied"** to every request from the hosted function. From the owner's computer the same request worked (0.2 s).
  2. A probe through a public header echo showed that **Supabase appends `(variant; SupabaseEdgeRuntime/1.79.1; ref=<project>)` to the User-Agent** of every request a function makes. The app cannot remove it.
  3. Sent from the owner's computer with that same User-Agent, Nominatim also answers "Access denied". So Nominatim blocks requests from Supabase Edge Functions by their User-Agent, not this app, and not an IP address. Working around a block the service set on purpose would break its usage policy, so the app does not try.
- **The queue no longer stalls.** Before, the first shipment that needed a map stopped the whole run, every 2 minutes. Now a failing or busy geocoder is asked at most once per run, and the run goes on with the shipments that need no map (an office or locker named by the customer, another courier, …). Result on the hosted data: 3 of 17 shipments decided (rule A, **Сигурно**), 14 waiting for a map.
- **Error log lines** for the geocoder: HTTP status, time, and the first words of the provider's error page, with URLs, the address and the key removed. A summary line per background run ("detect-delivery done {"applied":3,"busy":14}").
- **Geoapify instead of Nominatim** (owner's choice, 14 Nov 2026; LocationIQ was the first idea but its free plan allows keeping results for 48 hours only, which breaks P4-25):
  - `settings.geocoder.provider` is `geoapify` by default (migration `20261117120000_geocoder_geoapify`; a changed setting is kept). Nominatim stays selectable (another Nominatim server, or the desktop app in Phase 12).
  - Request: `https://api.geoapify.com/v1/geocode/search?text=…&filter=countrycode:bg&lang=bg&limit=1&format=json&apiKey=…`. Same query variants, the same town check, the same 1.2 s spacing and the same cache. Cache entries are per provider.
  - Geoapify's `result_type` is mapped onto the Phase 4 precision: building / amenity / street → street (block for ж.к. + бл.), suburb / district → quarter, postcode / city → town. County, state, country and unknown are ignored.
  - The API key is the Edge Function secret `GEOAPIFY_API_KEY`. Without it, nothing is sent, the addresses wait, and the log says so once.
  - Courier points placed by the geocoder get `coord_source = 'geoapify'`.
  - The "Доставка" card ends with "Търсене на адреси: Powered by Geoapify · © OpenStreetMap" (the free plan's attribution).
  - Terms read 14 Nov 2026: free plan 3 000 requests a day and 5 a second, commercial use allowed with that attribution; no limit on keeping results is stated (the docs say batch results may be stored "with no limits"). Geoapify is a company in Cyprus (EU).
- **Not used yet:** Geoapify's `rank.confidence`. Its answers are fuzzier than Nominatim's, and the town check is the only guard so far. After the first real imports, look at the "Предложение" distances: if a street is found in the wrong place, a confidence threshold is the next step.

Tests: `packages/core/src/geo/geoapify.test.ts` (URL, mapping, precision, town check), `tests/integration/geocode.test.ts` "Geoapify" block (key sent, cache per provider, no key → nothing asked, refusal not cached, town check), and the point-geocoding test now uses Geoapify.

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

Phase 4:

- **"EcontApiAdapter — all methods" (P4-02) vs. "Out of scope: creating, printing or cancelling waybills" (§4).** I followed §4: the waybill methods exist but answer `not_available_yet` (Phase 9; tracking and COD payments Phase 11). Read-only methods work now. **Confirmed by the owner on 14 Nov 2026:** waybills wait for Phase 9.
- **Econt offices always come from production.** It is a public, read-only call that needs no login (the spec allows read-only production calls), and the demo list is test data (different counts, 4 offices without coordinates). Price calculations follow `settings.econt_env` (default `demo`) and use Econt's own published demo test account until the production login is set. That account is public data and is kept in the code; the production login is only read from the Supabase secrets.
- **Econt hours:** "normal" hours are stored as Monday–Friday, "half day" as Saturday. Econt gives no Sunday hours, so Sunday is left unknown, not "closed".
- **Speedy coordinates** come from the public map page, which has every office in one request. So there are no per-office requests at all, which is politer than "a few requests per second". Nominatim is only the fallback for offices missing from the map page (none on 14 Nov 2026).
- **Schedule:** "Speedy weekly" = at night (03:00–06:00 Sofia time) once the last good Speedy update is more than 6½ days old. A failed scheduled run is retried after 30 minutes within that window; an interrupted run is resumed, at most 10 attempts per run.
- **Too short = broken:** a list with less than half of the currently active points (once at least 20 are active) is treated as a broken source, not as "half the offices closed". Nothing is changed and the banner shows. Tell me if a different threshold suits you.
- **Coordinates confidence** (0–3, like Econt's own): 3 = from the courier (Econt confidence 3, Speedy map page); 2 = street or block from Nominatim; 1 = quarter; 0 = town only. Econt's own confidence is kept as it is for Econt points.
- **Geocoder privacy:** only the address text goes to Nominatim. Names, phones, e-mails and flat details (вх., ет., ап.) never do. Nominatim's policy asks apps "not to submit personal data". A street address alone is about as little as geocoding can send. **Confirmed by the owner on 14 Nov 2026:** the address may be sent with the house or block number (the alternative was street + town only, less accurate).
- **Contact e-mail for Nominatim:** the policy does not require one for an app of this size, so none is sent. `settings.geocoder.email` is there if you want to add one.
- **Postcode search** (`points_in_city('4000')`) returns every point of the town that has that postcode. Speedy's list has no postcode for offices in the big towns, so Speedy points are found through their town.
- **Map tiles** come from OpenStreetMap's own tile server, which allows light use with attribution. One owner looking at one town at a time is light use; nothing is downloaded in advance.

Phase 5:

- **Call tools for the owner AND the packers.** P5-22 says owner-only; the brief says the parents call the customers. **The owner chose "me and my parents" on 14 Nov 2026.** Packers now see a `needs_check` shipment when its only open problem is the delivery (no other red / amber flag), with the call tools and the address correction. Resetting a manual choice and the settings stay owner-only.
- **Rule E is always "Обадете се"**, as P5-14 says, also when no office is within range (then home delivery is suggested). So a plain home address with no words like "до адрес" always needs a call. Customers who write "до адрес" / "личен адрес" + street and number are **Сигурно** (rule B). Tell me if a plain street address with no office within range should be "Сигурно" instead.
- **P5-16 tie-break:** the nearest first (distances rounded to 10 m); on an exact tie the cheaper one (Phase 7, not yet), then `home_carrier_tie_break`. Points of either courier within 200 m of the nearest are shown as alternatives.
- **Rule B's courier** is `home_carrier_tie_break` (Econt) until Phase 7 compares prices.
- **Kind differs:** "автомат Капана", where Капана is an office → rule C "Обадете се" with the office suggested (P5-09: the type comes from the point, so the app asks instead of guessing).
- **Office codes** ("офис 4064") count only for a point in the order's town, so a stray number is not taken as an office elsewhere.
- **Home words without a street** ("до адрес", no street or number) → rule B but "Обадете се" ("адресът е непълен"): P5-11 needs a street + number for certain.
- **Office word without a courier** ("до автомат Кауфланд Тракия") with one clear match → "Обадете се" with that point suggested (P5-17: never certain without the courier).
- **P5-18 "re-run after an edit, debounced 600 ms":** the detection runs 600 ms after the corrected address is **saved**, not while typing, so half-typed addresses never go to Nominatim. Choosing an office by hand needs no detection (it is a manual choice).
- **"Отказва поръчката"** cancels the shipment in the app and keeps the reason. The Shopify order is not changed: cancel it in Shopify as usual.
- **Settings change:** saving Settings → Доставка detects every open shipment again, except those chosen by hand.

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
- "Same destination" in the Phase 3 grouping is still the keyword heuristic. Phase 5 decides each shipment's destination after the grouping.
- Packers cannot delete rows, including `shipment_orders`. If Phase 3 lets packers split a combined shipment, that needs an RPC or a "detached" flag instead of a delete.
- The repository is **public**. Never commit real CSV exports, customer data, `.env*` files or keys.
- **Hosted Phase 4 is not set up yet** (steps 21–25). Until the first **Обнови офисите** on the hosted project, the scheduled job knows no function URL and does nothing ("not configured").
- **Econt production login** is set (14 Nov 2026) but not tested yet: nothing in Phase 4 calls Econt production with a login. It is checked the first time `settings.econt_env` = `production`.
- **Customer address hit rate not measured yet:** Phase 5 geocodes customer addresses, but only invented samples were used. After the first real import on the hosted project, the share of "Грешка: Адресът не е намерен на картата" shows the real rate.
- **Phase 5 on the hosted project:** steps 26–28 done (14 Nov 2026). Shipments that need a map wait for Geoapify (steps 30–34).
- Supabase appends `ref=<project ref>` to the User-Agent of every request an Edge Function makes, so Econt, Speedy and Geoapify see the project's ref. The ref is also in the web app's Supabase URL, so this reveals nothing new.
- The Speedy widget (P4-12) is not used; "Друг офис" uses our own list (`points_in_city`, `search_points`).
- The map in the admin page puts up to a few hundred markers on one town (Sofia: about 400). They overlap at town zoom; zoom in or use the list below the map.

## API / tool differences found

- Supabase CLI 3.x reports **publishable / secret** keys (`sb_publishable_…`, `sb_secret_…`) next to the legacy anon / service_role JWTs. The app and scripts use the new keys and fall back to the legacy ones.
- Supabase CLI 3.x: `db push`, `db advisors` etc. default to the **local** stack. Use `--remote` for the linked project. `supabase login` refuses to run without an interactive terminal (`LoginMissingTokenError`).
- Hosted checks run 12 Nov 2026: a signed-out request to `settings`, `members`, `orders` or `audit_log` returns 401 / `42501 permission denied`; a signed-out storage listing returns `[]`. The hosted project has both legacy (anon / service_role) and new (publishable / secret) keys. Use the new ones.
- `supabase db lint` reports errors inside PostGIS's own functions (extension code, not ours). Lint our schemas with `pnpm exec supabase db lint -s public,private`: clean. `supabase db advisors`: no issues.

Phase 4 (escalation rule: "document the difference"; none of them blocked the phase):

- **Econt business hours** (`normalBusinessHoursFrom` / `…To`, `halfDayBusinessHours…`) are epoch milliseconds in the live API. The OpenAPI spec says "time" strings. The code reads both and converts to "HH:MM" in Sofia time.
- **Econt demo vs. production office lists differ:** 586 vs. 639 points, and 4 demo offices have no coordinates. The demo list is test data, so the offices come from production (read-only).
- **Speedy list page:** the office ID is in the entry's `id` attribute and in brackets after the name. The postcode in brackets is missing for many offices in the big towns (e.g. "гр. Пловдив жк Тракия бл. 148"). Working hours are given per weekdays / Saturday / Sunday.
- **Speedy map page:** `officesmap_v2/?id=<any office>` contains the coordinates of **all** offices (`Y` = latitude, `X` = longitude), not just the one asked for.
- **Speedy widget v3** reports the chosen office by `postMessage` to any origin (`"*"`), and only the ID. It uses Google Maps (see P4-12 above).
- **Nominatim:** in `jsonv2`, `addresstype` of a road is the road's type (`residential`, `tertiary`, …), not `road`. A plain street could therefore look like a residential area (ж.к.). The precision now uses the result's category as well.
