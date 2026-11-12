import { sha256Hex } from '@happyhome/core/import';
import { describe, expect, it } from 'vitest';
import {
  archiveToFolder,
  buildArchiveZip,
  confirmZipDownloaded,
  type ArchiveBackend,
  type ArchiveBatch,
  type ArchiveFolder,
} from './archiver';

const enc = new TextEncoder();
const CSV = enc.encode('Name,Email\n#1,a@example.com\n');

async function batch(overrides: Partial<ArchiveBatch> = {}, bytes = CSV): Promise<ArchiveBatch> {
  return {
    id: 'b1',
    file_name: 'orders_export.csv',
    created_at: '2026-08-01T09:00:00Z',
    sha256: await sha256Hex(bytes),
    file_size_bytes: bytes.length,
    storage_path: '2026/b1.csv',
    archive_state: 'waiting',
    raw_deleted_at: null,
    ...overrides,
  };
}

/** A folder in memory. `failWrites` simulates a full disk or a revoked permission. */
function memoryFolder(
  initial: Record<string, Uint8Array> = {},
  opts: { failWrites?: boolean; corrupt?: boolean } = {},
) {
  const files = new Map(Object.entries(initial));
  const folder: ArchiveFolder = {
    async exists(dir, file) {
      return files.has(`${dir}/${file}`);
    },
    async write(dir, file, bytes) {
      if (opts.failWrites) throw new DOMException('denied', 'NotAllowedError');
      if (files.has(`${dir}/${file}`)) throw new Error('would overwrite');
      files.set(`${dir}/${file}`, opts.corrupt ? bytes.slice(1) : bytes.slice());
    },
    async read(dir, file) {
      const b = files.get(`${dir}/${file}`);
      if (!b) throw new DOMException('missing', 'NotFoundError');
      return b;
    },
  };
  return { folder, files };
}

function fakeBackend(bytes = CSV, opts: { failConfirm?: boolean; failDelete?: boolean } = {}) {
  const calls: string[] = [];
  const confirmed: Parameters<ArchiveBackend['confirm']>[1][] = [];
  const backend: ArchiveBackend = {
    async download(b) {
      calls.push(`download:${b.id}`);
      return bytes;
    },
    async confirm(b, copy) {
      calls.push(`confirm:${b.id}`);
      if (opts.failConfirm) throw new Error('offline');
      confirmed.push(copy);
    },
    async deleteRaw(b) {
      calls.push(`delete:${b.id}`);
      if (opts.failDelete) throw new Error('offline');
    },
  };
  return { backend, calls, confirmed };
}

describe('archiving to a chosen folder', () => {
  it('T2-09: saves with the right name and checksum, records it, and only then deletes the cloud copy', async () => {
    const b = await batch();
    const { folder, files } = memoryFolder();
    const { backend, calls, confirmed } = fakeBackend();

    const out = await archiveToFolder([b], folder, backend, 'Лаптоп на Цецо');

    expect(out).toEqual([
      {
        batchId: 'b1',
        fileName: 'orders_export.csv',
        status: 'archived',
        path: '2026/2026-08-01_orders_export.csv',
      },
    ]);
    expect(files.get('2026/2026-08-01_orders_export.csv')).toEqual(CSV);
    expect(calls).toEqual(['download:b1', 'confirm:b1', 'delete:b1']);
    expect(confirmed[0]).toEqual({
      sha256: b.sha256,
      size: CSV.length,
      computer: 'Лаптоп на Цецо',
      path: '2026/2026-08-01_orders_export.csv',
      method: 'folder',
    });
  });

  it('T2-11: an existing file of that name gets a suffix; the original is untouched', async () => {
    const original = enc.encode('the owner put this here');
    const { folder, files } = memoryFolder({
      '2026/2026-08-01_orders_export.csv': original,
      '2026/2026-08-01_orders_export (2).csv': original,
    });
    const { backend } = fakeBackend();
    const out = await archiveToFolder([await batch()], folder, backend, 'PC');
    expect(out[0]).toMatchObject({
      status: 'archived',
      path: '2026/2026-08-01_orders_export (3).csv',
    });
    expect(files.get('2026/2026-08-01_orders_export.csv')).toBe(original);
    expect(files.get('2026/2026-08-01_orders_export (3).csv')).toEqual(CSV);
  });

  it('T2-12: when writing to the folder fails, nothing is deleted from storage', async () => {
    const { folder } = memoryFolder({}, { failWrites: true });
    const { backend, calls } = fakeBackend();
    const out = await archiveToFolder([await batch()], folder, backend, 'PC');
    expect(out).toEqual([
      { batchId: 'b1', fileName: 'orders_export.csv', status: 'failed', reason: 'write' },
    ]);
    expect(calls).toEqual(['download:b1']);
  });

  it('does not delete when the copy on disk does not match', async () => {
    const { folder } = memoryFolder({}, { corrupt: true });
    const { backend, calls } = fakeBackend();
    const out = await archiveToFolder([await batch()], folder, backend, 'PC');
    expect(out[0]).toMatchObject({ status: 'failed', reason: 'verify' });
    expect(calls).not.toContain('confirm:b1');
    expect(calls).not.toContain('delete:b1');
  });

  it('does not write or delete when the downloaded file differs from the imported one', async () => {
    const { folder, files } = memoryFolder();
    const { backend, calls } = fakeBackend(enc.encode('something else'));
    const out = await archiveToFolder([await batch()], folder, backend, 'PC');
    expect(out[0]).toMatchObject({ status: 'failed', reason: 'checksum' });
    expect(files.size).toBe(0);
    expect(calls).toEqual(['download:b1']);
  });

  it('does not delete when recording the copy fails', async () => {
    const { folder } = memoryFolder();
    const { backend, calls } = fakeBackend(CSV, { failConfirm: true });
    const out = await archiveToFolder([await batch()], folder, backend, 'PC');
    expect(out[0]).toMatchObject({ status: 'failed', reason: 'confirm' });
    expect(calls).not.toContain('delete:b1');
  });

  it('retries only the delete for a copy confirmed earlier, and skips files not waiting', async () => {
    const { folder, files } = memoryFolder();
    const { backend, calls } = fakeBackend();
    const archived = await batch({ id: 'b2', archive_state: 'archived' });
    const stored = await batch({ id: 'b3', archive_state: 'stored' });
    const done = await batch({
      id: 'b4',
      archive_state: 'archived',
      raw_deleted_at: '2026-11-01T00:00:00Z',
    });
    const out = await archiveToFolder([archived, stored, done], folder, backend, 'PC');
    expect(calls).toEqual(['delete:b2']);
    expect(out).toHaveLength(1);
    expect(files.size).toBe(0);
  });
});

describe('ZIP download for browsers without folder access (P2-21)', () => {
  it('zips the checked files and deletes nothing until the owner confirms', async () => {
    const { backend, calls } = fakeBackend();
    const b = await batch();
    const archive = await buildArchiveZip([b, { ...b, id: 'b5' }], backend, new Date(2026, 10, 13));
    expect(archive.entries.map((e) => e.path)).toEqual([
      '2026/2026-08-01_orders_export.csv',
      '2026/2026-08-01_orders_export (2).csv',
    ]);
    expect(archive.bytes[0]).toBe(0x50); // "PK"
    expect(calls.filter((c) => !c.startsWith('download'))).toEqual([]);

    const out = await confirmZipDownloaded(archive.entries, backend, 'Firefox');
    expect(out.every((o) => o.status === 'archived')).toBe(true);
    expect(calls.slice(-4)).toEqual(['confirm:b1', 'delete:b1', 'confirm:b5', 'delete:b5']);
  });
});
