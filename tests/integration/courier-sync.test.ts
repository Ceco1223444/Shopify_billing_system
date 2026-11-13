/**
 * Office sync against the real database (Phase 4).
 *   T4-01 new / changed / missing points → inserted / updated / deactivated, never deleted
 *   T4-05 a broken Speedy page keeps the stored points (the banner reads the failed run)
 *   T4-07 an interrupted sync resumes, without duplicates or double counting
 * Plus: the lease, the attempt limit, the courier-sync Edge Function's callers, and pg_cron.
 */
import { MockAdapter, mockPoint, ok, type CourierPoint } from '@happyhome/core/couriers';
import { readFileSync } from 'node:fs';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SpeedyManualAdapter } from '../../supabase/functions/_shared/couriers/speedy-manual-adapter';
import {
  continueAll,
  MAX_RUN_ATTEMPTS,
  processRun,
  startRuns,
  type SyncJobDeps,
} from '../../supabase/functions/_shared/courier-sync';
import { adminClient, anonClient, signedInClient } from '../support/clients';
import { accessToken, callFunction, pgClient, resetCourierData, rpcDb } from '../support/couriers';
import { testEnv } from '../support/env';
import { TEST_USERS } from '../support/users';

let db: pg.Client;
const rpc = rpcDb(adminClient());

beforeAll(async () => {
  db = await pgClient();
});
afterAll(async () => {
  await resetCourierData(db);
  await db.end();
});
beforeEach(async () => {
  await resetCourierData(db);
});

function deps(
  adapter: MockAdapter | SpeedyManualAdapter,
  over: Partial<SyncJobDeps> = {},
): SyncJobDeps {
  return {
    db: rpc,
    adapterFor: async () => ok(adapter),
    budgetMs: 60_000,
    leaseSeconds: 60,
    geocoder: null,
    ...over,
  };
}

async function sync(
  carrier: 'econt' | 'speedy',
  adapter: MockAdapter | SpeedyManualAdapter,
  over: Partial<SyncJobDeps> = {},
) {
  const d = deps(adapter, over);
  const [run] = await startRuns([carrier], 'test', null, d);
  const processed = await processRun(run!.id, d, d.budgetMs);
  return { runId: run!.id, processed };
}

async function runRow(id: string) {
  const { rows } = await db.query('select * from public.courier_sync_runs where id = $1', [id]);
  return rows[0];
}

async function offices(carrier: string) {
  const { rows } = await db.query(
    `select external_id, name_bg, active, deactivated_at, lat, lng, coord_source, geocode_status, address_text
     from public.courier_offices where carrier = $1 order by external_id`,
    [carrier],
  );
  return rows as {
    external_id: string;
    name_bg: string;
    active: boolean;
    deactivated_at: Date | null;
    lat: number | null;
    lng: number | null;
    coord_source: string | null;
    geocode_status: string;
    address_text: string;
  }[];
}

const econt = (...ids: string[]): CourierPoint[] => ids.map((id) => mockPoint('econt', id));

