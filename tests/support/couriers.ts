/** Helpers for the Phase 4 tests (courier points, sync, geocoder). */
import pg from 'pg';
import type { Db } from '../../supabase/functions/_shared/db';
import { adminClient, type Client } from './clients';
import { testEnv } from './env';

/** The shared Edge Function code only calls RPCs: hand it the service client. */
export function rpcDb(client: Client = adminClient()): Db {
  return {
    rpc: (fn, args) =>
      client.rpc(fn as never, args as never) as unknown as PromiseLike<{
        data: unknown;
        error: { message: string; code?: string } | null;
      }>,
  };
}

/** A direct database connection (superuser) for set-up, clean-up and checks. */
export async function pgClient(): Promise<pg.Client> {
  const db = new pg.Client({ connectionString: testEnv().dbUrl });
  await db.connect();
  return db;
}

/** Empties the Phase 4 tables. Tests only: the app never deletes courier points. */
export async function resetCourierData(db: pg.Client): Promise<void> {
  await db.query(`
    delete from public.courier_sync_runs;
    delete from public.courier_offices;
    delete from public.geocode_cache;
    update private.rate_slots set next_at = '-infinity';
    delete from private.app_config where key = 'functions_url';
  `);
}

export async function accessToken(client: Client): Promise<string> {
  const { data } = await client.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('not signed in');
  return token;
}

/** POST to a local Edge Function. */
export async function callFunction(
  name: string,
  token: string | null,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const env = testEnv();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    apikey: env.publishableKey,
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${env.url}/functions/v1/${name}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}
