/**
 * Grants + RLS through the real Data API, as each kind of user:
 *   anon      signed-out visitor with the public key
 *   outsider  has a login but is not a member of the shop
 *   packer    member, role packer
 *   owner     member, role owner
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { adminClient, anonClient, signedInClient, type Client } from '../support/clients';
import { PUBLIC_TABLES, uniq } from '../support/schema';
import { ensureTestUsers, TEST_USERS, type TestUserName } from '../support/users';

let ids: Record<TestUserName, string>;
let admin: Client;
let anon: Client;
let outsider: Client;
let packer: Client;
let owner: Client;

beforeAll(async () => {
  ids = await ensureTestUsers();
  admin = adminClient();
  anon = anonClient();
  outsider = await signedInClient(TEST_USERS.outsider.email, TEST_USERS.outsider.password);
  packer = await signedInClient(TEST_USERS.packer.email, TEST_USERS.packer.password);
  owner = await signedInClient(TEST_USERS.owner.email, TEST_USERS.owner.password);
});

async function settingValue(key: string) {
  const { data, error } = await admin.from('settings').select('value').eq('key', key).single();
  if (error) throw error;
  return data.value;
}

describe('anonymous visitor gets nothing', () => {
  it.each(PUBLIC_TABLES)('cannot read %s', async (table) => {
    const { data, error } = await anon.from(table).select('*').limit(1);
    expect(data).toBeNull();
    expect(error?.code).toBe('42501'); // permission denied: no GRANT to anon
  });

  it('cannot write settings', async () => {
    const { error } = await anon.from('settings').insert({ key: 'anon_test', value: 1 });
    expect(error?.code).toBe('42501');
  });

  it('cannot list or download files', async () => {
    const { data: list } = await anon.storage.from('product-photos').list();
    expect(list ?? []).toEqual([]);
    const { data: file } = await anon.storage.from('labels').download('anything.pdf');
    expect(file).toBeNull();
  });
});

describe('signed-in user who is not a member gets nothing', () => {
  it.each(PUBLIC_TABLES.filter((t) => t !== 'members'))('sees no rows in %s', async (table) => {
    const { data, error } = await outsider.from(table).select('*').limit(5);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it('sees only their own (missing) member row', async () => {
    const { data } = await outsider.from('members').select('user_id');
    expect(data).toEqual([]);
  });

  it('cannot insert shop data', async () => {
    const { error } = await outsider.from('products').insert({ name: 'x', sku: uniq('OUT') });
    expect(error?.code).toBe('42501'); // new row violates row-level security policy
  });
});

describe('packer', () => {
  it('reads all settings', async () => {
    const { data, error } = await packer.from('settings').select('key');
    expect(error).toBeNull();
    expect(data?.length).toBe(14);
  });

  it('cannot change a setting', async () => {
    const before = await settingValue('office_range_km');
    const { data, error } = await packer
      .from('settings')
      .update({ value: 999 })
      .eq('key', 'office_range_km')
      .select();
    expect(error).toBeNull();
    expect(data).toEqual([]); // RLS hides the row from UPDATE: nothing changed
    expect(await settingValue('office_range_km')).toEqual(before);
  });

  it('cannot add or delete a setting', async () => {
    const { error: insertError } = await packer
      .from('settings')
      .insert({ key: 'packer_test', value: 1 });
    expect(insertError?.code).toBe('42501');

    const { data: deleted } = await packer
      .from('settings')
      .delete()
      .eq('key', 'office_range_km')
      .select();
    expect(deleted).toEqual([]);
    expect(await settingValue('office_range_km')).toEqual(5);
  });

  it('cannot write tariffs', async () => {
    const { error } = await packer.from('tariffs').insert({
      carrier: 'speedy',
      delivery_type: 'office',
      max_weight_g: 3000,
      price_cents: 269,
      valid_from: '2026-11-11',
      source: 'test',
    });
    expect(error?.code).toBe('42501');
  });

  it('cannot make themselves owner', async () => {
    const { data } = await packer
      .from('members')
      .update({ role: 'owner' })
      .eq('user_id', ids.packer)
      .select();
    expect(data).toEqual([]);
    const { data: row } = await admin
      .from('members')
      .select('role')
      .eq('user_id', ids.packer)
      .single();
    expect(row?.role).toBe('packer');
  });

  it('can see the other members (for presence names)', async () => {
    const { data } = await packer.from('members').select('display_name');
    expect(data?.map((m) => m.display_name)).toEqual(
      expect.arrayContaining([TEST_USERS.owner.displayName, TEST_USERS.packer.displayName]),
    );
  });

  it('can add and edit a product but not delete it; the owner can', async () => {
    const sku = uniq('PACK');
    const { data: created, error } = await packer
      .from('products')
      .insert({ sku, name: 'Спален комплект' })
      .select()
      .single();
    expect(error).toBeNull();
    expect(created?.version).toBe(1);
    expect(created?.updated_by).toBe(ids.packer);

    const { data: edited } = await packer
      .from('products')
      .update({ name: 'Спален комплект – сив' })
      .eq('id', created!.id)
      .select()
      .single();
    expect(edited?.version).toBe(2);

    const { data: notDeleted } = await packer
      .from('products')
      .delete()
      .eq('id', created!.id)
      .select();
    expect(notDeleted).toEqual([]);

    const { data: deleted } = await owner.from('products').delete().eq('id', created!.id).select();
    expect(deleted).toHaveLength(1);
  });

  it('cannot write the audit log or courier offices directly', async () => {
    const { error: auditError } = await packer
      .from('audit_log')
      .insert({ table_name: 'orders', action: 'insert' });
    expect(auditError?.code).toBe('42501');

    const { error: officeError } = await packer.from('courier_offices').insert({
      carrier: 'econt',
      external_id: uniq('X'),
      kind: 'office',
      name: 'Invented office',
      source: 'test',
    });
    expect(officeError?.code).toBe('42501');
  });
});

describe('owner', () => {
  it('can change a setting; version, updated_by and the audit log follow', async () => {
    const { data: before } = await owner
      .from('settings')
      .select()
      .eq('key', 'duplicate_window_hours')
      .single();
    try {
      const { data: after, error } = await owner
        .from('settings')
        .update({ value: 72 })
        .eq('key', 'duplicate_window_hours')
        .select()
        .single();
      expect(error).toBeNull();
      expect(after?.value).toBe(72);
      expect(after?.version).toBe(before!.version + 1);
      expect(after?.updated_by).toBe(ids.owner);

      const { data: audit } = await owner
        .from('audit_log')
        .select('actor, action, before, after')
        .eq('table_name', 'settings')
        .eq('row_id', before!.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();
      expect(audit).toMatchObject({
        actor: ids.owner,
        action: 'update',
        before: { value: before!.value },
        after: { value: 72 },
      });
    } finally {
      await owner
        .from('settings')
        .update({ value: before!.value })
        .eq('key', 'duplicate_window_hours');
    }
  });

  it('can add and delete a tariff row', async () => {
    const { data, error } = await owner
      .from('tariffs')
      .insert({
        carrier: 'econt',
        delivery_type: 'office',
        max_weight_g: 1000,
        price_cents: 410,
        valid_from: '2026-10-01',
        source: 'integration test',
      })
      .select()
      .single();
    expect(error).toBeNull();
    const { data: deleted } = await owner.from('tariffs').delete().eq('id', data!.id).select();
    expect(deleted).toHaveLength(1);
  });
});

describe('optimistic locking', () => {
  it('rejects an edit based on an old version with HTTP 409', async () => {
    const { data: product } = await packer
      .from('products')
      .insert({ sku: uniq('LOCK'), name: 'v1' })
      .select()
      .single();

    // Mum saves first (version 1 -> 2)...
    const { error: first } = await packer
      .from('products')
      .update({ name: 'mum', version: 1 })
      .eq('id', product!.id);
    expect(first).toBeNull();

    // ...then Dad saves the screen he loaded at version 1.
    const { error: stale, status } = await owner
      .from('products')
      .update({ name: 'dad', version: 1 })
      .eq('id', product!.id);
    expect(status).toBe(409);
    expect(stale?.code).toBe('PT409');

    const { data: row } = await admin
      .from('products')
      .select('name, version')
      .eq('id', product!.id)
      .single();
    expect(row).toEqual({ name: 'mum', version: 2 });
    await admin.from('products').delete().eq('id', product!.id);
  });

  it('never lets a client change created_at or skip the version counter', async () => {
    const { data: probe } = await packer
      .from('sync_probe')
      .insert({ label: uniq('meta'), created_at: '2000-01-01T00:00:00Z', version: 50 })
      .select()
      .single();
    expect(probe?.version).toBe(1);
    expect(new Date(probe!.created_at).getFullYear()).toBeGreaterThan(2000);
    await admin.from('sync_probe').delete().eq('id', probe!.id);
  });
});
