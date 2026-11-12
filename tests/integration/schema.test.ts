/**
 * Runs against a database built from zero by `supabase db reset` (CI does exactly that),
 * and checks that the migrations produced the schema, grants and RLS the brief requires.
 */
import { SETTINGS_DEFAULTS, SHIPMENT_STATUSES } from '@happyhome/core';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testEnv } from '../support/env';
import {
  BUCKETS,
  OWNER_ONLY_TABLES,
  OWNER_WRITE_TABLES,
  PUBLIC_TABLES,
  READ_ONLY_FOR_USERS,
  REALTIME_TABLES,
} from '../support/schema';

let db: pg.Client;

beforeAll(async () => {
  db = new pg.Client({ connectionString: testEnv().dbUrl });
  await db.connect();
});

afterAll(async () => {
  await db?.end();
});

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query(sql, params)).rows as T[];
}

describe('migrations', () => {
  it('applied every file in supabase/migrations, in order', async () => {
    const dir = fileURLToPath(new URL('../../supabase/migrations', import.meta.url));
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .map((f) => f.split('_')[0])
      .sort();
    const applied = await rows<{ version: string }>(
      'select version from supabase_migrations.schema_migrations order by version',
    );
    expect(applied.map((r) => r.version)).toEqual(files);
  });

  it('created exactly the domain tables in public', async () => {
    const tables = await rows<{ table_name: string }>(
      `select table_name from information_schema.tables
       where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`,
    );
    expect(tables.map((t) => t.table_name)).toEqual([...PUBLIC_TABLES]);
  });

  it('gives every table the standard columns', async () => {
    const cols = await rows<{ table_name: string; column_name: string; data_type: string }>(
      `select table_name, column_name, data_type from information_schema.columns
       where table_schema = 'public'
         and column_name in ('id', 'created_at', 'updated_at', 'updated_by', 'version')`,
    );
    for (const table of PUBLIC_TABLES) {
      const got = Object.fromEntries(
        cols.filter((c) => c.table_name === table).map((c) => [c.column_name, c.data_type]),
      );
      expect(got, table).toEqual({
        id: 'uuid',
        created_at: 'timestamp with time zone',
        updated_at: 'timestamp with time zone',
        updated_by: 'uuid',
        version: 'integer',
      });
    }
  });

  it('puts the version/updated_at trigger and the audit trigger on every table except audit_log', async () => {
    const triggers = await rows<{ table_name: string; tgname: string }>(
      `select c.relname as table_name, t.tgname from pg_trigger t
       join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and not t.tgisinternal`,
    );
    for (const table of PUBLIC_TABLES.filter((t) => t !== 'audit_log')) {
      const names = triggers.filter((t) => t.table_name === table).map((t) => t.tgname);
      expect(names, table).toEqual(expect.arrayContaining(['set_row_meta', 'audit_row']));
    }
  });

  it('has the required unique keys and indexes', async () => {
    const indexes = await rows<{ indexdef: string }>(
      `select indexdef from pg_indexes where schemaname = 'public'`,
    );
    const defs = indexes.map((i) => i.indexdef).join('\n');
    expect(defs).toMatch(/UNIQUE INDEX orders_shopify_id_key ON public\.orders .*\(shopify_id\)/);
    expect(defs).toMatch(/ON public\.orders .*\(phone_norm\)/);
    expect(defs).toMatch(/ON public\.orders .*\(email_norm\)/);
    expect(defs).toMatch(/ON public\.orders .*\(created_at_shopify\)/);
    expect(defs).toMatch(
      /UNIQUE INDEX courier_offices_carrier_external_id_key ON public\.courier_offices .*\(carrier, external_id\)/,
    );
    expect(defs).toMatch(/ON public\.courier_offices USING gist \(location\)/);
  });

  it('keeps the shipment status CHECK in sync with packages/core', async () => {
    const [check] = await rows<{ def: string }>(
      `select pg_get_constraintdef(oid) as def from pg_constraint
       where conrelid = 'public.shipments'::regclass and conname = 'shipments_status_check'`,
    );
    const inDb = [...(check?.def ?? '').matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]);
    expect(inDb).toEqual([...SHIPMENT_STATUSES]);
  });

  it('seeds the settings exactly as SETTINGS_DEFAULTS', async () => {
    const settings = await rows<{ key: string; value: unknown }>(
      'select key, value from public.settings',
    );
    expect(Object.fromEntries(settings.map((s) => [s.key, s.value]))).toEqual(SETTINGS_DEFAULTS);
  });
});

