# Master Prompt — HappyHome Shipping Hub

You are the lead engineer on "HappyHome Shipping Hub". Read this whole brief before doing anything. It is the source of truth for every phase. If a phase prompt conflicts with this brief, stop and ask me.

## 1. BUSINESS CONTEXT

- HappyHome is a Bulgarian-language Shopify store (Dawn theme) selling bedding: bed linen sets, duvets, pillows, towels. Prices in EUR. Payments: bank transfer or cash on delivery (COD = "наложен платеж" = НП). COD refunds go back through the couriers.
- The owner (Ceco) lives in the Netherlands. His parents in Bulgaria pack and ship. They are not technical, and they refuse to check every order by hand in Shopify. The app must remove that checking work: they open the app, see what to ship, call only the customers the app tells them to call, print the label, stick it on, hand the parcel over.
- Couriers: Econt (Еконт) and Speedy (Спиди). Delivery types: courier office, courier locker (Econt "Еконтомат" = APS; Speedy "автомат" = APT), or home address ("личен адрес"). BOX NOW and other couriers are out of scope: detect them and flag them only.
- Several computers (Ceco's in NL, the parents' in BG) share the same live data. An edit on one screen shows on the others within seconds.

## 2. USERS AND UI LANGUAGE

- The UI defaults to Bulgarian, with a full English toggle. Every user-facing string goes through i18n (bg + en). Every flag or warning has Bulgarian text written for a non-technical reader, plus the reason behind it.
- Calm, basic UI: light background, large text (body at least 16 px), few colours. Use colour only for status (green = certain/ready, amber = check/call, red = error/do not ship), and never as the only signal: always add an icon and a word. Big buttons. No modal dialogs except where this brief or a phase requires one. Keyboard shortcuts are allowed, but nothing may depend on them.

## 3. EXISTING ASSETS (port them, don't rewrite from scratch)

`/legacy/shopify-shipping-converter.html` is an offline converter. Its "Core" module has pure, reusable logic:

