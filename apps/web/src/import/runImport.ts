/**
 * Imports one file: read it, refuse it if it was imported before, parse it in the
 * browser with the ported legacy converter, then send the file + the parse result
 * to the import-batch Edge Function, which writes everything in one transaction.
 */
import { buildImportPayload, sha256Hex, type ImportFlag } from '@happyhome/core/import';
import { supabase, supabasePublishableKey, supabaseUrl } from '../lib/supabase';

export type ImportStage = 'reading' | 'checking' | 'uploading';

export interface ImportCounts {
  new: number;
  updated: number;
  unchanged: number;
  skipped: number;
  to_check: number;
}

export interface EarlierBatch {
  id: string;
  file_name: string;
  created_at: string;
}

export type ImportOutcome =
  | { kind: 'done'; batchId: string; counts: ImportCounts }
  | { kind: 'duplicate'; batch: EarlierBatch | null }
  | { kind: 'not_importable'; flags: ImportFlag[] }
  | { kind: 'failed'; reason: ImportFailure };

/**
 * offline   - the browser could not reach Supabase at all
 * not_ready - the database answered, but without the Phase 2 tables (migration not pushed)
 * service   - the database answered, but the import-batch Edge Function did not (not deployed / down)
 */
export type ImportFailure = 'offline' | 'not_ready' | 'service' | 'owner_only' | 'other';

/** Why the "imported before?" lookup failed. Only a request that never got an answer is "offline". */
export function lookupFailure(error: {
  code?: string | null;
  message?: string | null;
}): ImportFailure {
  const code = error.code ?? '';
  // 42703 undefined column, 42P01 undefined table, PGRST204/205 column/table not in the schema cache
  if (['42703', '42P01', 'PGRST204', 'PGRST205'].includes(code)) return 'not_ready';
  if (!code && /fetch|network|load failed/i.test(error.message ?? '')) return 'offline';
  return 'other';
}

/** Lets React paint the new stage before the next heavy step. */
const nextFrame = () => new Promise((r) => setTimeout(r, 0));

export async function importOneFile(
  file: File,
  onStage: (stage: ImportStage) => void,
): Promise<ImportOutcome> {
  onStage('reading');
  await nextFrame();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const sha256 = await sha256Hex(bytes);

  // Imported before? Answer straight away, without uploading anything.
  const { data: earlier, error: lookupError } = await supabase
    .from('import_batches')
    .select('id, file_name, created_at')
    .eq('sha256', sha256)
    .maybeSingle();
  if (lookupError) return { kind: 'failed', reason: lookupFailure(lookupError) };
  if (earlier) return { kind: 'duplicate', batch: earlier };

  onStage('checking');
  await nextFrame();
  const prepared = buildImportPayload({ name: file.name, bytes, sha256 });
  if (!prepared.ok) {
    return { kind: 'not_importable', flags: prepared.flags.filter((f) => f.severity === 'red') };
  }

  onStage('uploading');
  const { data: session } = await supabase.auth.getSession();
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'text/csv' }), file.name);
  form.append('payload', JSON.stringify(prepared.payload));
  let res: Response;
  try {
    res = await fetch(`${supabaseUrl}/functions/v1/import-batch`, {
      method: 'POST',
      headers: {
        apikey: supabasePublishableKey,
        Authorization: `Bearer ${session.session?.access_token ?? ''}`,
      },
      body: form,
    });
  } catch {
    // The database answered a moment ago, so a request that gets no answer at all here
    // means the import service is missing (a missing function also fails the CORS check).
    return { kind: 'failed', reason: navigator.onLine === false ? 'offline' : 'service' };
  }
  const body = (await res.json().catch(() => ({}))) as {
    result?: ImportCounts & { batch_id: string };
    error?: string;
    batch?: EarlierBatch | null;
  };
  if (res.ok && body.result) {
    const { batch_id, ...counts } = body.result;
    return { kind: 'done', batchId: batch_id, counts };
  }
  if (res.status === 409) return { kind: 'duplicate', batch: body.batch ?? null };
  if (res.status === 403) return { kind: 'failed', reason: 'owner_only' };
  if (res.status === 404) return { kind: 'failed', reason: 'service' };
  return { kind: 'failed', reason: 'other' };
}
