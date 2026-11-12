# HappyHome Shipping Hub — Build Prompt Pack

What this is: every prompt you need to build the shared "Shopify order → check → label → ship" app with an AI coding agent (Claude in VS Code), in the order you run them, with a check after each one.

Written 11 Nov 2026. Updated 12 Nov 2026 for the current setup:
- **Econt = API mode.** Your e-Econt API login is ready. The app creates the official Econt waybills itself and prints them.
- **Speedy = manual mode (no API for now).** The app prepares everything. You make the Speedy waybill by hand in MySpeedy, attach its PDF in the app, and your parents print it from the app. **Phase 13** switches Speedy to API later, if Speedy gives you access.

Courier facts and prices were checked on those dates (Appendix A). Prices change, so the app uses Econt's live prices from its API, and Speedy's published price list until Speedy is on API.

---

## 0. How to use this file

1. Do **Phase 0** yourself (accounts and decisions). Econt API login: done. Speedy: works in manual mode (section 1).
2. Create an empty Git repo. Put your two tools in `/legacy/`:
   - `/legacy/shopify-shipping-converter.html`
   - `/legacy/delivery-board.html`
3. Save the **MASTER PROMPT** (section 3) as `/docs/MASTER_PROMPT.md` in the repo.
4. For each phase, start a **new agent session** and paste that phase's prompt. Each prompt tells the agent to read the master prompt first. Run one phase per session.
5. Fill every `<<...>>` placeholder before you paste.
6. After each phase, run **Your check**. Don't start the next phase until it passes.
7. If a session dies halfway, use the **Resume prompt** (section 2).

Milestones:

| Milestone | After phase | What works |
|---|---|---|
| A | 8 | Import, combined shipments, delivery-point detection, "call this customer" list, live editable label, draft label printing. No courier API needed. |
| B | 9 | Econt: official waybills created and printed from the app with one click. Speedy: waybill made by hand in MySpeedy, its PDF attached in the app, printed from the app. |
| C | 10 | Stock, purchase cost, profit, shipping spend, batch history. |
| D | 12 | Installed on every computer. Econt tracking + COD money automated; Speedy tracking and COD marked by hand. |
| E | 13 (later) | Only if Speedy gives API access: Speedy waybills, prices, tracking and COD automated like Econt. |

---

## 1. What the research changed (read before Phase 0)

1. **A label you design yourself is not a courier label.** Econt and Speedy only accept their own waybill (товарителница) with their barcode and number. The app shows a live **draft label** while you edit, then the official waybill is made:
   - **Econt (API mode):** "Създай товарителница" sends the shipment to Econt, Econt returns the official PDF in about a second, and the app prints it.
   - **Speedy (manual mode):** the app shows every waybill field ready to copy. You (from NL) or your parents make the waybill in MySpeedy (1–2 min per parcel), attach the waybill number + PDF in the app, and your parents print it from the app.
   - Either way the waybill is ready before your parents leave home. At the office they only hand the parcels over and don't wait. Without a ready waybill, the clerk has to type each one at the counter while they wait.
2. **API status (12 Nov 2026).**
   - **Econt:** done. The API login was created in e-Econt (Профил → Интеграция за онлайн магазини). Username = your e-Econt email; the password is the one you set there. Econt also has a separate demo environment for testing.
   - **Speedy:** API access was requested by email (telesales@speedy.bg, cc api.registration@speedy.bg); no answer yet. Speedy has no separate test server: a demo account works on the live URL, and a shipment created with a real account is a real shipment. Until Speedy answers, the app never calls the Speedy API.
   - **MySpeedy as a private person:** registration has a "Частно лице" option. To make COD waybills yourself, Speedy requires a one-time identity check (photos of your ID card, front and back, plus a photo of you holding it).
3. **Label size.** The Speedy label is A6 (105 × 148 mm) with a Code 128 barcode; Speedy's print API (used from Phase 13) offers paper sizes A4, A6 and A4_4xA6. Econt returns a PDF link and MySpeedy gives you a PDF, so the exact sizes are confirmed in Phase 9. Buy a 100 × 150 mm (4×6") thermal label printer, or print four labels on each A4 sheet.
4. **"Cheaper courier for home address" can't be hardcoded.** On public prices, Speedy's base price to an address is lower at every weight. But Speedy's cash-on-delivery fee is 2.4% (minimum €0.61) against Econt's 1.65%. With COD the winner changes:
   - ≤1 kg: Econt is usually cheaper
   - 1–3 kg: Speedy, unless the COD amount is very high
   - 3–5 kg: Econt once COD passes about €64
   - 5–10 kg: Speedy

   The app must work out the total for every shipment: Econt from its price API, Speedy from its published price list (seeded in the app) until Speedy is on API.
5. **Bulgaria has used the euro since 1 Jan 2026.** All prices are in EUR.
6. **Biggest win outside the code:** make Shopify tell you the delivery point. Name your shipping rates explicitly ("Еконт – до офис", "Еконт – до автомат", "Спиди – до офис", "Спиди – до автомат", "До личен адрес"), so the Shipping Method column says it. Then add an "Офис / автомат" text field on the cart page (a cart attribute), which shows up in the Note Attributes column. The app reads both of these as high-trust signals, and far fewer orders end up "uncertain".
7. **Payments without a contract.**
   - **Courier fee:** paying at the end of the month needs a contract. Econt's "на кредит" option requires a contract and a client number; Speedy sends monthly invoices only to contract clients. Without a contract, if the sender pays, your parents pay at the counter on every handover. If the **recipient pays** (the customer pays the fee when collecting the parcel), your parents pay nothing and just leave the parcels.
   - **COD money:** take it by bank transfer from both couriers. Econt: 1.65% electronic. Speedy: the bank account is written into each waybill made in MySpeedy; 2.4% (min €0.61), same as cash at an office.
8. **Speedy offices without API.** Speedy publishes a public list of all offices and lockers (ID, name, "(АВТОМАТ)" for lockers, address with postcode, hours). It also has an office-locator map widget for websites. The app uses these until Speedy is on API.

---

## 2. Reusable short prompts

**Resume prompt** (when a session breaks):

```text
Continue PHASE <N>. First read docs/MASTER_PROMPT.md, docs/STATUS.md and the PHASE <N> prompt in docs/PHASES.md. Run the test suite, tell me in 5 lines what is done and what is left for this phase, then continue with what is left. Don't redo finished work.
```

**Review prompt** (run at the end of every phase, same session):

```text
Review your work for PHASE <N> against its DONE WHEN list and the NON-NEGOTIABLE RULES in the master prompt. For each item answer: done / not done / partly, with the file or test that proves it. Fix anything not done. Then update docs/STATUS.md and docs/USER_GUIDE_BG.md.
```

**Fix prompt** (when something is wrong):

```text
Bug in <screen/feature>: I did <steps>, expected <X>, got <Y>. <paste error / screenshot description>. Find the root cause, write a failing test that reproduces it, fix it, show the test passing. Don't change unrelated code.
```

Tip: also save all phase prompts as `/docs/PHASES.md` so the agent can re-read them.

---

## Phase 0 — Your tasks (no code)

**Before Phase 1 (only these):**
- [x] **Econt API login:** created in e-Econt → Профил → Интеграция за онлайн магазини. Username = your e-Econt email. Keep the password in a password manager; it goes into Supabase secrets in Phase 4, never into chat or code.
- [x] **Speedy API:** requested by email. Until Speedy answers, Speedy runs in manual mode.
- [x] **Sender method:** decided. Both couriers: your parents drop the parcels at the office.
- [x] **Who pays the courier fee:** decided — the shop always pays (SENDER). Without a contract, your parents pay the fee at the counter on every handover (cash or card). The fee counts as your cost in the profit numbers.
- [ ] **GitHub account** (stores the code) and **Supabase account** (the shared database that all computers use; choose the EU region, Frankfurt). Both free. Phase 1 needs them.

**Later — do each one when its phase comes:**
- [ ] **Phase 2:** download 2–3 real Shopify order CSV exports for testing. Replace real names, phones and emails with fake ones first, because the AI agent reads these files. Decide which columns to hide (or write "none" and hide them later in Settings).
- [ ] **Phase 4 (optional):** a Google Maps Platform key for the Geocoding API. It's more accurate for Bulgarian addresses than the free OpenStreetMap geocoder. Skip it unless the free one misses too many addresses.
- [ ] **Before Phase 9:** in e-Econt, add your bank account (profile → bank details), so COD money comes by bank transfer. Note the code of the Econt office where your parents drop parcels.
- [ ] **Before Phase 9:** register in MySpeedy as "Частно лице" and pass the identity check (ID photos), which is needed for COD waybills. Note the ID of the Speedy office where your parents drop parcels. Decide who makes the Speedy waybills: you from NL, or your parents (they can log in to the same MySpeedy account).
- [ ] **Before Phase 9:** printer at your parents' place. Their normal A4 printer works (four labels per sheet). A small 100 × 150 mm label printer is faster (one sticker label at a time, no ink, peel and stick).
- [ ] **Phase 8:** create the logins for you (owner), mom and dad (packers) in the app.
- [ ] **Optional, any time:** in Shopify, rename the shipping rates and add the cart-page office field (section 1, point 6) so fewer orders need a call.
- [ ] **Phase 12:** a Cloudflare account (free; Cloudflare Pages allows business use on the free plan, Vercel's free plan doesn't), so the app gets a web address your parents open.

**Your check (before Phase 1):** the Econt API login works (the profile test with curl returns your profile), you have GitHub + Supabase accounts, and you've filled in the `<<...>>` in Phase 1.

---

## 3. MASTER PROMPT (save as /docs/MASTER_PROMPT.md)