describe('T4-01: new, changed and missing points', () => {
  it('inserts, updates, deactivates (never deletes) and reactivates', async () => {
    const first = await sync(
      'econt',
      new MockAdapter({ carrier: 'econt', points: econt('A', 'B', 'C') }),
    );
    expect(first.processed?.outcome).toEqual({ state: 'done', deactivated: 0 });
    expect(await runRow(first.runId)).toMatchObject({
      status: 'ok',
      stage: 'done',
      inserted: 3,
      fetched: 3,
    });

    const changed = [
      mockPoint('econt', 'A'),
      mockPoint('econt', 'B', { nameBg: 'Нов адрес Б', addressText: 'ул. Нова 1' }),
      mockPoint('econt', 'D'),
    ];
    const second = await sync('econt', new MockAdapter({ carrier: 'econt', points: changed }));
    expect(await runRow(second.runId)).toMatchObject({
      status: 'ok',
      inserted: 1,
      updated: 1,
      unchanged: 1,
      reactivated: 0,
      deactivated: 1,
    });
    let rows = await offices('econt');
    expect(rows.map((r) => [r.external_id, r.active])).toEqual([
      ['A', true],
      ['B', true],
      ['C', false],
      ['D', true],
    ]);
    expect(rows.find((r) => r.external_id === 'B')?.name_bg).toBe('Нов адрес Б');
    expect(rows.find((r) => r.external_id === 'C')?.deactivated_at).not.toBeNull();

    const third = await sync(
      'econt',
      new MockAdapter({ carrier: 'econt', points: econt('A', 'B', 'C', 'D') }),
    );
    expect(await runRow(third.runId)).toMatchObject({ reactivated: 1, updated: 1, deactivated: 0 });
    rows = await offices('econt');
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.active && r.deactivated_at === null)).toBe(true);
  });

  it('a sync of one carrier never touches the other carrier', async () => {
    await sync(
      'speedy',
      new MockAdapter({ carrier: 'speedy', points: [mockPoint('speedy', 'S1')] }),
    );
    await sync('econt', new MockAdapter({ carrier: 'econt', points: econt('A') }));
    expect((await offices('speedy')).map((r) => r.active)).toEqual([true]);
  });

  it('coordinates: the courier’s always win, a list without them keeps the stored ones', async () => {
    await sync('econt', new MockAdapter({ carrier: 'econt', points: econt('A') }));
    const noCoords = mockPoint('econt', 'A', {
      lat: null,
      lng: null,
      coordConfidence: null,
      coordSource: null,
    });
    const fresh = mockPoint('econt', 'N', {
      lat: null,
      lng: null,
      coordConfidence: null,
      coordSource: null,
    });
    await sync('econt', new MockAdapter({ carrier: 'econt', points: [noCoords, fresh] }));
    const rows = await offices('econt');
    expect(rows.find((r) => r.external_id === 'A')).toMatchObject({
      lat: 42.1354,
      coord_source: 'courier',
      geocode_status: 'none',
    });
    expect(rows.find((r) => r.external_id === 'N')).toMatchObject({
      lat: null,
      geocode_status: 'pending',
    });

    // The courier moved the office and gave no coordinates: geocode it again.
    const moved = mockPoint('econt', 'A', { lat: null, lng: null, addressText: 'ул. Друга 5' });
    await sync('econt', new MockAdapter({ carrier: 'econt', points: [moved, fresh] }));
    expect((await offices('econt')).find((r) => r.external_id === 'A')?.geocode_status).toBe(
      'pending',
    );
  });

  it('the location column follows lat/lng (PostGIS)', async () => {
    await sync('econt', new MockAdapter({ carrier: 'econt', points: econt('A') }));
    const { rows } = await db.query(
      `select extensions.st_y(location::extensions.geometry) as lat,
              extensions.st_x(location::extensions.geometry) as lng
       from public.courier_offices where external_id = 'A'`,
    );
    expect(rows[0]).toEqual({ lat: 42.1354, lng: 24.7453 });
  });
});

