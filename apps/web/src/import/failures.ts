/**
 * Import failure reasons. Kept apart from runImport.ts (which opens the Supabase client)
 * so unit tests can run without a Supabase URL.
 */

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