```text
You are the lead engineer on "HappyHome Shipping Hub". Read this whole brief before doing anything. It is the source of truth for every phase. If a phase prompt conflicts with this brief, stop and ask me.

1. BUSINESS CONTEXT
- HappyHome is a Bulgarian-language Shopify store (Dawn theme) selling bedding: bed linen sets, duvets, pillows, towels. Prices in EUR. Payments: bank transfer or cash on delivery (COD = "наложен платеж" = НП). COD refunds go back through the couriers.
- The owner (Ceco) lives in the Netherlands. His parents in Bulgaria pack and ship. They are not technical, and they refuse to check every order by hand in Shopify. The app must remove that checking work: they open the app, see what to ship, call only the customers the app tells them to call, print the label, stick it on, hand the parcel over.
- Couriers: Econt (Еконт) and Speedy (Спиди). Delivery types: courier office, courier locker (Econt "Еконтомат" = APS; Speedy "автомат" = APT), or home address ("личен адрес"). BOX NOW and other couriers are out of scope: detect them and flag them only.
- Several computers (Ceco's in NL, the parents' in BG) share the same live data. An edit on one screen shows on the others within seconds.
- Shipping: for both couriers, the parents drop the parcels off at a courier office. There is no courier pickup from an address.
- COURIER MODES (current, stored in settings.courier_modes):
  - Econt = "api": the app creates official waybills through the Econt API, gets the PDF back and prints it.
  - Speedy = "manual": there are no Speedy API credentials. The app does everything else (detection, office choice, price from the published tariff, draft label). The owner creates the waybill by hand in MySpeedy (Speedy's website), then attaches the waybill number + PDF in the app, and the parents print it from the app like an Econt label.
  - Speedy may switch to "api" later (Phase 13). Design for that from day one: the rest of the app must not care which mode a courier is in.

2. USERS AND UI LANGUAGE
- The UI defaults to Bulgarian, with a full English toggle. Every user-facing string goes through i18n (bg + en). Every flag or warning has Bulgarian text written for a non-technical reader, plus the reason behind it.
- Calm, basic UI: light background, large text (body at least 16 px), few colours. Use colour only for status (green = certain/ready, amber = check/call, red = error/do not ship), and never as the only signal: always add an icon and a word. Big buttons. No modal dialogs except where this brief or a phase requires one. Keyboard shortcuts are allowed, but nothing may depend on them.

3. EXISTING ASSETS (port them, don't rewrite from scratch)
/legacy/shopify-shipping-converter.html is an offline converter. Its "Core" module has pure, reusable logic:
- encoding detection (UTF-8 BOM, UTF-16 LE/BE, Windows-1251 fallback for Cyrillic)
- delimiter detection and an RFC 4180 CSV parser
- Shopify continuation rows (order details only on an order's first row; only identifiers repeated)
- column matching by normalized header
- removing the leading apostrophe on zip/phone
- Bulgarian phone validation and match key: +359 / 00359 / 359 become 0, and a 9-digit mobile without its leading 0 gets the 0 added
- 4-digit postcode check; cancelled / fulfilled / partially fulfilled checks
- COD detection with /cash on delivery|\bcod\b|наложен/i
- Outstanding Balance vs Total check
- repeated-file detection (FNV-1a hash); repeated order numbers (identical vs conflicting copies)
- customer grouping (union-find on email, or phone + name); same-products warning
- an XLSX writer with no libraries (Shipping / Warnings / Notes sheets, yellow rows for multi-order customers and multi-product orders)
- synthetic sample data (sampleFiles)
Its 18 output columns: order_id(Name), Lineitem name, Lineitem price, Shipping City, Shipping Address1, Shipping Address2, Shipping Name, Shipping Phone, Shipping Zip, Currency, Subtotal, Shipping, Total, Email, Fulfillment Status, Payment Method, Lineitem sku, Lineitem quantity, plus an empty Product Photo column. These are read for checks only: Billing Phone, Financial Status, Outstanding Balance, Cancelled at, Shipping Country, Shipping Company, Notes, Note Attributes, Phone, Payment Terms Name, Lineitem requires shipping, Id.

/legacy/delivery-board.html is a viewer/editor. Reusable parts:
- XLSX reader, including pictures placed in or over cells
- ✓ send / ✗ don't-send marks; editable fields
- EN/BG string tables
- the courierOf keyword hint (econt / speedy / boxnow)
- product variant = the text after the last " - ", shown in red
- square photo crop (centred, max 800 px, JPEG quality 0.86)
- photo library keyed "sku:<sku>", else "name:<name>"
- copy-for-courier text; sorting; reading saved board files (readSavedBoard)

Port the pure functions into packages/core as TypeScript. Before changing anything, write unit tests showing that the legacy code and the ported code give the same results on the legacy sample data. Keep the legacy behaviour unless a phase says to change it.
Known change: the legacy board merges deliveries on the name alone. The new app must NEVER combine shipments on the name alone, because two different people can have the same name. A name-only match is only a hint.

4. ARCHITECTURE (fixed unless I approve a change)
- Monorepo (pnpm workspaces):
  - apps/web: React + TypeScript + Vite, installable as a PWA
  - apps/desktop: an Electron shell around the same web app, for silent label printing
  - packages/core: pure TypeScript domain logic, no I/O
  - supabase/: migrations, Edge Functions, seed data
- Backend: Supabase in the EU region.
  - Postgres for all data
  - Auth: email + password, one account per person
  - Storage: raw CSV files, product photos, label PDFs
  - Realtime: live updates + presence
  - Edge Functions (TypeScript) for every call to a courier or geocoding API. There is no Shopify API connection: orders come in only as CSV exports. Credentials live only in Supabase secrets, never in the browser.
- Courier adapters: one CourierAdapter interface with a capability list per adapter (offices, quote, createShipment, cancel, print, track, codPayments). EcontApiAdapter implements all of them. SpeedyManualAdapter implements only offices (from Speedy's public office list) and quote (from the tariff table); everything else returns "not supported in manual mode", and the UI shows the manual flow instead. SpeedyApiAdapter comes in Phase 13.
- Hosting: the web app on Cloudflare Pages (free plan; business use allowed). Don't use Vercel: its free Hobby plan is for non-commercial use only. The desktop app loads the same URL inside Electron.
- Money: store integer euro cents; display it like "12,34 €" (bg-BG). Weight: integer grams. Time: timestamptz, displayed in Europe/Sofia.
- Every table has: id uuid, created_at, updated_at, updated_by, version int (optimistic locking). An audit_log table records every user edit: who, when, table, row, before, after.
- Row-level security (RLS) on every table: only authenticated members of the shop get access. Role "owner" can change settings, credentials and tariffs, and can delete. Role "packer" can do everything else.

5. DOMAIN MODEL (initial; phases extend it with migrations)
- import_batches
- orders: one per Shopify order, unique on Shopify Id (fallback: Name); raw jsonb keeps every column
- order_lines
- shipments: one physical parcel = one label; can contain several orders
- shipment_orders (join table)
- flags: typed issues on an order or shipment, with severity, code, bg/en message, reason, resolved_by/at
- products: keyed by SKU; photo, purchase cost, weight, stock
- product_cost_history, stock_movements
- courier_offices: both couriers, offices + lockers, with coordinates
- geocode_cache
- tariffs: backup price tables with valid_from/valid_to and source
- price_quotes
- settings (key → jsonb)
- audit_log
Shipment status pipeline: imported → needs_check → ready → (Speedy manual mode only: waiting_manual_waybill) → waybill_created → printed (or printed_draft when only a draft address sticker was printed) → handed_over → delivered | returned | cancelled.
Bulgarian labels: Внесена, За проверка, Готова, Чака товарителница (MySpeedy), Товарителница създадена, Отпечатана (Отпечатан адресен етикет), Предадена, Доставена, Върната, Отказана.

6. GLOSSARY
НП / наложен платеж = cash on delivery (COD). Товарителница = waybill (official courier label). Офис = courier office. Автомат / Еконтомат / APS / APT / пакетомат = locker. Личен адрес / до адрес = home delivery. ОС / обявена стойност = declared value. ж.к. = housing estate, бл. = block, вх. = entrance, ет. = floor, ап. = apartment.

7. NON-NEGOTIABLE RULES
- Never delete or overwrite imported data silently. A re-import updates with a diff and an audit entry. If an order that already has a waybill changes, create a red flag.
- Never mark anything with a red flag as ready to ship, unless the owner overrides it with a written reason (audited). Never ship a cancelled order.
- Never invent courier data. Offices, prices and waybills come from the courier APIs, from Speedy's public office list (manual mode), from waybills the owner attaches from MySpeedy, or from the seeded tariff table, clearly labelled "ориентировъчна цена".
- While settings.courier_modes.speedy = "manual": never call the Speedy REST API, and never automate MySpeedy (no scripted logins, no scraping of logged-in pages).
- Econt: develop and test against the Econt demo environment. Use the production login (secrets ECONT_USERNAME / ECONT_PASSWORD) for read-only calls (offices, price calculation) and, once the owner sets settings.econt_env = "production", for real waybills.
- A courier "create shipment" call costs real money and creates a real parcel. It runs only on an explicit user click, after a confirm summary, and it is idempotent: never create two waybills for one shipment.
- Personal data stays in Supabase EU. No customer data in logs, analytics or third-party AI calls. Raw CSV files are deleted automatically after the number of days in settings.raw_csv_retention_days.
- Every automatic decision stores its reasons (a machine code + bg/en text), so a parent can see why it was made.
- Show phone numbers as typed and also normalized. tel: links use the normalized +359 form.
- Never overwrite a value a user picked by hand. Store manual_override = true, and automatic logic leaves it alone.

8. HOW YOU WORK
- Start every phase by reading this brief and docs/STATUS.md, listing the files you'll touch and listing your assumptions. Then implement.
- TypeScript strict. Vitest for unit tests, Playwright for end-to-end tests. Every packages/core function has tests. Courier and geocoding calls sit behind adapter interfaces, with mock implementations for tests.
- Small commits with clear messages. Database changes only through migrations.
- At the end of every phase: all tests green, docs/STATUS.md updated (what's done, how to run it, known gaps), and docs/USER_GUIDE_BG.md updated for any new screen (short, in Bulgarian, for the parents).
- If an external API behaves differently from what a prompt says, trust the official docs and the live response, write the difference down in docs/STATUS.md, and tell me.
- Stop and ask me (don't guess) when: a requirement is ambiguous in a way that changes data or money; an API needs credentials you don't have; or a change would break a legacy behaviour.
```

---

## Phase 1 — Foundation: repo, database, auth, live sync, storage, i18n