describe('T4-05: a broken Speedy page keeps the stored data', () => {
  const page = (name: string) =>
    readFileSync(new URL(`../../packages/core/test/fixtures/${name}`, import.meta.url), 'utf8');
  const speedy = (list: string) =>
    new SpeedyManualAdapter({
      fetch: (async (input: RequestInfo | URL) =>
        new Response(
          String(input).includes('offices_list.php') ? list : page('speedy-officesmap.html'),
        )) as typeof fetch,
      findTariff: async () => null,
    });

  it('a changed page fails the run with parse_failed; every stored point stays active', async () => {
    const good = await sync('speedy', speedy(page('speedy-offices-list.html')));
    expect(await runRow(good.runId)).toMatchObject({ status: 'ok', inserted: 124 });

    const broken = await sync('speedy', speedy('<html><body>Офисите са преместени</body></html>'));
    expect(broken.processed?.outcome).toMatchObject({ state: 'failed', code: 'parse_failed' });
    expect(await runRow(broken.runId)).toMatchObject({
      status: 'failed',
      error_code: 'parse_failed',
    });
    const rows = await offices('speedy');
    expect(rows).toHaveLength(124);
    expect(rows.every((r) => r.active)).toBe(true);
    const { rows: staged } = await db.query(
      'select count(*)::int as n from private.courier_sync_items',
    );
    expect(staged[0].n).toBe(0);
  });

  it('a list much shorter than what is stored is refused (too_few_points)', async () => {
    await sync('speedy', speedy(page('speedy-offices-list.html')));
    const few = Array.from({ length: 10 }, (_, i) => mockPoint('speedy', `X${i}`));
    const out = await sync('speedy', new MockAdapter({ carrier: 'speedy', points: few }));
    expect(out.processed?.outcome).toMatchObject({ state: 'failed', code: 'too_few_points' });
    expect((await offices('speedy')).filter((r) => r.active)).toHaveLength(124);
  });

  it('the Speedy points have coordinates from the map page; the one missing is pending', async () => {
    await sync('speedy', speedy(page('speedy-offices-list.html')));
    const rows = await offices('speedy');
    expect(rows.filter((r) => r.coord_source === 'speedy_map')).toHaveLength(123);
    expect(rows.filter((r) => r.geocode_status === 'pending')).toHaveLength(1);
  });
});

describe('T4-07: an interrupted sync resumes', () => {
  const fifty = Array.from({ length: 50 }, (_, i) =>
    mockPoint('econt', `P${String(i).padStart(2, '0')}`),
  );

  it('stops after the time budget, a crashed call is resumed after its lease, nothing twice', async () => {
    const adapter = new MockAdapter({ carrier: 'econt', points: fifty });
    let t = 0;
    const d = deps(adapter, { batchSize: 10, budgetMs: 2500, now: () => (t += 1000) });
    const [run] = await startRuns(['econt'], 'test', null, d);
    const first = await processRun(run!.id, d, d.budgetMs);
    expect(first?.outcome).toEqual({ state: 'continue', stage: 'apply' });
    const partial = await runRow(run!.id);
    expect(partial.status).toBe('running');
    expect(partial.inserted).toBeGreaterThan(0);
    expect(partial.inserted).toBeLessThan(50);

    // A call that crashed while holding the run: nobody else may take it until the lease ends.
    await db.query(
      `update public.courier_sync_runs set lease_until = now() + interval '1 hour' where id = $1`,
      [run!.id],
    );
    expect((await continueAll(deps(adapter))).runs).toEqual([]);
    await db.query(
      `update public.courier_sync_runs set lease_until = now() - interval '1 second' where id = $1`,
      [run!.id],
    );

    const resumed = await continueAll(deps(adapter, { batchSize: 10 }));
    expect(resumed.runs.map((r) => r.outcome)).toEqual([{ state: 'done', deactivated: 0 }]);
    expect(adapter.calls.listOffices).toBe(1); // the list was fetched once
    expect(await runRow(run!.id)).toMatchObject({
      status: 'ok',
      inserted: 50,
      updated: 0,
      unchanged: 0,
    });
    const { rows } = await db.query(
      `select count(*)::int as n, count(distinct external_id)::int as ids from public.courier_offices`,
    );
    expect(rows[0]).toEqual({ n: 50, ids: 50 });
  });

  it('a fetch interrupted while staging starts clean: stale staged points are not applied', async () => {
    const d = deps(new MockAdapter({ carrier: 'econt', points: econt('A', 'B') }));
    const [run] = await startRuns(['econt'], 'test', null, d);
    // What an earlier, interrupted call had staged (including a point that no longer exists).
    await rpc.rpc('courier_sync_stage', {
      p_run: run!.id,
      p_rows: [
        { carrier: 'econt', external_id: 'A', type: 'office', name_bg: 'A' },
        { carrier: 'econt', external_id: 'STALE', type: 'office', name_bg: 'Stale' },
      ],
    });
    await processRun(run!.id, d, d.budgetMs);
    expect((await offices('econt')).map((r) => r.external_id)).toEqual(['A', 'B']);
  });

  it('one run per carrier at a time; a run is leased to one call', async () => {
    const d = deps(new MockAdapter({ carrier: 'econt', points: econt('A') }));
    const [a] = await startRuns(['econt'], 'test', null, d);
    const [b] = await startRuns(['econt'], 'manual', null, d);
    expect(b!.id).toBe(a!.id);
    const { data: first } = await adminClient().rpc('courier_sync_claim', {
      p_run: a!.id,
      p_seconds: 60,
    });
    const { data: second } = await adminClient().rpc('courier_sync_claim', {
      p_run: a!.id,
      p_seconds: 60,
    });
    const idOf = (row: unknown) => (row as { id?: string | null } | null)?.id ?? null;
    expect(idOf(first)).toBe(a!.id);
    expect(idOf(second)).toBeNull();
  });

  it(`gives up after ${MAX_RUN_ATTEMPTS} attempts (data kept)`, async () => {
    const d = deps(new MockAdapter({ carrier: 'econt', points: econt('A') }));
    const [run] = await startRuns(['econt'], 'test', null, d);
    await db.query('update public.courier_sync_runs set attempts = $2 where id = $1', [
      run!.id,
      MAX_RUN_ATTEMPTS,
    ]);
    const out = await processRun(run!.id, d, d.budgetMs);
    expect(out?.outcome).toMatchObject({ state: 'failed', code: 'too_many_attempts' });
  });
});

