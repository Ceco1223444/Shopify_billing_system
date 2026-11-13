/**
 * Office sync, one carrier per run (P4-13 … P4-16). The work is split into stages that each
 * survive an interruption, so a run can stop at any point (Edge Function time limit, crash)
 * and the next call resumes it:
 *
 *   fetch   ask the adapter for the full list, check it is plausible, stage it in the database
 *   apply   upsert the staged points into courier_offices, a batch per transaction
 *   finish  points of this carrier that were NOT in the list → active = false (never deleted)
 *
 * The database side (courier_sync_* functions) keeps the counters and the stage, so nothing is
 * counted or written twice. A list that is empty or much shorter than what is stored is treated
 * as a broken source: the run fails, the stored points stay as they are (P4-10).
 */
import type { SupportedCarrier } from '../domain.ts';
import type { CourierAdapter } from './adapter.ts';
import { pointProblems, pointToRow } from './points.ts';

export const SYNC_STAGES = ['fetch', 'apply', 'finish', 'done'] as const;
export type SyncStage = (typeof SYNC_STAGES)[number];

export const SYNC_STATUSES = ['running', 'ok', 'failed'] as const;
export type SyncStatus = (typeof SYNC_STATUSES)[number];

/** Why a run failed. The app shows a Bulgarian text for each code. */
export const SYNC_ERROR_CODES = [
  'fetch_failed',
  'parse_failed',
  'too_few_points',
  'mode_not_available',
  'too_many_attempts',
  'error',
] as const;
export type SyncErrorCode = (typeof SYNC_ERROR_CODES)[number];

export interface SyncRunState {
  id: string;
  carrier: SupportedCarrier;
  status: SyncStatus;
  stage: SyncStage;
}

export interface StagedInfo {
  total: number;
  skipped: number;
  invalid: number;
  source: string;
  warnings: string[];
}

/** The database operations a sync needs (implemented with RPCs in the Edge Function). */
export interface SyncStore {
  activeCount(carrier: SupportedCarrier): Promise<number>;
  /** Drop what an interrupted fetch staged, so a re-fetch starts clean. */
  resetStage(runId: string): Promise<void>;
  stage(runId: string, rows: Record<string, unknown>[]): Promise<void>;
  /** All points staged: stage → apply. */
  markStaged(runId: string, info: StagedInfo): Promise<void>;
  /** Upsert the next batch; returns how many are still waiting. */
  applyBatch(runId: string, limit: number): Promise<{ applied: number; remaining: number }>;
  /** Deactivate the points that were not in the list; stage → done, status → ok. */
  finish(runId: string): Promise<{ deactivated: number }>;
  fail(runId: string, code: SyncErrorCode, message: string): Promise<void>;
}

export interface SyncStepOptions {
  /** Stop starting new work after this many ms (the next call resumes). */
  budgetMs: number;
  now?: () => number;
  stageChunk?: number;
  applyBatch?: number;
  /** A list shorter than this share of the active points is treated as broken (0.5). */
  minShare?: number;
}

export type SyncStepOutcome =
  | { state: 'done'; deactivated: number }
  | { state: 'continue'; stage: SyncStage }
  | { state: 'failed'; code: SyncErrorCode; message: string };

/** Smallest number of stored points for which the "much shorter list" check applies. */
export const MIN_POINTS_FOR_SHARE_CHECK = 20;

export async function runSyncStep(
  run: SyncRunState,
  adapter: CourierAdapter,
  store: SyncStore,
  options: SyncStepOptions,
): Promise<SyncStepOutcome> {
  const now = options.now ?? (() => Date.now());
  const started = now();
  const outOfTime = () => now() - started >= options.budgetMs;
  const stageChunk = options.stageChunk ?? 500;
  const applyBatch = options.applyBatch ?? 300;
  const minShare = options.minShare ?? 0.5;

  const failRun = async (code: SyncErrorCode, message: string): Promise<SyncStepOutcome> => {
    await store.fail(run.id, code, message);
    return { state: 'failed', code, message };
  };

  if (run.status !== 'running' || run.stage === 'done') return { state: 'done', deactivated: 0 };
  let stage: SyncStage = run.stage;

  if (stage === 'fetch') {
    const list = await adapter.listOffices();
    if (!list.ok) {
      const code: SyncErrorCode =
        list.error.code === 'parse_failed'
          ? 'parse_failed'
          : list.error.code === 'mode_not_available'
            ? 'mode_not_available'
            : 'fetch_failed';
      return failRun(code, list.error.message);
    }
    const valid = list.value.points.filter(
      (p) => p.carrier === run.carrier && pointProblems(p).length === 0,
    );
    const invalid = list.value.points.length - valid.length;
    const active = await store.activeCount(run.carrier);
    if (
      valid.length === 0 ||
      (active >= MIN_POINTS_FOR_SHARE_CHECK && valid.length < active * minShare)
    ) {
      return failRun(
        'too_few_points',
        `The list has ${valid.length} usable points; ${active} are active now. Nothing was changed.`,
      );
    }
    await store.resetStage(run.id);
    for (let i = 0; i < valid.length; i += stageChunk) {
      await store.stage(run.id, valid.slice(i, i + stageChunk).map(pointToRow));
    }
    await store.markStaged(run.id, {
      total: valid.length,
      skipped: list.value.skipped,
      invalid,
      source: list.value.source,
      warnings: list.value.warnings,
    });
    stage = 'apply';
    if (outOfTime()) return { state: 'continue', stage };
  }

  if (stage === 'apply') {
    for (;;) {
      const { remaining } = await store.applyBatch(run.id, applyBatch);
      if (remaining === 0) break;
      if (outOfTime()) return { state: 'continue', stage };
    }
  }

  // stage 'finish' (or 'apply' just completed)

  const { deactivated } = await store.finish(run.id);
  return { state: 'done', deactivated };
}