```text
PHASE 1 — Foundation

Read docs/MASTER_PROMPT.md and docs/STATUS.md (create STATUS.md if it doesn't exist).

GOAL
A running skeleton that every later phase builds on: monorepo, Supabase schema with RLS, login, live sync between two browser windows, storage buckets, Bulgarian/English i18n, CI.

DO
1. Monorepo as in the brief (apps/web, apps/desktop placeholder, packages/core, supabase/). pnpm, TypeScript strict, ESLint, Prettier, Vitest, Playwright. GitHub Actions: lint + typecheck + unit tests on every push.
2. Supabase migrations for every table in the brief's domain model: sensible columns, foreign keys and indexes.
   - orders: unique shopify_id; indexes on phone_norm, email_norm, created_at_shopify
   - courier_offices: unique (carrier, external_id); lat/lng index (PostGIS if available, else plain)
   - triggers: version + updated_at; an audit trigger that writes before/after jsonb to audit_log
3. Auth: email + password. members table (user_id, display_name, role owner|packer). RLS: members only; owner-only for settings, tariffs and deletes.
4. Storage buckets (all private, signed URLs only): raw-imports, product-photos, labels.
5. Realtime on orders, shipments, flags, products. A presence channel that shows who is looking at which shipment ("Мама гледа тази пратка").
6. Web app shell:
   - login page
   - top bar: shop name, user, BG/EN toggle
   - navigation: Пратки (queue), Внасяне (import), Продукти, Наличност, Отчети, Настройки — empty pages with titles for now
7. i18n: bg default, en second. Every string lives in locale files from day one. Dates and money via Intl with bg-BG.
8. Seed the settings table (values editable in the UI later):
   - sender_profile = {}
   - office_range_km = 5
   - duplicate_window_hours = 48
   - default_parcel_weight_g = 1500
   - packaging_weight_g = 200
   - packaging_cost_cents = 0
   - courier_fee_payer = "SENDER"
   - home_carrier_tie_break = "speedy"
   - hidden_columns = []
   - raw_csv_retention_days = <<e.g. 90>>
   - label_paper = "A6"
   - courier_modes = {"econt": "api", "speedy": "manual"}
   - econt_env = "demo" (the owner switches it to "production" in Phase 9)
   - sender_offices = {} (the owner enters the Econt office code and the Speedy office ID in Settings before Phase 9)
9. Create docs/STATUS.md and docs/USER_GUIDE_BG.md.

DON'T
- No business logic, no courier calls, no UI beyond the shell.

TESTS
- Migrations apply from zero on a fresh database.
- RLS tests: an anonymous user gets nothing; a packer cannot write settings; the owner can.
- Playwright: two browser contexts logged in as two different users. An edit to a test row in one appears in the other in under 3 seconds.

DONE WHEN
- pnpm dev starts the web app, login works, the realtime test passes, CI is green, and STATUS.md explains the setup in 15 steps or fewer.

STOP AND ASK IF
- You think a different stack is clearly better. Explain why in 10 lines or fewer and wait for my answer.
```

**Your check:** log in on two browsers (or a phone + a laptop) as two users, and see the presence indicator show the other person.

---

## Phase 2 — Import Shopify CSV batches (port the converter)

```text
PHASE 2 — Import Shopify CSV batches

Read docs/MASTER_PROMPT.md and docs/STATUS.md first.

GOAL
Mom, Dad or Ceco drop one or more Shopify order-export CSVs. The app stores each file as a batch, parses it with the ported legacy converter logic, upserts orders and lines, shows a reduced view with configurable columns, and stores every warning as a flag. Re-importing the same orders never duplicates them.

DO
1. Port Core from /legacy/shopify-shipping-converter.html into packages/core/import/*: decode, detectDelimiter, parseCSV, readFile (continuation rows, apostrophe strip), the validateOrder checks, phoneMatchKey, phoneProblem, repeated-order detection, productsKey, buildXlsx.
   First write tests that run the legacy sampleFiles() through BOTH the legacy code (load the <script id="core"> block in Node, which exports via module.exports) and the ported code, and assert identical orders, lines and issues. Then refactor.
2. Read ALL Shopify columns into orders.raw (jsonb), so nothing later phases need is lost. These especially:
   Id, Name, Created at, Email, Phone, Billing Phone, Shipping Name, Shipping Company, Shipping Address1, Shipping Address2, Shipping City, Shipping Zip, Shipping Province, Shipping Country, Shipping Phone, Shipping Method, Notes, Note Attributes, Financial Status, Fulfillment Status, Outstanding Balance, Cancelled at, Payment Method, Currency, Subtotal, Shipping, Discount Amount, Total, Refunded Amount, Tags, Lineitem name, Lineitem sku, Lineitem quantity, Lineitem price, Lineitem requires shipping.
   Also store typed columns for the fields the logic uses.
3. Batch = one uploaded file. Store the raw file in the raw-imports bucket, plus sha256, file name, uploader, and counts (rows; orders new / updated / unchanged / skipped). If the same file hash is uploaded twice, reject it with a friendly Bulgarian message, not an error page.
4. Upsert rule (key = Shopify Id, fallback Name):
   - new → insert
   - existing and identical → record "seen again in batch X"
   - existing and changed → update, write the diff to audit_log, create the flag "Поръчката е променена в Shopify след внасянето" (amber; red if the order already has a waybill)
   - cancelled in a later batch → red flag; set the shipment status to cancelled if it hasn't been handed over yet
5. Every legacy issue becomes a flag row: severity (legacy error = red, warning = amber, info = grey), code, Bulgarian text, English text, source batch and row. Rewrite the legacy English messages into plain Bulgarian.
6. Reduced view (Внасяне → batch detail): the batch's order lines with the legacy 18 columns + photo as the default set, minus settings.hidden_columns. Settings gets a column chooser listing EVERY column found in the imported Shopify files (all are stored in orders.raw): a checkbox to show/hide each one, plus drag to reorder. So the owner can hide default columns and also show any other Shopify column (e.g. Created at, Notes, Shipping Method). Save the choice in settings (visible_columns in order; hidden_columns kept for compatibility).
   Hide these columns by default: <<LIST THE COLUMNS YOU WANT REMOVED>>.
   Showing/hiding affects only the view and the export, never what is stored or what the logic uses.
7. "Изтегли Excel" button: the ported buildXlsx exports the batch, respecting hidden columns, keeping the yellow colouring and the Warnings sheet.
8. Import screen: a big drop zone, several files at once, progress, then a summary card per file in Bulgarian, e.g. "12 нови поръчки · 3 вече внесени · 1 променена · 2 за проверка".
9. Parse in the browser (fast), then send the parsed result + the raw file to an Edge Function that writes everything in one transaction.

DON'T
- No combining orders into shipments yet (Phase 3). No courier detection yet (Phase 5).

TESTS
- Legacy-parity tests green.
- Fixtures: the legacy samples + <<path to your anonymized real CSVs>>. Also: a Windows-1251 file, a semicolon-separated file, a UTF-16 file, columns in a different order, a file cut off in the middle (unterminated quote). Each one is handled exactly as the legacy tool handles it.
- Re-importing overlapping exports: no duplicate orders; a changed order produces a diff + a flag.

DONE WHEN
- Importing two overlapping real exports gives correct counts and flags, and the downloaded Excel has the same structure as the legacy one (minus the hidden columns).
```

**Your check:** import the same real export twice → the second import is rejected. Import an overlapping export → only the new orders count as new.

---

## Phase 3 — Shipments: combine orders, catch duplicate-order mistakes

```text
PHASE 3 — Build shipments

Read docs/MASTER_PROMPT.md and docs/STATUS.md first.

GOAL
Turn imported orders into shipments (1 shipment = 1 parcel = 1 label). Combine orders that should travel together, and flag the ones that look like a customer mistake.

RULES (implement exactly; every number is a setting)
1. All lines of one order always go into one shipment.
2. Within the same CSV batch, different orders whose normalized phone (legacy phoneMatchKey) OR normalized email (trimmed, lowercase) match are combined into one shipment, but only when their destination is the same: the same normalized Address1 + Address2 + City + Zip, or the same office text.
   Different destinations → do NOT combine. Put the amber flag "Един клиент, различни адреси — обадете се" on both orders, linking them to each other.
   Across different batches: if the same phone/email already has a shipment with the same destination whose status is still before waybill_created → do NOT combine automatically. Add the amber flag "Същият клиент има неизпратена пратка от друго внасяне (#X) — да ги обединим?" with a one-click merge button.
3. A match on the name alone never combines anything. It only adds the grey flag "Същото име като поръчка #X — вероятно различни хора".
4. Never move an order automatically out of a shipment whose status is waybill_created or later. A new matching order gets its own shipment + the flag "Вече има създадена пратка за този клиент (#X)".
5. Never put these in a shipment (each gets a flag explaining why): cancelled orders, fully fulfilled orders, orders where no line requires shipping.
6. Combined shipment values:
   - recipient = taken from the earliest order; any differences between the orders become flags
   - COD = the sum, over the COD orders, of Outstanding Balance (fallback: Total). Prepaid orders add 0. Show the breakdown per order.
   - contents = the list of products
   - reference = all order numbers, e.g. "#2002 + #2007"
   - weight = filled in by Phase 7
7. Duplicate-mistake detector: two different orders from the same customer (phone or email match, across batches too) created within settings.duplicate_window_hours (48 h, by Created at), with the same product set (SKU + quantity, ignoring line order).
   → Red flag "Възможна грешка: две еднакви поръчки една след друга — обадете се преди изпращане" on both orders. Status needs_check. The flag shows both orders side by side.
   Same customer, overlapping but not identical products, inside the window → amber flag.
8. Manual controls: split an order out of a shipment; merge two shipments (with a confirm step). Everything is audited. Manual decisions are remembered and never undone by a re-import.
9. A new shipment starts as needs_check if it has any red or amber flag, otherwise ready. Phase 5 may move it back to needs_check.

TESTS
- Table-driven tests for every rule, including:
  - phone variants: "+359 888 000 102" vs "0888000102" vs "888000102"
  - email in different case and with spaces
  - different-destination case
  - cross-batch duplicate inside vs outside 48 h
  - order cancelled in a later batch
- Legacy samples (the two legacy sample files):
  - both files' rows put into ONE test CSV = one batch: #2002 + #2007 (same email, same office) → combined; #2006 + #2011 (same phone, same address) → combined
  - imported as TWO batches: not combined; the cross-batch merge suggestion appears on both pairs
  - #2001 appears in both files with identical details → one order

DONE WHEN
- The Пратки page lists SHIPMENTS (not orders) with order numbers, recipient, city, COD total, status and flag count. Combined shipments show a chip like "Обединени: телефон" or "Обединени: имейл".
```