- encoding detection (UTF-8 BOM, UTF-16 LE/BE, Windows-1251 fallback for Cyrillic)
- delimiter detection and an RFC 4180 CSV parser
- Shopify continuation rows (order details only on an order's first row; only identifiers repeated)
- column matching by normalized header
- removing the leading apostrophe on zip/phone
- Bulgarian phone validation and match key: +359 / 00359 / 359 become 0, and a 9-digit mobile without its leading 0 gets the 0 added
- 4-digit postcode check; cancelled / fulfilled / partially fulfilled checks
- COD detection with `/cash on delivery|\bcod\b|наложен/i`
- Outstanding Balance vs Total check
- repeated-file detection (FNV-1a hash); repeated order numbers (identical vs conflicting copies)
- customer grouping (union-find on email, or phone + name); same-products warning
- an XLSX writer with no libraries (Shipping / Warnings / Notes sheets, yellow rows for multi-order customers and multi-product orders)
- synthetic sample data (`sampleFiles`)

Its 18 output columns: order_id(Name), Lineitem name, Lineitem price, Shipping City, Shipping Address1, Shipping Address2, Shipping Name, Shipping Phone, Shipping Zip, Currency, Subtotal, Shipping, Total, Email, Fulfillment Status, Payment Method, Lineitem sku, Lineitem quantity, plus an empty Product Photo column. These are read for checks only: Billing Phone, Financial Status, Outstanding Balance, Cancelled at, Shipping Country, Shipping Company, Notes, Note Attributes, Phone, Payment Terms Name, Lineitem requires shipping, Id.

`/legacy/delivery-board.html` is a viewer/editor. Reusable parts:

- XLSX reader, including pictures placed in or over cells
- ✓ send / ✗ don't-send marks; editable fields
- EN/BG string tables
- the `courierOf` keyword hint (econt / speedy / boxnow)
- product variant = the text after the last " - ", shown in red
- square photo crop (centred, max 800 px, JPEG quality 0.86)
- photo library keyed `"sku:<sku>"`, else `"name:<name>"`
- copy-for-courier text; sorting; reading saved board files (`readSavedBoard`)

Port the pure functions into `packages/core` as TypeScript. Before changing anything, write unit tests showing that the legacy code and the ported code give the same results on the legacy sample data. Keep the legacy behaviour unless a phase says to change it.

Known change: the legacy board merges deliveries on the name alone. The new app must NEVER combine shipments on the name alone, because two different people can have the same name. A name-only match is only a hint.

## 4. ARCHITECTURE (fixed unless I approve a change)

- Monorepo (pnpm workspaces):
  - `apps/web`: React + TypeScript + Vite, installable as a PWA
  - `apps/desktop`: an Electron shell around the same web app, for silent label printing
  - `packages/core`: pure TypeScript domain logic, no I/O
  - `supabase/`: migrations, Edge Functions, seed data
- Backend: Supabase in the EU region.
  - Postgres for all data
  - Auth: email + password, one account per person
  - Storage: raw CSV files, product photos, label PDFs
  - Realtime: live updates + presence
  - Edge Functions (TypeScript) for every call to a courier, Shopify or geocoding API. Credentials live only in Supabase secrets, never in the browser.
- Hosting: the web app on Vercel. The desktop app loads the same URL inside Electron.
- Money: store integer euro cents; display it like "12,34 €" (bg-BG). Weight: integer grams. Time: timestamptz, displayed in Europe/Sofia.
- Every table has: id uuid, created_at, updated_at, updated_by, version int (optimistic locking). An audit_log table records every user edit: who, when, table, row, before, after.
- Row-level security (RLS) on every table: only authenticated members of the shop get access. Role "owner" can change settings, credentials and tariffs, and can delete. Role "packer" can do everything else.

## 5. DOMAIN MODEL (initial; phases extend it with migrations)

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

Shipment status pipeline: imported → needs_check → ready → waybill_created → printed (or printed_draft when that courier has no API access) → handed_over → delivered | returned | cancelled.

Bulgarian labels: Внесена, За проверка, Готова, Товарителница създадена, Отпечатана (Отпечатан адресен етикет), Предадена, Доставена, Върната, Отказана.

## 6. GLOSSARY

НП / наложен платеж = cash on delivery (COD). Товарителница = waybill (official courier label). Офис = courier office. Автомат / Еконтомат / APS / APT / пакетомат = locker. Личен адрес / до адрес = home delivery. ОС / обявена стойност = declared value. ж.к. = housing estate, бл. = block, вх. = entrance, ет. = floor, ап. = apartment.

## 7. NON-NEGOTIABLE RULES

- Never delete or overwrite imported data silently. A re-import updates with a diff and an audit entry. If an order that already has a waybill changes, create a red flag.
- Never mark anything with a red flag as ready to ship, unless the owner overrides it with a written reason (audited). Never ship a cancelled order.
- Never invent courier data. Offices, prices and waybills come from the courier APIs, or from the seeded tariff table, clearly labelled "ориентировъчна цена".
- A courier "create shipment" call costs real money and creates a real parcel. It runs only on an explicit user click, after a confirm summary, and it is idempotent: never create two waybills for one shipment.
- Personal data stays in Supabase EU. No customer data in logs, analytics or third-party AI calls. Raw CSV files are deleted automatically after the number of days in settings.raw_csv_retention_days.
- Every automatic decision stores its reasons (a machine code + bg/en text), so a parent can see why it was made.
- Show phone numbers as typed and also normalized. tel: links use the normalized +359 form.
- Never overwrite a value a user picked by hand. Store manual_override = true, and automatic logic leaves it alone.

## 8. HOW YOU WORK

- Start every phase by reading this brief and docs/STATUS.md, listing the files you'll touch and listing your assumptions. Then implement.
- TypeScript strict. Vitest for unit tests, Playwright for end-to-end tests. Every packages/core function has tests. Courier, Shopify and geocoding calls sit behind adapter interfaces, with mock implementations for tests.
- Small commits with clear messages. Database changes only through migrations.
- At the end of every phase: all tests green, docs/STATUS.md updated (what's done, how to run it, known gaps), and docs/USER_GUIDE_BG.md updated for any new screen (short, in Bulgarian, for the parents).
- If an external API behaves differently from what a prompt says, trust the official docs and the live response, write the difference down in docs/STATUS.md, and tell me.
- Stop and ask me (don't guess) when: a requirement is ambiguous in a way that changes data or money; an API needs credentials you don't have; or a change would break a legacy behaviour.