describe('courier-sync Edge Function', () => {
  const env = testEnv();
  const mock = { econt: [mockPoint('econt', 'HTTP1'), mockPoint('econt', 'HTTP2')] };

  it('the service key may sync mock points on the local stack', async () => {
    const res = await callFunction('courier-sync', env.secretKey, {
      action: 'start',
      carriers: ['econt'],
      wait: true,
      trigger: 'test',
      mock,
    });
    expect(res.status).toBe(200);
    expect(res.json.runs).toEqual([
      expect.objectContaining({ carrier: 'econt', outcome: { state: 'done', deactivated: 0 } }),
    ]);
    expect((await offices('econt')).map((r) => r.external_id)).toEqual(['HTTP1', 'HTTP2']);
    const { rows } = await db.query(
      `select value from private.app_config where key = 'functions_url'`,
    );
    expect(rows).toEqual([]); // pg_cron stays off on the local stack
  });

  it('signed out → 401, packer → 403, owner cannot use mock data, junk → 400', async () => {
    expect((await callFunction('courier-sync', null, { action: 'start' })).status).toBe(401);
    expect(
      (await callFunction('courier-sync', env.publishableKey, { action: 'start' })).status,
    ).toBe(401);
    const packer = await signedInClient(TEST_USERS.packer.email, TEST_USERS.packer.password);
    const asPacker = await callFunction('courier-sync', await accessToken(packer), {
      action: 'start',
    });
    expect(asPacker).toMatchObject({ status: 403, json: { error: 'owner_only' } });
    const owner = await signedInClient(TEST_USERS.owner.email, TEST_USERS.owner.password);
    const ownerToken = await accessToken(owner);
    const ownerMock = await callFunction('courier-sync', ownerToken, { action: 'start', mock });
    expect(ownerMock).toMatchObject({ status: 403, json: { error: 'mock_not_allowed' } });
    expect((await callFunction('courier-sync', ownerToken, { action: 'dance' })).status).toBe(400);
    expect((await callFunction('courier-sync', ownerToken, { carriers: ['boxnow'] })).status).toBe(
      400,
    );
    expect(await offices('econt')).toEqual([]);
  });

  it('members can read runs; nobody signed in can write them or call the sync RPCs', async () => {
    const owner = await signedInClient(TEST_USERS.owner.email, TEST_USERS.owner.password);
    const { error: insertError } = await owner
      .from('courier_sync_runs')
      .insert({ carrier: 'econt', trigger: 'manual' });
    expect(insertError).not.toBeNull();
    const { error: rpcError } = await owner.rpc('courier_sync_start', {
      p_carrier: 'econt',
      p_trigger: 'manual',
      p_actor: null as unknown as string,
    });
    expect(rpcError?.code).toBe('42501');
    const { error: anonError } = await anonClient().from('courier_sync_runs').select('id');
    expect(anonError?.code).toBe('42501');
  });
});