**Your check:** use a test CSV with two orders from the same phone number to the same address → one shipment. Same phone, different address → two shipments + a call flag.

---

## Phase 4 — Courier office/locker database + geocoding

```text
PHASE 4 — Courier points database and geocoding

Read docs/MASTER_PROMPT.md and docs/STATUS.md first.

GOAL
Every Econt and Speedy office and locker in Bulgaria is in our database with coordinates and refreshed daily. Customer addresses can be geocoded. A fast "nearest points" query exists.

DO
1. A CourierAdapter interface in packages/core: listOffices, resolveSite, calculate, validateShipment, createShipment, updateShipment, cancelShipment, printLabel, track, codPayments, plus a capabilities() list. Implementations live in Edge Functions: EcontApiAdapter (all methods) and SpeedyManualAdapter (listOffices + calculate from the tariff table only; every other method returns "not supported in manual mode"). Plus a MockAdapter for tests. The adapter for each courier is chosen by settings.courier_modes.
2. ECONT (JSON API)
   - Production: https://ee.econt.com/services/ — Demo: https://demo.econt.com/ee/services/ (separate credentials; the demo is the default for development)
   - Production login: the e-Econt API login the owner created (Supabase secrets ECONT_USERNAME / ECONT_PASSWORD). Read-only production calls (offices, cities, streets, price calculation) are safe and allowed from this phase on.
   - Offices: Nomenclatures/NomenclaturesService.getOffices.json with countryCode "BGR" (cityID optional)
   - Office fields include id, code, isAPS (automatic post station = Еконтомат), isMPS (mobile post station), name, nameEn, phones, address (with location latitude/longitude and a confidence value 0–3), business hours
   - Also available: getCities, getStreets, getQuarters (needed in Phase 9)
   - OpenAPI spec: https://ee.econt.com/services/openapi.yaml — generate TypeScript types from it
3. SPEEDY (manual mode: no API credentials, don't call api.speedy.bg)
   - Source: Speedy's public office list page: https://services.speedy.bg/office_locator_widget_v2/offices_list.php?lang=bg&countryId=
     Each entry has the office ID in brackets, the name ("(АВТОМАТ)" in the name = locker), the address with the postcode in brackets, and the working hours. Parse it with a tolerant HTML parser.
   - Coordinates: first check whether Speedy's public office map page (https://services.speedy.bg/officesmap_v2/?lang=bg&id=<office ID>) exposes coordinates in its page data. If it does, use them (fetch politely: a few per second at most, cached, only for new or changed offices). If not, geocode each office address with our geocoder (point 6) and mark coord_confidence as lower.
   - Sync weekly, plus the owner button. If the page format changes and parsing fails: keep the old data, never deactivate everything, and show the owner a red banner "Списъкът с офиси на Спиди не се обнови".
   - Write in docs/STATUS.md that this is a public web page, not an API; Phase 13 replaces it with the Speedy location/office API.
   - Manual office picking for Speedy (used in Phase 8): Speedy's office-locator widget for websites, https://services.speedy.bg/office_locator_widget_v3/. Check how it returns the chosen office; if it can't be embedded cleanly, use our own searchable list from courier_offices.
4. Sync job: an Edge Function + Supabase cron (Econt daily at 03:00 Europe/Sofia; Speedy weekly), plus a manual "Обнови офисите" button for the owner.
   Upsert into courier_offices: carrier, external_id, code, type (office|locker|mobile), name_bg, name_en, city, postcode, address_text, lat, lng, coord_confidence, working_hours jsonb, active, synced_at.
   A point missing from a sync → active = false. Never delete.
5. SQL helper functions:
   - nearest_points(lat, lng, carriers[], types[], max_km, limit), using haversine or PostGIS
   - points_in_city(city or postcode)
   - fuzzy name/address search with pg_trgm, working on both Cyrillic and Latin
6. Geocoder Edge Function. Input: the Shopify address fields.
   - Build query variants: original Cyrillic, transliterated Latin (Bulgarian streamlined system), with and without the ж.к./бл. parts, city + zip only
   - Provider: <<Google Geocoding API | Nominatim>>. If Nominatim: follow its current usage policy (about 1 request per second, a proper User-Agent, cache everything)
   - Restrict to Bulgaria
   - Return lat, lng, precision (street | block | quarter | city | failed)
   - Cache in geocode_cache by normalized address key
7. Owner admin page: counts per carrier and type, last sync time, and a Leaflet + OpenStreetMap preview of one city's points, to check them by eye.

TESTS
- Sync upsert/deactivate logic with mocked adapters. Haversine against known distances. Geocode cache hits.
- Speedy list parser: tests against a saved HTML snapshot of the office list page (offices and lockers, ID, postcode, hours); a broken snapshot must keep the old data.
- Manual live smoke test, documented in STATUS.md: Econt offices from the demo and from production (read-only); the Speedy public list; record the counts.

DONE WHEN
- The owner presses "Обнови офисите" and gets thousands of points with coordinates. nearest_points for a Plovdiv coordinate returns sensible Econt and Speedy offices and lockers.
```

