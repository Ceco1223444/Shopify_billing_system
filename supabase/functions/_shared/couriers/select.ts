/**
 * P4-03: the adapter for each courier comes from settings.courier_modes. The rest of the code
 * only sees a CourierAdapter.
 */
import {
  fail,
  ok,
  type CourierAdapter,
  type CourierMode,
  type CourierResult,
  type EcontEnv,
  type SupportedCarrier,
} from '../core.ts';
import { EcontApiAdapter, type EcontLogin } from './econt-api-adapter.ts';
import { SpeedyManualAdapter, type TariffBand } from './speedy-manual-adapter.ts';

export interface AdapterDeps {
  fetch: typeof fetch;
  econtProductionLogin: EcontLogin | null;
  /** settings.econt_env: prices and (Phase 9) waybills. */
  econtShipmentEnv: EcontEnv;
  findTariff(
    carrier: SupportedCarrier,
    deliveryType: 'office' | 'locker' | 'address',
    weightG: number,
  ): Promise<TariffBand | null>;
}

/**
 * Offices always come from Econt PRODUCTION (read-only, no login needed): the demo office list
 * is test data (e.g. an office called "DHLEDI", 2 lockers instead of ~50).
 */
export const ECONT_OFFICES_ENV: EcontEnv = 'production';

export function selectAdapter(
  carrier: SupportedCarrier,
  mode: CourierMode | undefined,
  deps: AdapterDeps,
): CourierResult<CourierAdapter> {
  if (carrier === 'econt' && mode === 'api') {
    return ok(
      new EcontApiAdapter({
        dataEnv: ECONT_OFFICES_ENV,
        shipmentEnv: deps.econtShipmentEnv,
        productionLogin: deps.econtProductionLogin,
        fetch: deps.fetch,
      }),
    );
  }
  if (carrier === 'speedy' && mode === 'manual') {
    return ok(
      new SpeedyManualAdapter({
        fetch: deps.fetch,
        findTariff: (type, weight) => deps.findTariff('speedy', type, weight),
      }),
    );
  }
  // Speedy "api" is Phase 13; Econt has no manual mode.
  return fail({
    code: 'mode_not_available',
    message: `No adapter for ${carrier} in "${mode ?? 'unset'}" mode`,
  });
}