describe('pg_cron schedule (P4-13)', () => {
  it('runs the tick every 5 minutes', async () => {
    const { rows } = await db.query(
      `select schedule, command from cron.job where jobname = 'courier-sync-tick'`,
    );
    expect(rows).toEqual([
      { schedule: '*/5 * * * *', command: 'select private.courier_sync_tick()' },
    ]);
  });

  async function due(at: string): Promise<string[]> {
    const { rows } = await db.query('select private.courier_sync_due($1::timestamptz) as due', [
      at,
    ]);
    return rows[0].due;
  }
  async function addRun(carrier: string, status: string, startedAt: string) {
    await db.query(
      `insert into public.courier_sync_runs (carrier, trigger, status, stage, started_at, finished_at)
       values ($1, 'cron', $2, 'done', $3::timestamptz, $3::timestamptz)`,
      [carrier, status, startedAt],
    );
  }

  it('Econt daily from 03:00 Europe/Sofia, in winter and in summer time', async () => {
    expect(await due('2026-11-16 00:59:00+00')).toEqual([]); // 02:59 Sofia
    expect(await due('2026-11-16 01:00:00+00')).toEqual(['econt', 'speedy']); // 03:00 EET
    expect(await due('2026-07-16 00:00:00+00')).toEqual(['econt', 'speedy']); // 03:00 EEST
    expect(await due('2026-11-16 04:00:00+00')).toEqual([]); // 06:00: window closed
  });

  it('not again the same night after a success; a failure is retried after 30 minutes', async () => {
    await addRun('econt', 'ok', '2026-11-16 01:05:00+00');
    expect(await due('2026-11-16 02:00:00+00')).not.toContain('econt');
    expect(await due('2026-11-17 01:00:00+00')).toContain('econt'); // next night

    await db.query('delete from public.courier_sync_runs');
    await addRun('econt', 'failed', '2026-11-16 01:00:00+00');
    expect(await due('2026-11-16 01:20:00+00')).not.toContain('econt');
    expect(await due('2026-11-16 01:31:00+00')).toContain('econt');
  });

  it('Speedy weekly', async () => {
    await addRun('speedy', 'ok', '2026-11-12 01:00:00+00');
    expect(await due('2026-11-16 01:00:00+00')).not.toContain('speedy'); // 4 days later
    expect(await due('2026-11-19 01:00:00+00')).toContain('speedy'); // 7 days later
  });

  it('the tick does nothing until the hosted function URL is known, then resumes stopped runs', async () => {
    const tick = async () => (await db.query('select private.courier_sync_tick() as r')).rows[0].r;
    expect(await tick()).toBe('not_configured');
    await db.query(
      `insert into private.app_config (key, value) values ('functions_url', 'http://127.0.0.1:9/functions/v1')`,
    );
    const nowHourSofia = Number(
      (await db.query(`select extract(hour from now() at time zone 'Europe/Sofia') as h`)).rows[0]
        .h,
    );
    if (nowHourSofia < 3 || nowHourSofia > 5) {
      expect(await tick()).toBe('idle');
      await db.query(
        `insert into public.courier_sync_runs (carrier, trigger, status, stage, lease_until)
         values ('econt', 'cron', 'running', 'apply', now() - interval '1 minute')`,
      );
      expect(await tick()).toBe('continue');
    }
  });
});
