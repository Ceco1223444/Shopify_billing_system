/**
 * The courier-sync job (P4-13 … P4-16), shared by the Edge Function and the tests.
 *
 *  start     create (or reuse) a run per carrier, then work on it
 *  continue  work on runs that stopped (time limit, crash), then geocode points without
 *            coordinates (bulk pace: 4 per minute)
 *
 * A run is "leased" while a call works on it, so two calls never work on the same run. Every
 * call stops starting new work after its time budget; whatever is left is picked up by the next
 * call (pg_cron every 5 minutes, or the owner's page while it is open).
 */
import {
  runSyncStep,
  type CourierAdapter,
  type CourierResult,
  type GeocoderSettings,
  type SupportedCarrier,
  type SyncRunState,
  type SyncStepOutcome,
} from './core.ts';
import { call, rowOrNull, type Db } from './db.ts';
import { geocodeAddress } from './geocoder.ts';
import { dbSyncStore } from './sync-store.ts';

/** More calls than this for one run = something is wrong; the run is failed (data kept). */
export const MAX_RUN_ATTEMPTS = 10;

export interface SyncRunRow extends SyncRunState {
  attempts: number;
  lease_until: string | null;
  started_at: string;
  inserted: number;
  updated: number;
  unchanged: number;
  reactivated: number;
  deactivated: number;
  error_code: string | null;
}

export interface SyncJobDeps {
  db: Db;
  adapterFor(carrier: SupportedCarrier): Promise<CourierResult<CourierAdapter>>;
  /** Stop starting new work after this many ms. */
  budgetMs: number;
  /** A run is reserved for this long per call (longer than the budget). */
  leaseSeconds: number;
  now?: () => number;
  /** Points per database transaction when applying (default 300). */
  batchSize?: number;
  /** For geocoding points without coordinates; null = skip that part. */
  geocoder?: {
    settings: GeocoderSettings;
    fetch: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
  } | null;
  /** Logs only codes and counts: never customer data. */
  log?: (message: string) => void;
}

export interface ProcessedRun {
  runId: string;
  carrier: SupportedCarrier;
  outcome: SyncStepOutcome | { state: 'busy' } | { state: 'error'; message: string };
}

const clock = (deps: SyncJobDeps) => deps.now ?? (() => Date.now());

export async function startRuns(
  carriers: SupportedCarrier[],
  trigger: 'cron' | 'manual' | 'test',
  actor: string | null,
  deps: SyncJobDeps,
): Promise<SyncRunRow[]> {
  const runs: SyncRunRow[] = [];
  for (const carrier of carriers) {
    runs.push(
      await call<SyncRunRow>(deps.db, 'courier_sync_start', {
        p_carrier: carrier,
        p_trigger: trigger,
        p_actor: actor,
      }),
    );
  }
  return runs;
}

/** Work on one run within the remaining budget. */
export async function processRun(
  runId: string,
  deps: SyncJobDeps,
  budgetMs: number,
): Promise<ProcessedRun | null> {
  const run = rowOrNull(
    await call<SyncRunRow | null>(deps.db, 'courier_sync_claim', {
      p_run: runId,
      p_seconds: deps.leaseSeconds,
    }),
  );
  if (!run) return null; // another call has it, or it has finished
  const store = dbSyncStore(deps.db);
  const result = (outcome: ProcessedRun['outcome']): ProcessedRun => ({
    runId,
    carrier: run.carrier,
    outcome,
  });
  try {
    if (run.attempts > MAX_RUN_ATTEMPTS) {
      const message = `Stopped after ${run.attempts - 1} attempts`;
      await store.fail(runId, 'too_many_attempts', message);
      return result({ state: 'failed', code: 'too_many_attempts', message });
    }
    const adapter = await deps.adapterFor(run.carrier);
    if (!adapter.ok) {
      await store.fail(runId, 'mode_not_available', adapter.error.message);
      return result({
        state: 'failed',
        code: 'mode_not_available',
        message: adapter.error.message,
      });
    }
    const outcome = await runSyncStep(run, adapter.value, store, {
      budgetMs,
      now: clock(deps),
      applyBatch: deps.batchSize,
    });
    deps.log?.(`courier-sync ${run.carrier} ${run.id}: ${outcome.state}`);
    return result(outcome);
  } catch (e) {
    // Database or network trouble: leave the run as it is; a later call resumes it.
    const message = (e as Error).message;
    deps.log?.(
      `courier-sync ${run.carrier} ${run.id}: error ${(e as { code?: string }).code ?? ''}`,
    );
    return result({ state: 'error', message });
  } finally {
    await call(deps.db, 'courier_sync_release', { p_run: runId }).catch(() => undefined);
  }
}

export async function processRuns(runIds: string[], deps: SyncJobDeps): Promise<ProcessedRun[]> {
  const now = clock(deps);
  const started = now();
  const done: ProcessedRun[] = [];
  for (const id of runIds) {
    const left = deps.budgetMs - (now() - started);
    if (left <= 0) break;
    const processed = await processRun(id, deps, left);
    if (processed) done.push(processed);
  }
  return done;
}

interface PendingPoint {
  id: string;
  city: string | null;
  postcode: string | null;
  address_text: string | null;
}

/**
 * Points without coordinates from the courier (or whose address changed): geocode them at the
 * scheduled-job pace. Returns how many were tried.
 */
export async function geocodePendingPoints(deps: SyncJobDeps, budgetMs: number): Promise<number> {
  if (!deps.geocoder?.settings.enabled) return 0;
  const now = clock(deps);
  const started = now();
  let tried = 0;
  while (now() - started < budgetMs) {
    const [point] = await call<PendingPoint[]>(deps.db, 'courier_points_claim_geocode', {
      p_limit: 1,
    });
    if (!point) break;
    const outcome = await geocodeAddress(
      {
        // "гр. Айтос [8500] ул. Славянска No 34" → the street part; city and postcode separately.
        address1: (point.address_text ?? '').replace(/^.*?\[\d{4}\]\s*/, ''),
        city: point.city,
        zip: point.postcode,
      },
      {
        db: deps.db,
        fetch: deps.geocoder.fetch,
        settings: deps.geocoder.settings,
        mode: 'bulk',
        maxWaitMs: Math.max(0, budgetMs - (now() - started)),
        // 15 s apart: three queries fit in one call; the answers are cached either way.
        maxRequests: 3,
        sleep: deps.geocoder.sleep,
      },
    );
    tried++;
    const unfinished = outcome.reason === 'busy' || outcome.reason === 'provider_error';
    // p_precision null = "not finished": the point goes back to the queue without using a try.
    await call(deps.db, 'courier_point_geocoded', {
      p_id: point.id,
      p_lat: outcome.lat,
      p_lng: outcome.lng,
      p_precision: unfinished ? null : outcome.precision,
    });
    if (unfinished) break;
  }
  return tried;
}

/** Resume every unfinished run, then geocode pending points with the time that is left. */
export async function continueAll(
  deps: SyncJobDeps,
): Promise<{ runs: ProcessedRun[]; geocoded: number }> {
  const now = clock(deps);
  const started = now();
  const pending = await call<SyncRunRow[]>(deps.db, 'courier_sync_resumable');
  const runs = await processRuns(
    pending.map((r) => r.id),
    deps,
  );
  const left = deps.budgetMs - (now() - started);
  const geocoded = left > 0 ? await geocodePendingPoints(deps, left) : 0;
  return { runs, geocoded };
}
