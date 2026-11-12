/**
 * Archiving raw CSV files to a folder on the owner's computer (P2-17 … P2-22).
 *
 * The rule that matters: a raw CSV is deleted from cloud storage ONLY after a
 * copy was written, read back, checked (size + SHA-256 equal to the imported
 * file) and recorded as archived. Any failure before that leaves the cloud file
 * alone. (The database also refuses the delete until the batch is archived.)
 *
 * Pure logic: the folder (browser File System Access API, or the desktop app
 * later) and the backend (Supabase) are passed in, so tests use fakes.
 */
import { archiveName, firstFreeName, sha256Hex, zip } from '@happyhome/core/import';

export interface ArchiveBatch {
  id: string;
  file_name: string;
  created_at: string;
  sha256: string;
  file_size_bytes: number | null;
  storage_path: string | null;
  archive_state: 'stored' | 'waiting' | 'archived';
  raw_deleted_at: string | null;
}

/** A folder chosen by the owner. Paths are `<dir>/<file>` inside it. */
export interface ArchiveFolder {
  exists(dir: string, file: string): Promise<boolean>;
  /** Creates `dir` if needed and writes a NEW file. Must not overwrite. */
  write(dir: string, file: string, bytes: Uint8Array): Promise<void>;
  read(dir: string, file: string): Promise<Uint8Array>;
}

export interface ArchiveBackend {
  download(batch: ArchiveBatch): Promise<Uint8Array>;
  confirm(
    batch: ArchiveBatch,
    copy: {
      sha256: string;
      size: number;
      computer: string;
      path: string;
      method: 'folder' | 'zip';
    },
  ): Promise<void>;
  /** Removes the raw CSV from cloud storage and records the date. */
  deleteRaw(batch: ArchiveBatch): Promise<void>;
}

export type ArchiveFailure = 'download' | 'checksum' | 'write' | 'verify' | 'confirm' | 'delete';

export type ArchiveOutcome =
  | { batchId: string; fileName: string; status: 'archived'; path: string }
  | { batchId: string; fileName: string; status: 'failed'; reason: ArchiveFailure };

/** Waiting for a copy, or archived but still in cloud storage (a delete to retry). */
export function needsArchiveWork(b: ArchiveBatch): boolean {
  if (!b.storage_path || b.raw_deleted_at) return false;
  return b.archive_state === 'waiting' || b.archive_state === 'archived';
}

async function matches(bytes: Uint8Array, batch: ArchiveBatch): Promise<boolean> {
  return (
    (batch.file_size_bytes == null || bytes.length === batch.file_size_bytes) &&
    (await sha256Hex(bytes)) === batch.sha256
  );
}

async function downloadChecked(
  batch: ArchiveBatch,
  backend: ArchiveBackend,
): Promise<Uint8Array | ArchiveFailure> {
  let bytes: Uint8Array;
  try {
    bytes = await backend.download(batch);
  } catch {
    return 'download';
  }
  return (await matches(bytes, batch)) ? bytes : 'checksum';
}

/** Saves each waiting file to `<folder>/<year>/<import date>_<name>.csv`, verifies it, then deletes the cloud copy. */
export async function archiveToFolder(
  batches: readonly ArchiveBatch[],
  folder: ArchiveFolder,
  backend: ArchiveBackend,
  computer: string,
): Promise<ArchiveOutcome[]> {
  const outcomes: ArchiveOutcome[] = [];
  for (const batch of batches.filter(needsArchiveWork)) {
    const fail = (reason: ArchiveFailure) =>
      outcomes.push({ batchId: batch.id, fileName: batch.file_name, status: 'failed', reason });

    if (batch.archive_state === 'archived') {
      // The copy was confirmed earlier; only the cloud delete is left.
      try {
        await backend.deleteRaw(batch);
        outcomes.push({
          batchId: batch.id,
          fileName: batch.file_name,
          status: 'archived',
          path: '',
        });
      } catch {
        fail('delete');
      }
      continue;
    }

    const bytes = await downloadChecked(batch, backend);
    if (typeof bytes === 'string') {
      fail(bytes);
      continue;
    }
    const { dir, file } = archiveName(batch.file_name, batch.created_at);
    let name: string;
    try {
      name = await firstFreeName(file, (candidate) => folder.exists(dir, candidate));
      await folder.write(dir, name, bytes);
    } catch {
      fail('write');
      continue;
    }
    try {
      const back = await folder.read(dir, name);
      if (!(await matches(back, batch))) throw new Error('mismatch');
    } catch {
      fail('verify');
      continue;
    }
    const path = `${dir}/${name}`;
    try {
      await backend.confirm(batch, {
        sha256: batch.sha256,
        size: bytes.length,
        computer,
        path,
        method: 'folder',
      });
    } catch {
      fail('confirm');
      continue;
    }
    try {
      await backend.deleteRaw(batch);
    } catch {
      fail('delete');
      continue;
    }
    outcomes.push({ batchId: batch.id, fileName: batch.file_name, status: 'archived', path });
  }
  return outcomes;
}

export interface ZipArchive {
  bytes: Uint8Array;
  entries: { batch: ArchiveBatch; path: string; size: number }[];
  failed: ArchiveOutcome[];
}

/** Browsers without folder access (P2-21): one ZIP of the waiting files, checked before zipping. */
export async function buildArchiveZip(
  batches: readonly ArchiveBatch[],
  backend: ArchiveBackend,
  now = new Date(),
): Promise<ZipArchive> {
  const used = new Set<string>();
  const entries: ZipArchive['entries'] = [];
  const files: { name: string; data: Uint8Array }[] = [];
  const failed: ArchiveOutcome[] = [];
  for (const batch of batches.filter((b) => needsArchiveWork(b) && b.archive_state === 'waiting')) {
    const bytes = await downloadChecked(batch, backend);
    if (typeof bytes === 'string') {
      failed.push({
        batchId: batch.id,
        fileName: batch.file_name,
        status: 'failed',
        reason: bytes,
      });
      continue;
    }
    const { dir, file } = archiveName(batch.file_name, batch.created_at);
    const name = await firstFreeName(file, async (c) => used.has(`${dir}/${c}`));
    const path = `${dir}/${name}`;
    used.add(path);
    files.push({ name: path, data: bytes });
    entries.push({ batch, path, size: bytes.length });
  }
  return { bytes: zip(files, now), entries, failed };
}

/** After the owner confirmed "Свалих ги": record each file as archived, then delete it from the cloud. */
export async function confirmZipDownloaded(
  entries: ZipArchive['entries'],
  backend: ArchiveBackend,
  computer: string,
): Promise<ArchiveOutcome[]> {
  const outcomes: ArchiveOutcome[] = [];
  for (const { batch, path, size } of entries) {
    try {
      await backend.confirm(batch, { sha256: batch.sha256, size, computer, path, method: 'zip' });
    } catch {
      outcomes.push({
        batchId: batch.id,
        fileName: batch.file_name,
        status: 'failed',
        reason: 'confirm',
      });
      continue;
    }
    try {
      await backend.deleteRaw(batch);
      outcomes.push({ batchId: batch.id, fileName: batch.file_name, status: 'archived', path });
    } catch {
      outcomes.push({
        batchId: batch.id,
        fileName: batch.file_name,
        status: 'failed',
        reason: 'delete',
      });
    }
  }
  return outcomes;
}
