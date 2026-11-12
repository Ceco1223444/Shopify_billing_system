import { supabase } from '../lib/supabase';
import type { ArchiveBackend, ArchiveBatch } from './archiver';

const ARCHIVE_COLUMNS =
  'id, file_name, created_at, sha256, file_size_bytes, storage_path, archive_state, raw_deleted_at';

/** Files waiting for an archive copy, or archived but still in cloud storage. */
export async function loadArchiveWork(): Promise<ArchiveBatch[]> {
  const { data, error } = await supabase
    .from('import_batches')
    .select(ARCHIVE_COLUMNS)
    .or('archive_state.eq.waiting,and(archive_state.eq.archived,raw_deleted_at.is.null)')
    .not('storage_path', 'is', null)
    .order('created_at');
  if (error) throw error;
  return (data ?? []) as ArchiveBatch[];
}

/** Moves files past settings.raw_csv_retention_days (or all, for "Архивирай сега") to "waiting". */
export async function markDue(all: boolean): Promise<void> {
  const { error } = await supabase.rpc('archive_mark_due', { p_all: all });
  if (error) throw error;
}

export const supabaseArchiveBackend: ArchiveBackend = {
  async download(batch) {
    const { data, error } = await supabase.storage
      .from('raw-imports')
      .download(batch.storage_path!);
    if (error || !data) throw error ?? new Error('download failed');
    return new Uint8Array(await data.arrayBuffer());
  },
  async confirm(batch, copy) {
    const { error } = await supabase.rpc('archive_confirm', {
      p_batch_id: batch.id,
      p_sha256: copy.sha256,
      p_size_bytes: copy.size,
      p_computer: copy.computer,
      p_path: copy.path,
      p_method: copy.method,
    });
    if (error) throw error;
  },
  async deleteRaw(batch: ArchiveBatch) {
    const { error } = await supabase.storage.from('raw-imports').remove([batch.storage_path!]);
    if (error) throw error;
    const { error: markError } = await supabase.rpc('archive_mark_deleted', {
      p_batch_id: batch.id,
    });
    if (markError) throw markError;
  },
};
