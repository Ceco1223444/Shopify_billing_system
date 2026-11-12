/**
 * Raw CSV archiving, database side (P2-17 … P2-20):
 * past retention -> waiting (never deleted); a raw CSV cannot be deleted from
 * storage before its archive copy is confirmed with the right size and SHA-256.
 */
import type { SampleOrder } from '@happyhome/core/import';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminClient, signedInClient, type Client } from '../support/clients';
import { ageBatch, cleanUpRun, csvOf, postImport, runOrders } from '../support/imports';
import { uniq } from '../support/schema';
import { ensureTestUsers, TEST_USERS } from '../support/users';

const run = uniq('a')
  .replace(/[^a-z0-9]/gi, '')
  .slice(-10);
const O = runOrders(run);
const batchIds: string[] = [];
let owner: Client;
let packer: Client;

beforeAll(async () => {
  await ensureTestUsers();
  owner = await signedInClient(TEST_USERS.owner.email, TEST_USERS.owner.password);
  packer = await signedInClient(TEST_USERS.packer.email, TEST_USERS.packer.password);
});

afterAll(async () => {
  await cleanUpRun(run, batchIds);
});

/** Each call imports a different order, so every file is new (same content = refused). */
async function newBatch(name: string, order: SampleOrder) {
  const res = await postImport(owner, name, csvOf([order]));
  if (res.status !== 200) throw new Error(JSON.stringify(res.body));
  const id = res.body.result!.batch_id;
  batchIds.push(id);
  const { data } = await owner.from('import_batches').select('*').eq('id', id).single();
  return data!;
}

async function stateOf(id: string) {
  const { data } = await adminClient()
    .from('import_batches')
    .select(
      'archive_state, archived_at, archived_on, archived_path, archive_method, raw_deleted_at, storage_path',
    )
    .eq('id', id)
    .single();
  return data!;
}

async function stored(path: string) {
  const { data } = await adminClient().storage.from('raw-imports').exists(path);
  return data;
}

describe('raw CSV retention and archiving', () => {
  it('past retention, no archive copy: waits, and nothing is deleted (T2-10)', async () => {
    const batch = await newBatch('old.csv', O.o2003);
    expect(await owner.rpc('archive_mark_due', { p_all: false })).toMatchObject({ error: null });
    expect((await stateOf(batch.id)).archive_state).toBe('stored'); // too young

    await ageBatch(batch.id, 91);
    const { data: moved, error } = await owner.rpc('archive_mark_due', { p_all: false });
    expect(error).toBeNull();
    expect(moved).toBeGreaterThanOrEqual(1);
    expect((await stateOf(batch.id)).archive_state).toBe('waiting');
    expect(await stored(batch.storage_path!)).toBe(true);

    // Deleting it now is refused by the storage policy, even for the owner.
    await owner.storage.from('raw-imports').remove([batch.storage_path!]);
    expect(await stored(batch.storage_path!)).toBe(true);
  });

  it('records a copy only with the right size and SHA-256, then allows the delete (T2-09)', async () => {
    const batch = await newBatch('archive-me.csv', O.o2004);
    await owner.rpc('archive_mark_due', { p_all: true }); // "Архивирай сега"
    expect((await stateOf(batch.id)).archive_state).toBe('waiting');

    const wrong = await owner.rpc('archive_confirm', {
      p_batch_id: batch.id,
      p_sha256: '0'.repeat(64),
      p_size_bytes: batch.file_size_bytes!,
      p_computer: 'Test PC',
      p_path: '2026/x.csv',
      p_method: 'folder',
    });
    expect(wrong.error?.message).toContain('archive_checksum_mismatch');
    expect((await stateOf(batch.id)).archive_state).toBe('waiting');

    // Not archived yet: marking it deleted is refused.
    expect(
      (await owner.rpc('archive_mark_deleted', { p_batch_id: batch.id })).error,
    ).not.toBeNull();

    const right = await owner.rpc('archive_confirm', {
      p_batch_id: batch.id,
      p_sha256: batch.sha256,
      p_size_bytes: batch.file_size_bytes!,
      p_computer: 'Test PC',
      p_path: '2026/2026-11-13_archive-me.csv',
      p_method: 'folder',
    });
    expect(right.error).toBeNull();
    expect(await stateOf(batch.id)).toMatchObject({
      archive_state: 'archived',
      archived_on: 'Test PC',
      archived_path: '2026/2026-11-13_archive-me.csv',
      archive_method: 'folder',
      raw_deleted_at: null,
    });

    // Still in storage: cannot be marked deleted yet.
    expect(
      (await owner.rpc('archive_mark_deleted', { p_batch_id: batch.id })).error,
    ).not.toBeNull();
    const { error: removeError } = await owner.storage
      .from('raw-imports')
      .remove([batch.storage_path!]);
    expect(removeError).toBeNull();
    expect(await stored(batch.storage_path!)).toBe(false);
    expect((await owner.rpc('archive_mark_deleted', { p_batch_id: batch.id })).error).toBeNull();
    const after = await stateOf(batch.id);
    expect(after.raw_deleted_at).not.toBeNull();
    // The history keeps name, size, sha256 and the archive date (P2-23).
    const { data: history } = await owner
      .from('import_batches')
      .select('file_name, file_size_bytes, sha256, archived_at')
      .eq('id', batch.id)
      .single();
    expect(history).toMatchObject({ file_name: 'archive-me.csv', sha256: batch.sha256 });
    expect(history!.archived_at).not.toBeNull();
  });

  it('is owner only', async () => {
    const batch = await newBatch('packer-try.csv', O.o2005);
    expect((await packer.rpc('archive_mark_due', { p_all: true })).error?.message).toContain(
      'owner_only',
    );
    const confirm = await packer.rpc('archive_confirm', {
      p_batch_id: batch.id,
      p_sha256: batch.sha256,
      p_size_bytes: batch.file_size_bytes!,
      p_computer: 'x',
      p_path: 'x',
      p_method: 'zip',
    });
    expect(confirm.error?.message).toContain('owner_only');
    expect((await stateOf(batch.id)).archive_state).toBe('stored');
  });
});
