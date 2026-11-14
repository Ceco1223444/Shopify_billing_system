import type { DictionaryAdditions } from './detect/dictionary.ts';
import type { CourierMode, SupportedCarrier } from './domain';
import type { GeocoderSettings } from './geo/nominatim.ts';
import { DEFAULT_VISIBLE_COLUMNS } from './import/columns';

export type { GeocoderSettings };

/**
 * Default values seeded into the `settings` table (key -> jsonb value) by
 * supabase/migrations/*_seed_settings.sql. The owner edits them in the UI later.
 * The integration tests check that the database seed matches this object.
 */
export interface AppSettings {
  sender_profile: Record<string, unknown>;
  office_range_km: number;
  duplicate_window_hours: number;
  default_parcel_weight_g: number;
  packaging_weight_g: number;
  packaging_cost_cents: number;
  courier_fee_payer: 'SENDER' | 'RECIPIENT';
  home_carrier_tie_break: SupportedCarrier;
  /** Columns shown in the batch view and the Excel export, in order (Phase 2). */
  visible_columns: string[];
  /** Kept for compatibility: the default columns that are not in visible_columns. */
  hidden_columns: string[];
  raw_csv_retention_days: number;
  label_paper: 'A6' | 'A4' | 'A4_4xA6';
  courier_modes: Record<SupportedCarrier, CourierMode>;
  econt_env: 'demo' | 'production';
  sender_offices: Partial<Record<SupportedCarrier, string>>;
  /** Phase 4: the geocoder (provider, URL, on/off). Changeable without a new app version. */
  geocoder: GeocoderSettings;
  /** Phase 5: the owner's extra detection words, merged with Appendix B. */
  detection_dictionary: DictionaryAdditions;
}

export type SettingKey = keyof AppSettings;

export const SETTINGS_DEFAULTS: AppSettings = {
  sender_profile: {},
  office_range_km: 1, // Phase 5 owner decision (was 5)
  duplicate_window_hours: 48,
  default_parcel_weight_g: 1500,
  packaging_weight_g: 200,
  packaging_cost_cents: 0,
  courier_fee_payer: 'SENDER',
  home_carrier_tie_break: 'econt', // Phase 5 owner decision (was speedy)
  visible_columns: [...DEFAULT_VISIBLE_COLUMNS],
  hidden_columns: [],
  raw_csv_retention_days: 90,
  label_paper: 'A6',
  courier_modes: { econt: 'api', speedy: 'manual' },
  econt_env: 'demo',
  sender_offices: {},
  // Geoapify since 14 Nov 2026 (owner's choice): Nominatim refuses Supabase Edge Functions.
  geocoder: {
    provider: 'geoapify',
    url: 'https://api.geoapify.com/v1/geocode',
    enabled: true,
    email: null,
  },
  detection_dictionary: {},
};
