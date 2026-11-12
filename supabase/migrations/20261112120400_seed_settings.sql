-- Phase 1 / migration 5 — default settings
-- Kept in a migration (not seed.sql) so the hosted database gets them too.
-- Must match SETTINGS_DEFAULTS in packages/core/src/settings.ts (checked by tests).
-- ON CONFLICT DO NOTHING: never overwrite a value the owner already changed.

insert into public.settings (key, value, description) values
  ('sender_profile', '{}'::jsonb,
    'Sender name, phone and address printed on waybills'),
  ('office_range_km', '5'::jsonb,
    'How far (km) from the customer address an office or locker may be suggested'),
  ('duplicate_window_hours', '48'::jsonb,
    'Orders from the same customer within this many hours are checked as possible duplicates'),
  ('default_parcel_weight_g', '1500'::jsonb,
    'Parcel weight (grams) used when the products have no weight'),
  ('packaging_weight_g', '200'::jsonb,
    'Weight of the packaging (grams) added to every parcel'),
  ('packaging_cost_cents', '0'::jsonb,
    'Cost of the packaging per parcel (euro cents)'),
  ('courier_fee_payer', '"SENDER"'::jsonb,
    'Who pays the courier fee: SENDER (the shop) or RECIPIENT'),
  ('home_carrier_tie_break', '"speedy"'::jsonb,
    'Courier chosen for home delivery when both cost the same'),
  ('hidden_columns', '[]'::jsonb,
    'CSV columns hidden in the app'),
  ('raw_csv_retention_days', '90'::jsonb,
    'Days to keep uploaded CSV files before they are deleted automatically'),
  ('label_paper', '"A6"'::jsonb,
    'Label paper: A6, A4 or A4_4xA6'),
  ('courier_modes', '{"econt": "api", "speedy": "manual"}'::jsonb,
    'api = the app creates waybills; manual = the owner makes them by hand'),
  ('econt_env', '"demo"'::jsonb,
    'Econt environment for waybills: demo or production'),
  ('sender_offices', '{}'::jsonb,
    'Drop-off offices: {"econt": "<office code>", "speedy": "<office ID>"}')
on conflict (key) do nothing;
