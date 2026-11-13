import type { SupportedCarrier } from '@happyhome/core';

/** The courier_sync_runs columns the screens use. */
export interface SyncRun {
  id: string;
  carrier: SupportedCarrier;
  status: 'running' | 'ok' | 'failed';
  stage: string;
  trigger: string;
  source: string | null;
  started_at: string;
  finished_at: string | null;
  fetched: number | null;
  inserted: number;
  updated: number;
  unchanged: number;
  reactivated: number;
  deactivated: number;
  warnings: unknown;
  error_code: string | null;
}

export const SYNC_RUN_COLUMNS =
  'id, carrier, status, stage, trigger, source, started_at, finished_at, fetched, inserted, ' +
  'updated, unchanged, reactivated, deactivated, warnings, error_code';

const newestFirst = (a: SyncRun, b: SyncRun) => b.started_at.localeCompare(a.started_at);

export interface CarrierSyncState {
  /** The newest run of any status. */
  latest: SyncRun | null;
  /** The newest successful run (its finish time = "last sync"). */
  lastOk: SyncRun | null;
  running: boolean;
  /**
   * P4-10: the newest FINISHED run failed → "Списъкът с офиси … не се обнови". A run that is
   * still going does not hide it; a later successful run does.
   */
  failed: SyncRun | null;
}

export function carrierSyncState(runs: SyncRun[], carrier: SupportedCarrier): CarrierSyncState {
  const mine = runs.filter((r) => r.carrier === carrier).sort(newestFirst);
  const finished = mine.find((r) => r.status !== 'running') ?? null;
  return {
    latest: mine[0] ?? null,
    lastOk: mine.find((r) => r.status === 'ok') ?? null,
    running: mine.some((r) => r.status === 'running'),
    failed: finished?.status === 'failed' ? finished : null,
  };
}

/** Couriers whose office list did not update (for the red banner). */
export function failedCarriers(runs: SyncRun[]): SupportedCarrier[] {
  return (['econt', 'speedy'] as const).filter((c) => carrierSyncState(runs, c).failed);
}

/** Error codes the screens have a Bulgarian / English text for. */
export const KNOWN_SYNC_ERRORS = [
  'fetch_failed',
  'parse_failed',
  'too_few_points',
  'mode_not_available',
  'too_many_attempts',
  'error',
] as const;
export type KnownSyncError = (typeof KNOWN_SYNC_ERRORS)[number];

export function syncErrorKey(code: string | null): KnownSyncError {
  return (KNOWN_SYNC_ERRORS as readonly string[]).includes(code ?? '')
    ? (code as KnownSyncError)
    : 'error';
}

export interface PointStat {
  carrier: SupportedCarrier;
  type: 'office' | 'locker' | 'mobile';
  active: boolean;
  total: number;
  with_coords: number;
}

export interface CarrierCounts {
  office: number;
  locker: number;
  mobile: number;
  active: number;
  withCoords: number;
  inactive: number;
}

/** courier_points_stats rows → counts per carrier (P4-26). */
export function countsByCarrier(stats: PointStat[]): Record<SupportedCarrier, CarrierCounts> {
  const empty = (): CarrierCounts => ({
    office: 0,
    locker: 0,
    mobile: 0,
    active: 0,
    withCoords: 0,
    inactive: 0,
  });
  const out = { econt: empty(), speedy: empty() };
  for (const s of stats) {
    const c = out[s.carrier];
    if (!c) continue;
    if (s.active) {
      c[s.type] += Number(s.total);
      c.active += Number(s.total);
      c.withCoords += Number(s.with_coords);
    } else {
      c.inactive += Number(s.total);
    }
  }
  return out;
}
