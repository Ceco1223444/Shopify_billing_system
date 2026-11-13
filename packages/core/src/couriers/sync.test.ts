/**
 * runSyncStep with the MockAdapter and an in-memory store: the stages, the "broken list" guard
 * (P4-10), the time budget and resuming (P4-16). The real database side is tested against
 * Postgres in tests/integration/courier-sync.test.ts (T4-01, T4-05, T4-07).
 */
import { describe, expect, it } from 'vitest';
import { can, notAvailableYet, notSupportedInManualMode } from './adapter.ts';
import { MockAdapter, mockPoint } from './mock.ts';
import type { CourierPoint } from './points.ts';
import { runSyncStep, type SyncRunState, type SyncStore } from './sync.ts';

class MemoryStore implements SyncStore {
  offices = new Map<string, { active: boolean; row: Record<string, unknown> }>();
  staged = new Map<string, { row: Record<string, unknown>; applied: boolean }>();
  run: SyncRunState;
  failed: { code: string; message: string } | null = null;
  applyCalls = 0;

  constructor(run: SyncRunState) {
    this.run = run;
  }
  async activeCount() {
    return [...this.offices.values()].filter((o) => o.active).length;
  }
  async resetStage() {
    this.staged.clear();
  }
  async stage(_runId: string, rows: Record<string, unknown>[]) {
    for (const row of rows) this.staged.set(String(row.external_id), { row, applied: false });
  }
  async markStaged() {
    this.run = { ...this.run, stage: 'apply' };
  }
  async applyBatch(_runId: string, limit: number) {
    this.applyCalls++;
    const todo = [...this.staged.entries()].filter(([, s]) => !s.applied).slice(0, limit);
    for (const [id, s] of todo) {
      this.offices.set(id, { active: true, row: s.row });
      s.applied = true;
    }
    const remaining = [...this.staged.values()].filter((s) => !s.applied).length;
    if (!remaining) this.run = { ...this.run, stage: 'finish' };
    return { applied: todo.length, remaining };
  }
  async finish() {
    let deactivated = 0;
    for (const [id, o] of this.offices) {
      if (o.active && !this.staged.has(id)) {
        o.active = false;
        deactivated++;
      }
    }
    this.run = { ...this.run, stage: 'done', status: 'ok' };
    return { deactivated };
  }
  async fail(_runId: string, code: string, message: string) {
    this.failed = { code, message };
    this.run = { ...this.run, status: 'failed' };
  }
}

const points = (n: number, prefix = 'e'): CourierPoint[] =>
  Array.from({ length: n }, (_, i) => mockPoint('econt', `${prefix}${String(i).padStart(3, '0')}`));

const newRun = (): SyncRunState => ({
  id: 'run-1',
  carrier: 'econt',
  status: 'running',
  stage: 'fetch',
});