**Your check:** on the map preview for Ruse (or your parents' town), the points match what you know is really there.

---

## Phase 5 — Decide the delivery point and certainty (EN + BG detection)

```text
PHASE 5 — Delivery point detection and certainty

Read docs/MASTER_PROMPT.md, docs/STATUS.md and Appendix B of docs/PHASES.md first.

GOAL
For every shipment, decide: carrier (econt|speedy), delivery type (office|locker|address), the exact office or locker if there is one, and certainty (certain | uncertain | error), with the reasons in Bulgarian. Uncertain or error → "Обадете се", with a phone link and a question script.

SIGNALS (in order of trust)
1. Shipping Method (when the Shopify rates are named per courier and type)
2. Note Attributes (a checkout/cart field with the chosen office or locker)
3. Shipping Address1, Shipping Address2, Shipping Company
4. Notes (the customer's note) and the internal order comment

DETECTION
- Normalize: lowercase, Unicode NFC, strip punctuation, collapse spaces. Also make transliterated copies (Latin → Cyrillic and Cyrillic → Latin) so "ofis ekont", "офис еконт" and "Econt office" all match.
- Keyword dictionary in packages/core/detect/dictionary.ts. Start from Appendix B; the owner can extend it later in Settings.
  - carrier words (Econt / Speedy / BOX NOW)
  - point words (office / locker)
  - home words (личен адрес, до адрес, home address, …)
  - office codes and IDs
- Office matching: once a carrier is detected, fuzzy-match the remaining text against that carrier's active points in the order's city (city name or postcode, both languages), using trigram similarity on name and address.
  Accept a match when its score ≥ 0.75 AND it is at least 0.10 above the next-best match. Anything else is "ambiguous".
  Whether it's a locker or an office comes from the matched point's type, not from the word the customer used.

DECISION RULES (exact)
A. Carrier + point matched to exactly one active office/locker → CERTAIN.
B. An explicit home keyword (or a Shipping Method that means address delivery), and the address has a street/estate + a number/block → CERTAIN, type = address. The carrier is chosen in Phase 7 (cheapest for home).
C. A carrier is mentioned but the point can't be identified or is ambiguous → UNCERTAIN. Suggest that carrier's nearest point to the geocoded address (or the best matches in the city). Reason: "Посочен е <Еконт>, но офисът не е ясен".
D. Conflicting signals (both couriers; office words + a full street address; Shipping Method says office but the address is a street) → UNCERTAIN. The reason lists the conflict.
E. Nothing mentioned → geocode → take the nearest point of either carrier (offices and lockers) within settings.office_range_km → UNCERTAIN, with the suggestion and the distance, e.g. "Най-близо: Еконт Пловдив Тракия, 0,8 км".
   No point within range → type = address, UNCERTAIN, reason "Няма офис или автомат до <N> км — предложен е личен адрес".
   If the address looks like a street address (ул., бул., ж.к., бл., вх., ет., ап., № or their Latin forms), add the hint "Адресът изглежда като домашен". It's only a hint and does not change the rule.
F. Geocoding failed, the city is unknown, or BOX NOW / another courier is mentioned → ERROR. Show Google Maps + Google search links for the address, and open the manual point picker.
- Tie-break when two points are almost the same distance away (under 200 m difference): the closer one first, then the cheaper one (Phase 7 quote), then settings.home_carrier_tie_break.
- Re-run detection automatically when a user edits the address or office fields (debounced 600 ms). Never overwrite a value the user picked by hand (manual_override).
- CERTAIN means the destination is fully resolved. A courier word on its own, with no identifiable office, is NOT certain.

CALL RECOMMENDATION
- Every UNCERTAIN or ERROR shipment gets:
  - a tel:+359… link
  - the reason
  - a short Bulgarian call script with the 1–2 questions to ask, e.g. "Здравейте, обаждам се от HappyHome за поръчка #2008. Къде да изпратим пратката — до офис на Спиди <име> или до личен адрес?"
- Call outcome buttons:
  - "Потвърди предложението"
  - "Друг офис" (opens the picker)
  - "Личен адрес"
  - "Не вдига — опитай пак" (counts attempts, with a timestamp)
  - "Отказва поръчката" (→ cancelled, with a reason)

TESTS
- At least 60 table-driven cases from Appendix B, including: Latin-typed text, typos (Ekont, Spidi), "Офис Еконт – Пловдив Тест", "еконтомат", "автомат спиди", "до адрес", street addresses with and without office words, BOX NOW, an empty address.
- Property tests: every decision has at least 1 reason; a CERTAIN decision never has an unresolved point.

DONE WHEN
- Every shipment in the queue shows: a carrier badge, a type icon, the office name, and a chip — green "Сигурно", amber "Обадете се" or red "Грешка" — with the reason. The results for the legacy sample shipments are listed in STATUS.md.
```

**Your check:** take 20 real orders and compare the app's decision with what you would decide by hand. Anything wrong → add it as a test case and rerun the phase with the Fix prompt.

---

## Phase 6 — Product library: photos, mandatory purchase price, weight

```text
PHASE 6 — Product library

Read docs/MASTER_PROMPT.md and docs/STATUS.md first.

GOAL
Every product (by SKU) has a photo, a purchase cost and a weight. Each is entered once and reused forever, on every computer.

DO
1. products table keyed by the legacy library key ("sku:<normalized sku>", else "name:<normalized name>"). Fields: display name, variant, photo_path, purchase_cost_cents, weight_g, stock_qty (used in Phase 10), low_stock_threshold, notes.
2. A photo can be attached wherever a product appears (an order line, the product page): paste (Ctrl+V), drag-and-drop, or file picker. Port the legacy behaviour:
   - centred square crop, max 800 px, JPEG 0.86
   - a clear message for HEIC files
   - the "use it for N more products with the same SKU" action
   - undo
3. MANDATORY POPUP before a new photo is saved. It also appears, prefilled, every time a photo is replaced:
   - "Покупна цена (€)" — required, greater than 0, accepts a comma or a dot
   - "Тегло на брой (г)" — prefilled with settings.default_parcel_weight_g; strongly suggested
   - optional supplier note
   Cancel = the photo is not saved. Save = upload to product-photos and write the cost to product_cost_history with the date and the user.
4. Products page (Продукти): a grid with photo, name, SKU, cost, weight, stock and last sold; search; edit cost and weight. A cost change asks "валидна от днес?" and keeps the history, so old orders keep their old cost for profit.
5. Photos and costs appear instantly on every computer (realtime).
6. Legacy import tool: read a saved Delivery Board HTML file (port readSavedBoard) and offer to import its photos into the library, still asking the cost for every SKU that has none.
7. Missing-data chips in the queue: "Липсва снимка", "Липсва покупна цена", "Липсва тегло" (amber). Missing weight doesn't block shipping: the price uses the default weight and says so.

TESTS
- Crop function matches the legacy output. Popup validation. The cost history picks the right cost for an order's date.

DONE WHEN
- Paste a photo on computer 1 → the cost popup appears → save → within seconds the photo shows in computer 2's queue, and on every future order with that SKU.
```

**Your check:** add a photo with a cost on your laptop, then open the app on your parents' computer and see it there.

---

## Phase 7 — Shipping price engine and "cheapest courier for home address"

```text
PHASE 7 — Prices and courier choice

Read docs/MASTER_PROMPT.md, docs/STATUS.md and Appendix A of docs/PHASES.md first.

GOAL
Know what every shipment will cost with each courier, and pick the right courier: the cheapest total for home address; the detected one for an office or locker.

DO
1. Weight = sum(product weight × quantity) + settings.packaging_weight_g. Missing weights → settings.default_parcel_weight_g, with a note. The weight is editable on the label panel. Parcel count defaults to 1.
2. quote(shipment, carrier, type, pointId?) returns {base, addressSurcharge, codFee, otherFees, total, currency, source: "api"|"tariff", validAt}.
   - ECONT (API): LabelService.createLabel with mode "calculate". Available modes: calculate, validate, create, calculate_with_block. Always send the currency (EUR) with the COD amount and any declared value. Use the production login (read-only) so the price matches your real account.
   - SPEEDY (manual mode): from the tariffs table only (source "tariff"). The UI shows "по ценоразписа на Спиди". Phase 13 adds the Speedy Calculate API.
   - Cache quotes for 24 h by (carrier, type, point or site, weight band, COD rounded to whole euros, payer).
3. Tariffs table seeded from Appendix A (public tariffs with VAT, dated, with the source URL). It is the main source for Speedy and the backup for Econt when its API is down; a backup price is labelled "ориентировъчна цена". The owner can edit tariffs in Settings. Include:
   - the Speedy promo row (office/locker → locker, ≤3 kg, 1,52 €, valid until 01.01.2027) with valid_to set
   - Econt: Econtomat = the office price minus 10% (waybills made through e-Econt get this discount); address prices differ for towns with and without an Econt office (Appendix A)
   - COD fee rules and minimums for both couriers
4. HOME-ADDRESS RULE: for both Econt and Speedy compute total = base + address surcharge + COD fee + any known surcharges. Pick the lower one. A tie (under 0,05 €) goes to settings.home_carrier_tie_break.
   Show both prices on the label panel, e.g. "Спиди 5,89 € · Еконт 5,74 € → избран Еконт". The user can override; store the override.
   Why this is computed, not hardcoded: Speedy's COD fee is 2,4% (min 0,61 €) against Econt's 1,65%, so the winner depends on weight AND COD amount. On public tariffs: ≤1 kg with COD → usually Econt; 1–3 kg → Speedy unless COD is very high; 3–5 kg → Econt once COD passes about 64 €; 5–10 kg → Speedy. Contract prices can change all of this.
5. An undecided office/locker case (Phase 5 rule E) uses distance first; price is only the tie-break.
6. Store the chosen quote on the shipment. Recompute live on the label panel (debounced) whenever the weight, COD, carrier, type or point changes.

TESTS
- Tariff-backup math against the Appendix A rows, including the COD minimums.
- The home rule picks correctly in these cases, using the seeded tariffs: 1 kg with €20 COD; 3 kg with €60 COD; 3 kg prepaid.
- Mocked Econt calculate calls. Speedy tariff math against Appendix A. Live smoke test of Econt calculate (production login, read-only), documented in STATUS.md.

DONE WHEN
- Every shipment in the queue shows its expected shipping cost and the source of that number. Home-address shipments also show the losing courier's price.
```

**Your check:** compare 5 Econt quotes with the price e-Econt shows when you prepare the same shipment (don't create it), and 5 Speedy quotes with the calculator on speedy.bg.

---

## Phase 8 — Shipping workspace (the screen the parents use all day)

```text
PHASE 8 — Shipping workspace

Read docs/MASTER_PROMPT.md and docs/STATUS.md first.

GOAL
One calm screen per shipment. LEFT = everything about the order(s). RIGHT = the label: editable, updating live, ready to print. Plus a queue to move through the shipments.

LAYOUT (desktop ≥ 1280 px; on smaller screens the left side stacks above the right side)

TOP
- Queue tabs with counts: "Обадете се" (uncertain/error), "Готови", "Отпечатани", "Предадени", "Всички"
- Search: name, phone digits, order #, city, product
- "Следваща" button

LEFT (~55%)
- Header: recipient name (big), order number(s), certainty chip + reason, status.
- Contact: phone (big, tel: link, normalized form shown), email (mailto:), "Копирай за куриер" (port the legacy courierText).
- The address exactly as the customer typed it (Address1, Address2, Zip, City), with:
  - "Отвори в Google Maps" → https://www.google.com/maps/search/?api=1&query=<URL-encoded full address + ", Bulgaria">
  - "Търси в Google" → https://www.google.com/search?q=<URL-encoded address>
  On ERROR these two links are highlighted, and the manual point picker opens.
- Products: square photo (click to zoom; paste/drop to add → the Phase 6 popup), name with the variant in red, SKU, quantity (highlighted when > 1), unit price, line total.
- Money: for each order, Subtotal, Shipping charged, Total, payment method, Financial Status, and COD to collect (orange, big, when it's a COD order). Combined shipments show the breakdown per order.
- Flags list (red / amber / grey) with resolve buttons. Customer note and internal comment (editable).
- Call panel for uncertain/error shipments (the Phase 5 script + outcome buttons).
- Profit preview placeholder (Phase 10 fills it in).

RIGHT (~45%) — LABEL PANEL
- Editable form with every field that goes on the waybill:
  - carrier (Econt / Speedy, segmented buttons)
  - type (Офис / Автомат / Адрес)
  - office/locker picker: search by name or city, shows the distance from the customer and a map link (for Speedy, optionally Speedy's office-locator widget from Phase 4)
  - recipient name, phone
  - city + postcode (picker from the courier's list)
  - for an address: street/estate, number, block / entrance / floor / apartment
  - COD amount, declared value (optional), weight (kg), parcel count
  - contents (default "Спално бельо", built from the product types)
  - reference (order numbers), note to the courier
- Under the form: a LIVE DRAFT LABEL preview in true 100 × 150 mm proportions.
  - Top band = the carrier name in big letters (ЕКОНТ / SPEEDY) + the delivery type
  - then: recipient, phone, destination (office name + code, or the full address), COD amount in big type ("НП: 59,99 €"), weight, order references, a QR code of the order number, the sender block
  - Every keystroke in the form updates the preview immediately. No save button: autosave after 500 ms with a "Записано" indicator.
  - Optimistic locking: if someone else changed this shipment, show "Мама промени тази пратка" and reload their version.
- Buttons:
  - "Печат (чернова)": browser print, @page size 100mm 150mm, zero margins
  - "Създай товарителница" (Phase 9). For Speedy in manual mode this button reads "Подготви за MySpeedy" (Phase 9 adds the flow).
  - "Отбележи като опакована"
- Editing the address re-runs Phase 5 detection and the Phase 7 quote live, with a small "Изчислява…" state.
- A shipment with a red flag shows a red bar on the label panel, and "Създай товарителница" stays disabled until the flag is resolved. The owner can force it, with a written reason.

KEYBOARD (optional): J / K = next / previous, P = print, F = search.
ACCESSIBILITY: text at least 16 px, touch targets at least 44 px, visible focus, colour never the only signal.

TESTS (Playwright)
- Open a sample shipment, edit the phone → the preview changes instantly, and a second browser sees the change.
- An error shipment shows the highlighted Maps link, with Cyrillic correctly URL-encoded.
- The print stylesheet renders exactly one 100 × 150 mm page.

DONE WHEN (MILESTONE A)
- The parents can: import → work through the "Обадете се" tab → print draft labels → mark parcels packed, with no courier API at all.
- docs/USER_GUIDE_BG.md describes this flow step by step, with screenshots.
```

**Your check:** sit with your parents (video call) and have them ship 5 real orders using only this screen. Write down every question they ask; each one is a UI fix.

---

## Phase 9 — Official waybills (Econt by API, Speedy by MySpeedy) and printing

```text
PHASE 9 — Official waybills and printing

Read docs/MASTER_PROMPT.md and docs/STATUS.md first.

GOAL
- ECONT (api mode): "Създай товарителница" creates the real shipment at Econt, stores the waybill number and the official PDF, and prints it on the label printer with one click.
- SPEEDY (manual mode): the app prepares every waybill field ready to copy. The owner creates the waybill in MySpeedy, then attaches the waybill number + PDF in the app. The parents print it from the app exactly like an Econt label.
- The carrier name is at the top of every label.

DO
1. Settings (owner only) before anything else: the Econt sender office code and the Speedy sender office ID (settings.sender_offices), and settings.econt_env ("demo" | "production"). Both couriers: the parents drop parcels at these offices; there is no courier pickup.
2. Pre-flight validation in packages/core, for both couriers:
   - required fields per carrier and type
   - valid Bulgarian phone
   - COD ≤ the order totals
   - the office is active
   - Econt address: the city and street are resolved in Econt's own lists (cities / streets / quarters). Address parts that can't be structured go into Econt's free-text/note field.
   - Speedy address: city + postcode from the Speedy office list's towns; the full street text stays as typed (MySpeedy checks it when the owner creates the waybill).
   Show the exact list of problems in Bulgarian.
3. ECONT (api mode):
   - Confirm dialog with a summary (type, office or address, COD, weight, price, payer) → "Създай".
   - LabelService.createLabel with mode "validate", then mode "create". Sender = the Econt sender office. COD in EUR, paid out to the bank account set in the owner's e-Econt profile. Store the shipment number and the PDF: download the pdfURL file into the labels bucket immediately.
   - Change = updateLabel. Cancel = deleteLabels.
   - IDEMPOTENCY: send our shipment id as the client reference (the matching reference field — check openapi.yaml). Before creating, check whether this shipment already has a waybill. A double click must create exactly one waybill.
   - Environments: while settings.econt_env = "demo", create waybills only on https://demo.econt.com/ee/services/. Only the owner can switch to "production", and the switch asks for confirmation. Add a guard so the demo login can never be sent to production and the production login can never be used in demo mode.
4. SPEEDY (manual mode):
   a. When a Speedy shipment is ready (no red flags), its status becomes waiting_manual_waybill ("Чака товарителница (MySpeedy)").
   b. Screen "Спиди — за MySpeedy" (owner, and packers if the owner allows it in Settings): every waiting Speedy shipment as a card with the waybill fields in the order MySpeedy asks for them — recipient name, phone, destination (office/locker ID + name, or full address with postcode), COD amount, who pays the courier fee, weight, parcel count, contents, reference = order numbers — each with a copy button, plus "Копирай всичко" and an "Отвори MySpeedy" link (https://myspeedy.speedy.bg). Remind the owner on the card that the COD bank account goes into the waybill.
   c. "Прикачи товарителница": the PDF from MySpeedy (drag-and-drop, paste or file picker) + waybill number (required, digits only, checked against duplicates) + "Цена по товарителницата (€)".
      - Read both values from the PDF text automatically and prefill them: the waybill number and the courier service price. Before writing the parser, ask the owner for 2–3 real MySpeedy waybill PDFs and find the exact labels Speedy prints next to each value. Save those PDFs as test fixtures.
      - The price must come from the courier-service price on the waybill, never from the COD amount or the declared value, which are also money amounts on the same PDF. If the parser can't tell which amount is the price, leave the field empty and say "Не намерих цената — въведи я от товарителницата".
      - Show the prefilled values for the user to confirm or correct before saving. If the number typed doesn't match the one in the PDF, warn.
      - The confirmed price is stored as the real shipping price and replaces the tariff estimate everywhere (profit, reports). If there's no price, the tariff estimate stays, marked as an estimate.
      - Store the PDF in the labels bucket. Status → waybill_created. Everyone sees it at once.
   d. The parents print it with the same "Печат" button and printer as Econt labels.
   e. Editing a field after a Speedy waybill is attached → red flag "Промяна след товарителницата — оправи я в MySpeedy и прикачи новата" and a required re-attach. The app can't change or cancel Speedy waybills itself in manual mode.
   f. Never script MySpeedy (no automated logins, no scraping).
   g. Optional, only if the owner confirms MySpeedy can import shipments from a file and gives you a sample file: export the waiting shipments in that exact format. Don't build this from guesses.
5. Carrier on top: the official PDFs already carry the courier's branding, and the app's draft/backup label always has the carrier name as its top band. If a courier PDF's size doesn't match the printer, scale it to fit 100 × 150 mm, keeping the aspect ratio. Check the Econt and MySpeedy PDF sizes and write them in STATUS.md.
6. PRINTING
   - Web: load the PDF in a hidden iframe and open the print dialog.
   - Desktop (apps/desktop, Electron): a settings page lists the system printers; each computer stores its own chosen label printer locally. "Печат" prints silently to that printer (render the PDF in an offscreen window; page size 100 × 150 mm or A6; zero margins). Test print button.
   - Batch print: every "Готови" shipment that has a waybill (Econt or attached Speedy), in queue order, with an optional summary sheet.
   - Status updates automatically: printed_at, printed_by. Reprinting is allowed and counted.
7. Shipment with no waybill at all (e.g. MySpeedy is down): the button "Печат на адресен етикет" prints the draft label plus "Копирай за куриер", and the status becomes printed_draft. Show clearly: "Това не е товарителница — служителят в офиса ще я създаде и ще трябва да изчакате."

TESTS
- Econt with mocked adapters: mapping validation errors to Bulgarian; idempotency (a double click creates once); the cancel/recreate flow; the demo/production guard.
- Econt demo run: create, print and cancel one shipment for each case (office, Econtomat, address, with COD). Save the PDFs as fixtures.
- Speedy manual flow: copy fields in the right order; attaching (number validation, duplicate number, PDF stored); number AND price read correctly from the real MySpeedy PDF fixtures, including one with COD and declared value (the price must not be taken from either); empty price when unsure; printing; the re-attach flag after an edit.

DONE WHEN (MILESTONE B)
- On the parents' computer with the desktop app: pick an Econt shipment → Създай товарителница → the label comes out of the label printer → status Отпечатана on every screen.
- The owner attaches a Speedy waybill from MySpeedy on his computer → the parents print it from the app → status Отпечатана on every screen.
```

**Your check:** after switching Econt to production, send one real low-value Econt parcel from the app, and one Speedy parcel made in MySpeedy and attached in the app (to yourself or a relative). Confirm both offices accept the labels without retyping anything.

---

## Phase 10 — Stock, purchase cost, profit, shipping spend, batch history

```text
PHASE 10 — Money and stock

Read docs/MASTER_PROMPT.md and docs/STATUS.md first.

GOAL
Know what was sold, what's in stock, what it cost, what shipping cost and what profit was made: per order, per batch, per product, per month.

DO
1. STOCK: products.stock_qty changes only through stock_movements. Movement types:
   - restock (+, with unit cost)
   - sale (−, when a shipment is handed over)
   - return (+, when a returned parcel is back and resellable; the user confirms)
   - adjustment (±, with a reason)
   Наличност page: per SKU, on hand / reserved (in shipments not yet handed over) / available, the low-stock threshold, and the history. Restock form: SKU, quantity, unit cost, supplier, date.
2. ACTUAL SHIPPING COST: when an Econt waybill is created, store Econt's price; when Econt reports the final charge (Phase 11), update it. Speedy in manual mode: the price read from the waybill PDF (or typed in) when it was attached, otherwise the tariff price (marked as an estimate).
   Who pays (settings.courier_fee_payer): SENDER → it's our cost. RECIPIENT → our courier cost is 0, but the COD fee may still be ours; check the contract and make it a setting (cod_fee_payer).
3. PROFIT PER ORDER (expected first, then realized)
   - revenue = line totals − discounts (from Shopify Subtotal / Discount Amount) + shipping charged to the customer − refunds
   - cost = Σ(quantity × purchase cost valid on the order date) + courier cost paid by us + COD fee + packaging cost (setting)
   - profit = revenue − cost
   - Realized only when the parcel is delivered and the COD money has arrived (Phase 11), or when it was prepaid. A returned parcel = a loss (shipping both ways + fees).
   - Combined shipments: split the shipping and COD fees between the orders in proportion to order value.
4. Batch history page (Внасяния): every batch with date, who, file, orders new/updated, shipments created, shipped, returned, revenue, cost of goods, shipping, profit. Click → the Phase 2 batch detail.
5. Reports page (Отчети), for any date range:
   - totals
   - by product: units sold, revenue, cost, profit, margin
   - by courier: count, spend, average price, split by type
   - COD outstanding (sent, not paid yet)
   - return rate
   Every report can be exported as CSV/XLSX.
6. Missing cost or weight → profit is shown as "непълна", saying what's missing.

TESTS
- Profit math: a combined-shipment split, a return, cost history by date, prepaid vs COD.
- Stock never goes negative without a red flag. A double handover doesn't subtract stock twice.

DONE WHEN (MILESTONE C)
- The owner can answer "How much did we make in October, on which products, and how much went to Econt vs Speedy?" in two clicks.
```

**Your check:** take one real past month, calculate the profit by hand in a spreadsheet, and compare it with the report.

---

## Phase 11 — Close the loop: tracking, COD money, handover

```text
PHASE 11 — Automation loop

Read docs/MASTER_PROMPT.md and docs/STATUS.md first.

GOAL
Remove the remaining manual checking between "orders in Shopify" and "parcel delivered and paid". Each item below can be switched off in Settings.

DO
1. Tracking:
   - Econt (cron every 2 h): getShipmentStatuses for every shipment from handed_over until a final status. Map Econt's statuses to ours: delivered, returned, refused, waiting at the office. Waiting at the office for more than <<3>> days → amber flag "Клиентът не е взел пратката — обадете се".
   - Speedy (manual mode): no automatic tracking. Each Speedy shipment shows a "Проследи" link to Speedy's public tracking page with its waybill number (find the current URL format on speedy.bg), and buttons to set the status by hand (Доставена / Върната / Чака в офиса). A Speedy shipment handed over more than <<3>> days ago and still not marked → amber flag "Провери пратката в Спиди". Phase 13 replaces this with the Speedy Track API.
2. COD reconciliation:
   - Econt: paymentReport → mark COD as received, with date and amount. A mismatch → red flag.
   - Speedy (manual mode): the owner marks COD as received (date, amount) from the bank statement or MySpeedy, one by one or in bulk. A Speedy shipment delivered more than 7 days ago without COD marked → amber flag.
   - Report "Очаквани пари" (COD sent but not paid yet), for both couriers.
3. Shopify: no API connection. The owner chooses which orders to export as CSV and marks them "Fulfilled" in Shopify himself. Don't build any Shopify API calls.
4. (not used)
5. Courier pickup: not needed — the parents drop parcels at the offices. Don't build it.
6. End of day — "Предай пратките" screen: the list of printed shipments; tick each as handed over, or scan its waybill barcode with a USB scanner. Print an A4 handover list per courier with waybill numbers, COD totals and a signature line.
7. Pick list: an A4 list of every product to take off the shelf for today's ready shipments, grouped by SKU, with photos and quantities.
8. Daily summary email to the owner: imported, shipped, needing calls, delivered, returned, COD received.

TESTS
- Econt status-mapping table. Reconciliation edge cases (partial payments, duplicate payments). Speedy manual status and COD marking, including the reminder flags.

DONE WHEN
- A full week can run with the parents only doing this: import, the calls the app asks for, print, pack, hand over.
```

**Your check:** run one week this way and count how many times your parents had to open Shopify. Target: zero.

---

## Phase 12 — Deploy, install on every computer, backups, handover

```text
PHASE 12 — Production

Read docs/MASTER_PROMPT.md and docs/STATUS.md first.

DO
1. Production Supabase (EU): migrations, secrets (Econt credentials, geocoding key; Speedy credentials only after Phase 13), cron jobs, storage policies. Point-in-time recovery or a nightly pg_dump to a private bucket, plus a documented restore drill (actually restore once).
2. Web app on Cloudflare Pages with the domain <<your domain>> (or the free *.pages.dev address if "none"); PWA install prompt.
3. Electron app: a Windows installer (macOS too if needed) with auto-update from GitHub Releases. First-run wizard: log in → choose the label printer → test print.
4. Monitoring: error tracking with PII scrubbing on; Edge Function logs without customer data; an uptime check.
5. Accounts: owner (Ceco), packers (mom, dad). Remove all test data.
6. Bulgarian user guide (docs/USER_GUIDE_BG.md → printable PDF), three pages:
   - "Всеки ден" (every day)
   - "Когато пише Обадете се" (when it says "call")
   - "Ако нещо не работи" (if something doesn't work)
7. Run the end-to-end acceptance test (section 5 of docs/PHASES.md) on the parents' real computer with a real export. Record the results in STATUS.md.

DONE WHEN (MILESTONE D)
- The acceptance test passes on two computers at the same time.
```

---

## Phase 13 — Switch Speedy to API (later; only when Speedy sends API credentials)

Run this only after Speedy replies with an API username and password (and a demo account). Until then, skip it. The app is complete without it.

```text
PHASE 13 — Speedy API mode

Read docs/MASTER_PROMPT.md and docs/STATUS.md first. Speedy API credentials now exist in Supabase secrets (SPEEDY_USERNAME / SPEEDY_PASSWORD, plus the demo account SPEEDY_DEMO_USERNAME / SPEEDY_DEMO_PASSWORD).

GOAL
Speedy works like Econt: offices, prices, waybills, printing, tracking and COD all through the Speedy REST API. Manual mode stays available as a fallback switch.

DO
1. SpeedyApiAdapter implementing the full CourierAdapter interface. REST base URL https://api.speedy.bg/v1/, JSON POST with userName, password and language in the request body. Check every field name in https://api.speedy.bg/web-api.html and https://services.speedy.bg/api/api_examples.html.
2. Offices: location/office/ with countryId 100 (Bulgaria), officeType "OFFICE" or "APT" (APT = locker). Match the IDs to the offices already in courier_offices (the public list uses the same office IDs; verify on a sample) so no shipment loses its office. Replace the public-list sync.
3. Prices: the Calculate service (the official examples use serviceId 505). Recipient: pickupOfficeId for an office/locker, or an address location (siteId) for home. Content: parcelsCount, totalWeight. COD in service.additionalServices.cod (amount, processingType). payment.courierServicePayer from settings.courier_fee_payer. The tariff table becomes the backup.
4. Waybills: create with shipment/, sender = the Speedy sender office; print with print/ using paperSize from settings.label_paper ("A6" for a label printer, "A4_4xA6" for an A4 printer; the response is a PDF); cancel with the cancel endpoint. IDEMPOTENCY: our shipment id in ref1/ref2; never create twice. Same confirm dialog and pre-flight validation as Econt, with Speedy's own site/street lists.
5. Tracking (Track service) and COD (Payments service) as in Phase 11 for Econt; remove the Speedy manual reminders when in API mode.
6. Safety: Speedy has no separate test server — test only with the Speedy demo account, and add a guard so the production login can't be used in test mode.
7. Switch: the owner sets settings.courier_modes.speedy = "api". Shipments already waiting for a manual waybill stay in the manual flow; new ones use the API. Switching back to "manual" must work at any time.

TESTS
- Mocked adapter: validation-error mapping, idempotency, cancel/recreate, status mapping, reconciliation.
- Demo-account run: create, print and cancel one Speedy shipment for each case (office, locker, address, with COD). Save the PDFs as fixtures.

DONE WHEN (MILESTONE E)
- Pick a Speedy shipment → Създай товарителница → the label prints on the label printer, exactly like Econt, with no MySpeedy step.
```

**Your check:** one real low-value Speedy parcel created from the app is accepted at the office without retyping.

---

## 4. Your requirements → where each one is built

| Your requirement | Phase(s) |
|---|---|
| Shopify CSV → reduced file, remove more columns | 2 (hidden columns setting + Excel export) |
| Reduced file as readable information | 2 (batch view), 8 (workspace) |
| Econt/Speedy label format, ready-to-print label per row | §1 research, 8 (draft label), 9 (Econt waybill by API; Speedy waybill from MySpeedy, attached and printed), 13 (Speedy by API later) |
| Nearest Econt/Speedy point when not mentioned; home address if none in range | 4, 5 (rule E), 7 |
| Keyword detection in EN + BG; certain if stated, otherwise uncertain + call | 5 |
| Combine products from the same order; combine orders by phone or email per CSV | 3 |
| Address as a clickable Google Maps / Google link when detection fails | 5 (rule F), 8 |
| Calm UI: order + photo on the left, editable live label on the right | 8 |
| Photos by paste or file, saved for reuse | 6 |
| Purchase-price popup before saving a photo | 6 |
| Batch history, stock, profit, shipping cost by kg and by office/locker/address | 2, 7, 10 |
| Printer connection, courier name on top, cheapest courier for home address | 7, 9 |
| Two same-product orders one after another → call, possible mistake | 3 (rule 7) |
| Automate everything between the orders tab and sticking the label | 5, 9, 11 (Speedy fully automated only after 13) |
| Installable app on several computers, shared data, edits seen by everyone | 1, 12 |

---

## 5. End-to-end acceptance test (run in Phase 12, and again whenever something big changes)

Two people, two computers (A = Ceco, B = parents), one real Shopify export with at least 30 orders.

1. B imports the CSV. A sees the batch and the counts appear without refreshing.
2. B imports the same file again → it's rejected with a friendly message. B imports an overlapping newer export → only the new orders are added; a changed order shows a diff flag.
3. The queue shows shipments. Every combined shipment shares a phone or an email AND a destination. Nothing is combined on the name alone.
4. A planted duplicate (same customer, same products, 2 hours apart) shows a red "обадете се" flag on both orders.
5. Every shipment shows a decision. Spot-check 10: every "Сигурно" has an exact office or a complete home address; every "Обадете се" has a reason, a phone link and a script.
6. An order with an unknown city shows "Грешка", the Maps link opens the right place, and B picks an office by hand. A sees the change within seconds.
7. B pastes a photo for a new SKU → the cost popup can't be skipped → the photo then shows on A's screen and on every order with that SKU.
8. B edits the phone and the office on the right panel → the draft label changes on every keystroke. A sees "B редактира" and the new values.
9. Home-address shipments show both courier prices and the cheaper one is selected. Check 3 of them against the couriers' calculators.
10. B creates Econt waybills for 3 shipments (one each: office, Econtomat, address with COD) → the labels print on the label printer with the courier name on top → status Отпечатана everywhere. A double click creates only one waybill.
11. A makes 1 Speedy waybill in MySpeedy from the "Спиди — за MySpeedy" card and attaches its number + PDF → B sees it at once and prints it from the app.
12. B marks the shipments as handed over → the stock goes down once; a handover list prints.
13. After delivery (or a simulated status): Econt tracking updates the status and the COD amount gets reconciled automatically; for Speedy, A sets the status and marks the COD by hand. The profit for those orders changes from expected to realized.
14. The report for the test period matches a hand calculation within €0.05.

---

## Appendix A — Courier facts and seed tariffs (checked 11–12 Nov 2026)

These are public prices including VAT. Econt: the app uses Econt's API price first (your account), and these rows are only the backup. Speedy (manual mode): these rows are the price source until Phase 13.

### Speedy — official price list, Standard 24 hours, domestic (valid on 11.11.2026; same prices confirmed on 12.11.2026)

The price list says prices include VAT and the fuel surcharge; the toll surcharge comes on top.

| Tariff weight | Office/locker → office/locker | Address delivery surcharge | Office/locker → address (total) |
|---|---|---|---|
| ≤ 3 kg | 2,69 € | 2,59 € | 5,28 € |
| ≤ 6 kg | 3,74 € | 4,27 € | 8,01 € |
| ≤ 10 kg | 4,62 € | 4,27 € | 8,89 € |
| ≤ 20 kg | 8,23 € | 5,99 € | 14,22 € |
| ≤ 31,5 kg | 8,23 € + 0,36 €/extra kg (check where it starts) | 8,52 € | check |

- Promo: office/locker → locker, ≤ 3 kg = 1,52 € including everything, valid until 01.01.2027 (conditions apply).
- Locker size limit: smaller than 60 × 35 × 37 cm.
- COD fee: 2,4% of the COD amount, minimum 0,61 € (bank transfer or cash at an office) or minimum 0,92 € (cash at the address). +0,96% if the recipient pays by card.
- Charged weight = the bigger of the real and the volumetric weight (1 m³ = 200 kg).
- Speedy raised its prices by 5,7% from 01.07.2026.
- A Saturday delivery surcharge of 2,21 € applies to non-typical addresses.

### Econt — official tariff, valid from 01.10.2026 (Econt's own tariff PDF)

Prices per parcel, including VAT and the 13,50% fuel and road-conditions fee.

| Weight | Office (or Econtomat) | Econtomat, waybill made in e-Econt (−10%) | Address, town WITH an Econt office | Address, town WITHOUT an Econt office |
|---|---|---|---|---|
| ≤ 1 kg | 4,10 € | 3,69 € | 5,41 € | 6,70 € |
| ≤ 2 kg | 4,49 € | 4,04 € | 6,70 € | 7,98 € |
| ≤ 5 kg | 4,90 € | 4,41 € | 8,49 € | 9,80 € |
| ≤ 10 kg | 7,84 € | 7,06 € | 12,62 € | 14,15 € |
| ≤ 15 kg | 8,82 € | 7,94 € | 17,00 € | 18,53 € |
| ≤ 20 kg | 10,79 € | 9,71 € | 19,82 € | 21,63 € |

- Econtomat discount: 10% off the base service for parcels prepared through the e-Econt account (which includes waybills made by the app through the API) or at an Econt office; 50% off when sent and received at the same Econtomat. The −10% column is calculated from the office price.
- Above 20 kg (third-party summary): +0,43 €/kg to an office, +0,52 €/kg to an address (up to 50 kg).
- COD fee: 1,65% paid out electronically (bank account) — official. In cash: 3,30% (third-party summary). Contract rates are usually lower.

### What this means for "cheaper courier to a home address" (public prices, town with an Econt office)

| Case | Speedy | Econt | Cheaper |
|---|---|---|---|
| 1 kg, prepaid | 5,28 € | 5,41 € | Speedy |
| 1 kg, 20 € COD | 5,28 + 0,61 = 5,89 € | 5,41 + 0,33 = 5,74 € | Econt |
| 3 kg, 60 € COD | 5,28 + 1,44 = 6,72 € | 8,49 + 0,99 = 9,48 € | Speedy |
| 5 kg, 100 € COD | 8,01 + 2,40 = 10,41 € | 8,49 + 1,65 = 10,14 € | Econt |
| 10 kg, 100 € COD | 8,89 + 2,40 = 11,29 € | 12,62 + 1,65 = 14,27 € | Speedy |

In towns without an Econt office, Econt's address price is higher (last column above), so Speedy wins more often there. The app computes this for every shipment (Phase 7). It doesn't use a fixed rule.

### Payment facts (no contract)

- Courier fee paid by the sender: paid at the counter when the parcel is handed over. Paying monthly by invoice needs a contract (Econt "на кредит" needs a contract and a client number; Speedy sends monthly e-invoices only to contract clients).
- Courier fee paid by the recipient: the customer pays it when collecting the parcel; nothing is paid at drop-off.
- COD payout: Econt to the bank account in the e-Econt profile; Speedy to the bank account written into the waybill in MySpeedy. COD left at a Speedy office must be collected within 30 days, after which it is archived.

### API and data facts the phases rely on

- **Econt (api mode, Phases 4–11):** JSON API. Production `https://ee.econt.com/services/`, demo `https://demo.econt.com/ee/services/` (the demo endpoints differ from production). Production login = the e-Econt API login (e-Econt → Профил → Интеграция за онлайн магазини; username = the e-Econt email). LabelService.createLabel modes: calculate, validate, create, calculate_with_block. It returns a pdfURL for the label. Office class: code, isAPS (automatic post station), isMPS (mobile post station), name, nameEn, address, plus a GeoLocation with latitude/longitude and confidence 0–3. Other methods: getCities, getStreets, getQuarters, updateLabel, deleteLabels, requestCourier, getShipmentStatuses, paymentReport. Shipments in euro must send the currency for COD and declared value. There's an Office Locator guide on the API page, and an OpenAPI spec at `/services/openapi.yaml`.
- **Speedy (manual mode, until Phase 13):** public office list `https://services.speedy.bg/office_locator_widget_v2/offices_list.php?lang=bg&countryId=` (office ID in brackets, "(АВТОМАТ)" = locker, address with postcode, hours); public office map page per office `https://services.speedy.bg/officesmap_v2/?lang=bg&id=<ID>`; office-locator widget for websites `https://services.speedy.bg/office_locator_widget_v3/`. Waybills are made in MySpeedy (`https://myspeedy.speedy.bg`); a private person ("Частно лице") can register and, after an identity check, create COD waybills there.
- **Speedy (api mode, Phase 13):** REST `https://api.speedy.bg/v1/`, JSON POST with userName, password and language in the body. Service groups: Shipment, Print, Track, Pickup, Location, Calculate, Client, Validation, Services, Payments. Office search: `location/office/`, where officeType "APT" = lockers and "OFFICE" = offices. A shipment to an office or locker uses recipient.pickupOfficeId. COD: `service.additionalServices.cod.amount` and `processingType` ("CASH" or "POSTAL_MONEY_TRANSFER"). Print: `print/`, paperSize "A4" / "A6" / "A4_4xA6", and the response is a PDF. Label spec: A6 (105 × 148 mm), Code 128 barcode with the parcel number and routing data. There's no separate sandbox; a demo account works on the live address. API access is requested by email and comes as an API user and password separate from the MySpeedy login.

---

## Appendix B — Detection dictionary and test examples (Phase 5)

Match on normalized text (lowercase, no punctuation) and on transliterated copies. Use whole-word matching where it makes sense: "apt" must not match inside "apteka", the transliterated form of "аптека" (pharmacy).

**Econt:** еконт, еконта, econt, ekont, ekonta, е-конт, еконтомат, econtomat, ekontomat, aps
**Speedy:** спиди, спийди, спидито, speedy, spidi, spiidi, apt
**Other courier (→ ERROR, manual):** box now, boxnow, бокс нау, боксноу, sameday, сеймдей, pigeon, пиджън
**Office words:** офис, офиса, ofis, office, клон, филиал
**Locker words:** автомат, автомата, avtomat, пакетомат, paketomat, локер, locker, еконтомат, econtomat, apt, aps
**Home words:** личен адрес, до адрес, адресна доставка, доставка до адрес, до врата, до вкъщи, вкъщи, домашен адрес, до дома, lichen adres, do adres, home address, to address, to my address, to the door, door delivery
**Street-pattern hints:** ул., улица, бул., булевард, ж.к., жк, кв., квартал, бл., блок, вх., ет., ап., №, ul., ulitsa, bul., zh.k., jk, kv., bl., vh., et., ap., No.

**Example cases (input → expected):**

| Address1 / Address2 / Notes | Expected |
|---|---|
| "Офис Еконт – Пловдив Тест", Пловдив 4000 | Econt office, CERTAIN if exactly one office matches, else C |
| "Еконтомат Тракия", Пловдив | Econt locker (by the matched point's type) |
| "Speedy автомат 123", София | Speedy locker if ID 123 exists, else C |
| "до офис на спиди", Русе | Speedy office, UNCERTAIN (C) — several offices in Ruse |
| "Ekont ofis Mladost 1", Sofia | Econt office (Latin), A or C |
| "ул. Примерна 12, личен адрес" | Home address, CERTAIN (B) |
| "ул. Опитна 21", Русе (nothing else) | Rule E: nearest point within range, UNCERTAIN, with the "looks like a home address" hint |
| "с. Малко село 5" (no point within range) | Rule E: home address, UNCERTAIN |
| "Еконт или Спиди, все едно" | Conflict, UNCERTAIN (D) |
| "офис еконт", Address2 "бл. 5, ап. 12" | Conflict, UNCERTAIN (D) |
| "BOX NOW Лозенец" | ERROR (F), other courier |
| Empty address, empty city | ERROR (F) |
| Shipping Method "Спиди – до автомат" + Note Attributes "Автомат Спиди Младост 4" | Speedy locker, CERTAIN (A) |

---

## Appendix C — Sources

- Speedy price list (valid 11.11.2026 and 12.11.2026): https://services.speedy.bg/priceList/?lang=en
- Speedy price update notice (+5.7% from 01.07.2026): https://www.speedy.bg/en/post/Tariff-Update-Notice-July-2026
- Speedy public office list: https://services.speedy.bg/office_locator_widget_v2/offices_list.php?lang=bg&countryId=
- Speedy office map page (example): https://services.speedy.bg/officesmap_v2/?lang=bg&id=9034
- Speedy integrations page (office-locator widget v3, API examples): https://www.speedy.bg/bg/integrations-and-automations
- MySpeedy registration (Частно лице / Юридическо лице): https://myspeedy.speedy.bg/signup
- Speedy remote identification for private persons: https://www.speedy.bg/bg/remote-identification
- Speedy FAQ (COD to bank account via MySpeedy, invoices for contract clients, 30-day COD pickup): https://www.speedy.bg/bg/faq?category=3
- Speedy REST API examples: https://services.speedy.bg/api/api_examples.html
- Speedy REST API docs: https://api.speedy.bg/web-api.html
- Speedy routing label specification (A6): https://api.speedy.bg/api/docs/examples/RoutingLabelSpecification_spd.pdf
- Speedy integration page: https://www.speedy.bg/en/system-integration
- Speedy API access by email (third-party setup guide): https://easy-sales.com/en/guides/connect-speedy-courier-with-easysales
- Econt official courier tariff (valid from 01.10.2026): https://admin-ee.econt.com/doc_templates/tariffs/courier-bg-bg.pdf
- Econt developer page (production login = e-Econt user; demo login): https://www.econt.com/developers/xml-api.html
- Econt API (EEcont) overview: http://ee.econt.com/services/
- Econt Shipments model (LabelService.createLabel, modes, pdfURL): http://ee.econt.com/services/Shipments/
- Econt Nomenclatures model (Office: isAPS, isMPS, GeoLocation): http://ee.econt.com/services/Nomenclatures/
- Econt OpenAPI spec: https://ee.econt.com/services/openapi.yaml
- Econt Greece API guide (base URLs, getOffices response example): https://ee.econt.com/doc_templates/GreeceIntegrationAPIGuide.php
- Econt integration settings ("Създай потребителско име и парола", "на кредит" needs a contract): https://www.gombashop.bg/addons_econt_settings.html
- Econt public prices 2026 (third-party summary): https://sendway.eu/kurieri-za-shopify/econt/ceni
- Econt vs Speedy price comparison (third-party): https://sendway.eu/kurieri-za-shopify/sravnenie-ceni
- Econt API wrapper (method list): https://github.com/gdinko/econt
- Speedy PHP SDK (service groups, no-sandbox note): https://packagist.org/packages/ux2dev/speedy , https://packagist.org/packages/givanov95/laravel-shipping-speedy
- Speedy TypeScript SDK (calculate request shape): https://www.pkgstats.com/pkg:@alphabite/speedy-sdk
- Euro in Bulgaria from 01.01.2026 (courier tariff note): https://www.tnt.com/content/dam/tnt_express_media/express-master/shipping-services/docs/additional-services-bg-bg.pdf
