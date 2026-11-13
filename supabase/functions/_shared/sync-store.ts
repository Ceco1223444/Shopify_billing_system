/** SyncStore (packages/core/src/couriers/sync.ts) on top of the courier_sync_* RPCs. */
import type { StagedInfo, SupportedCarrier, SyncErrorCode, SyncStore } from './core.ts';
import { call, type Db } from './db.ts';

export function dbSyncStore(db: Db): SyncStore {
  return {
    activeCount: (carrier: SupportedCarrier) =>
      call<number>(db, 'courier_sync_active_count', { p_carrier: carrier }),
    resetStage: async (runId) => {
      await call(db, 'courier_sync_reset_stage', { p_run: runId });
    },
    stage: async (runId, rows) => {
      await call(db, 'courier_sync_stage', { p_run: runId, p_rows: rows });
    },
    markStaged: async (runId, info: StagedInfo) => {
      await call(db, 'courier_sync_mark_staged', { p_run: runId, p_info: info });
    },
    applyBatch: (runId, limit) =>
      call<{ applied: number; remaining: number }>(db, 'courier_sync_apply', {
        p_run: runId,
        p_limit: limit,
      }),
    finish: (runId) => call<{ deactivated: number }>(db, 'courier_sync_finish', { p_run: runId }),
    fail: async (runId, code: SyncErrorCode, message) => {
      await call(db, 'courier_sync_fail', { p_run: runId, p_code: code, p_message: message });
    },
  };
}