describe('grants and row-level security', () => {
  it('enables RLS on every public table', async () => {
    const tables = await rows<{ relname: string; relrowsecurity: boolean }>(
      `select c.relname, c.relrowsecurity from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r'`,
    );
    expect(tables.filter((t) => !t.relrowsecurity).map((t) => t.relname)).toEqual([]);
  });

  it('has at least one policy on every public table', async () => {
    const policies = await rows<{ tablename: string }>(
      `select distinct tablename from pg_policies where schemaname = 'public' order by tablename`,
    );
    expect(policies.map((p) => p.tablename)).toEqual([...PUBLIC_TABLES]);
  });

  it('gives anon no privilege at all on any public table', async () => {
    const granted = await rows<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r'
         and has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')`,
    );
    expect(granted).toEqual([]);
  });

  it('gives authenticated exactly the intended table privileges', async () => {
    const privs = await rows<{
      relname: string;
      sel: boolean;
      ins: boolean;
      upd: boolean;
      del: boolean;
      trunc: boolean;
    }>(
      `select c.relname,
         has_table_privilege('authenticated', c.oid, 'SELECT') as sel,
         has_table_privilege('authenticated', c.oid, 'INSERT') as ins,
         has_table_privilege('authenticated', c.oid, 'UPDATE') as upd,
         has_table_privilege('authenticated', c.oid, 'DELETE') as del,
         has_table_privilege('authenticated', c.oid, 'TRUNCATE') as trunc
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r'`,
    );
    for (const { relname, ...got } of privs) {
      const readOnly = (READ_ONLY_FOR_USERS as readonly string[]).includes(relname);
      expect(got, relname).toEqual({
        sel: true,
        ins: !readOnly,
        upd: !readOnly,
        del: !readOnly,
        trunc: false,
      });
    }
  });

  it('lets service_role read and write every table except audit_log (read only)', async () => {
    const privs = await rows<{ relname: string; sel: boolean; write: boolean }>(
      `select c.relname,
         has_table_privilege('service_role', c.oid, 'SELECT') as sel,
         has_table_privilege('service_role', c.oid, 'INSERT,UPDATE,DELETE') as write
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r'`,
    );
    for (const p of privs) {
      expect(p.sel, p.relname).toBe(true);
      expect(p.write, p.relname).toBe(p.relname !== 'audit_log');
    }
  });

  it('restricts writes on settings, tariffs and members to the owner, and deletes everywhere', async () => {
    const policies = await rows<{
      tablename: string;
      cmd: string;
      qual: string | null;
      with_check: string | null;
    }>(`select tablename, cmd, qual, with_check from pg_policies where schemaname = 'public'`);
    for (const p of policies) {
      const expr = `${p.qual ?? ''} ${p.with_check ?? ''}`;
      if (p.cmd === 'DELETE') expect(expr, `${p.tablename} DELETE`).toContain('is_owner');
      if ((OWNER_WRITE_TABLES as readonly string[]).includes(p.tablename) && p.cmd !== 'SELECT') {
        expect(expr, `${p.tablename} ${p.cmd}`).toContain('is_owner');
      }
    }
  });

  it('lets only the owner read or write import batches (import is owner only)', async () => {
    const policies = await rows<{
      tablename: string;
      cmd: string;
      qual: string | null;
      with_check: string | null;
    }>(
      `select tablename, cmd, qual, with_check from pg_policies
       where schemaname = 'public' and tablename = any($1)`,
      [[...OWNER_ONLY_TABLES]],
    );
    expect(new Set(policies.map((p) => p.cmd))).toEqual(
      new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE']),
    );
    for (const p of policies) {
      expect(`${p.qual ?? ''} ${p.with_check ?? ''}`, `${p.tablename} ${p.cmd}`).toContain(
        'is_owner',
      );
    }
  });

  it('keeps raw CSVs owner only, deletable only once archived, and import_commit for the service role', async () => {
    const policies = await rows<{
      policyname: string;
      cmd: string;
      qual: string | null;
      with_check: string | null;
    }>(
      `select policyname, cmd, qual, with_check from pg_policies
       where schemaname = 'storage' and tablename = 'objects'`,
    );
    for (const p of policies) {
      const expr = `${p.qual ?? ''} ${p.with_check ?? ''}`;
      if (!expr.includes('raw-imports')) continue;
      expect(expr, p.policyname).toContain('is_owner');
      expect(['SELECT', 'DELETE'], p.policyname).toContain(p.cmd);
      if (p.cmd === 'DELETE') expect(expr, p.policyname).toContain("archive_state = 'archived'");
    }
    const [f] = await rows<{ authed: boolean; service: boolean }>(
      `select has_function_privilege('authenticated', 'public.import_commit(uuid, uuid, text, jsonb)', 'EXECUTE') as authed,
              has_function_privilege('service_role', 'public.import_commit(uuid, uuid, text, jsonb)', 'EXECUTE') as service`,
    );
    expect(f).toEqual({ authed: false, service: true });
  });

  it('keeps the helper functions away from anon', async () => {
    const [r] = await rows<{ member: boolean; owner: boolean; authed: boolean }>(
      `select has_function_privilege('anon', 'private.is_member()', 'EXECUTE') as member,
              has_function_privilege('anon', 'private.is_owner()', 'EXECUTE') as owner,
              has_function_privilege('authenticated', 'private.is_member()', 'EXECUTE') as authed`,
    );
    expect(r).toEqual({ member: false, owner: false, authed: true });
  });

  it('does not expose the private schema through the Data API', async () => {
    const [r] = await rows<{ anon_usage: boolean }>(
      `select has_schema_privilege('anon', 'private', 'USAGE') as anon_usage`,
    );
    expect(r?.anon_usage).toBe(false);
  });
});

describe('realtime and storage', () => {
  it('publishes changes for orders, shipments, flags, products (+ sync_probe)', async () => {
    const pub = await rows<{ tablename: string }>(
      `select tablename from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' order by tablename`,
    );
    expect(pub.map((p) => p.tablename)).toEqual([...REALTIME_TABLES]);
  });

  it('has the three storage buckets, all private', async () => {
    const buckets = await rows<{ id: string; public: boolean }>(
      'select id, public from storage.buckets order by id',
    );
    expect(buckets).toEqual(BUCKETS.map((id) => ({ id, public: false })));
  });
});