describe('runSyncStep', () => {
  it('fetches, stages, applies and finishes in one step when there is time', async () => {
    const store = new MemoryStore(newRun());
    store.offices.set('gone', { active: true, row: {} });
    const adapter = new MockAdapter({ carrier: 'econt', points: points(7) });
    const out = await runSyncStep(store.run, adapter, store, { budgetMs: 60_000, applyBatch: 3 });
    expect(out).toEqual({ state: 'done', deactivated: 1 });
    expect(store.applyCalls).toBe(3);
    expect(store.offices.get('gone')?.active).toBe(false);
    expect(store.offices.has('gone')).toBe(true); // deactivated, never deleted
    expect([...store.offices.values()].filter((o) => o.active)).toHaveLength(7);
    expect(adapter.calls.listOffices).toBe(1);
  });

  it('stops when the budget is used up and the next step resumes without fetching again', async () => {
    const store = new MemoryStore(newRun());
    const adapter = new MockAdapter({ carrier: 'econt', points: points(10) });
    let t = 0;
    const now = () => (t += 1000); // every call to now() is one second later
    const first = await runSyncStep(store.run, adapter, store, {
      budgetMs: 2500,
      applyBatch: 2,
      now,
    });
    expect(first).toEqual({ state: 'continue', stage: 'apply' });
    const appliedSoFar = [...store.staged.values()].filter((s) => s.applied).length;
    expect(appliedSoFar).toBeGreaterThan(0);
    expect(appliedSoFar).toBeLessThan(10);

    const second = await runSyncStep(store.run, adapter, store, {
      budgetMs: 60_000,
      applyBatch: 2,
    });
    expect(second.state).toBe('done');
    expect(adapter.calls.listOffices).toBe(1);
    expect(store.offices.size).toBe(10);
  });

  it('fails without touching anything when the adapter fails', async () => {
    const store = new MemoryStore(newRun());
    store.offices.set('a', { active: true, row: {} });
    const adapter = new MockAdapter({
      carrier: 'econt',
      listError: { code: 'parse_failed', message: 'page changed' },
    });
    const out = await runSyncStep(store.run, adapter, store, { budgetMs: 60_000 });
    expect(out).toEqual({ state: 'failed', code: 'parse_failed', message: 'page changed' });
    expect(store.offices.get('a')?.active).toBe(true);
    expect(store.staged.size).toBe(0);
  });

  it('maps other adapter errors to fetch_failed / mode_not_available', async () => {
    const http = new MockAdapter({
      carrier: 'econt',
      listError: { code: 'http_error', message: '503' },
    });
    expect(
      (await runSyncStep(newRun(), http, new MemoryStore(newRun()), { budgetMs: 1000 })).state,
    ).toBe('failed');
    const store = new MemoryStore(newRun());
    const mode = new MockAdapter({
      carrier: 'econt',
      listError: { code: 'mode_not_available', message: 'x' },
    });
    await runSyncStep(store.run, mode, store, { budgetMs: 1000 });
    expect(store.failed?.code).toBe('mode_not_available');
  });

  it('P4-10: a much shorter list than what is stored is treated as broken', async () => {
    const store = new MemoryStore(newRun());
    for (let i = 0; i < 40; i++) store.offices.set(`old${i}`, { active: true, row: {} });
    const adapter = new MockAdapter({ carrier: 'econt', points: points(10) });
    const out = await runSyncStep(store.run, adapter, store, { budgetMs: 60_000 });
    expect(out.state).toBe('failed');
    expect(store.failed?.code).toBe('too_few_points');
    expect([...store.offices.values()].every((o) => o.active)).toBe(true);
  });

  it('an empty list never deactivates anything', async () => {
    const store = new MemoryStore(newRun());
    store.offices.set('a', { active: true, row: {} });
    const out = await runSyncStep(
      store.run,
      new MockAdapter({ carrier: 'econt', points: [] }),
      store,
      {
        budgetMs: 60_000,
      },
    );
    expect(out.state).toBe('failed');
    expect(store.offices.get('a')?.active).toBe(true);
  });

  it('drops invalid points and points of the other carrier', async () => {
    const store = new MemoryStore(newRun());
    const list = [
      ...points(3),
      mockPoint('econt', 'far', { lat: 48.85, lng: 2.35 }), // Paris
      mockPoint('speedy', 's1'),
      mockPoint('econt', ' ', {}),
    ];
    await runSyncStep(store.run, new MockAdapter({ carrier: 'econt', points: list }), store, {
      budgetMs: 60_000,
    });
    expect([...store.offices.keys()].sort()).toEqual(['e000', 'e001', 'e002']);
  });

  it('does nothing for a run that is already finished', async () => {
    const store = new MemoryStore({ ...newRun(), status: 'ok', stage: 'done' });
    const adapter = new MockAdapter({ carrier: 'econt', points: points(2) });
    expect(await runSyncStep(store.run, adapter, store, { budgetMs: 1000 })).toEqual({
      state: 'done',
      deactivated: 0,
    });
    expect(adapter.calls.listOffices).toBe(0);
  });
});

describe('adapter helpers', () => {
  it('can() reads the capability list', () => {
    const adapter = new MockAdapter({
      carrier: 'speedy',
      capabilities: ['listOffices', 'calculate'],
    });
    expect(can(adapter, 'listOffices')).toBe(true);
    expect(can(adapter, 'createShipment')).toBe(false);
  });

  it('not supported / not yet results carry a code the app can translate', () => {
    expect(notSupportedInManualMode('createShipment')).toEqual({
      ok: false,
      error: {
        code: 'not_supported_in_manual_mode',
        message: 'createShipment is not supported in manual mode',
      },
    });
    const later = notAvailableYet('track', 11);
    expect(later.ok).toBe(false);
    if (!later.ok) expect(later.error).toMatchObject({ code: 'not_available_yet', phase: 11 });
  });

  it('the mock adapter answers waybill methods with "Phase 9"', async () => {
    const adapter = new MockAdapter({ carrier: 'econt' });
    const res = await adapter.createShipment();
    expect(res.ok).toBe(false);
    expect(adapter.calls.createShipment).toBe(1);
  });
});
