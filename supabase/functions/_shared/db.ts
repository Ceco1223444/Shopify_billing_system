/**
 * The only database access the shared Edge Function code needs: calling RPCs. The functions pass
 * their supabase-js service client; the Node tests pass a thin wrapper around theirs. Keeping it
 * this small lets the same files run in Deno (Edge Functions) and Node (tests) without imports.
 */
export interface DbError {
  message: string;
  code?: string;
}

export interface Db {
  rpc(
    fn: string,
    args?: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: DbError | null }>;
}

export class DbCallError extends Error {
  readonly code: string | undefined;
  constructor(fn: string, error: DbError) {
    super(`${fn}: ${error.message}`);
    this.name = 'DbCallError';
    this.code = error.code;
  }
}

export async function call<T>(db: Db, fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await db.rpc(fn, args);
  if (error) throw new DbCallError(fn, error);
  return data as T;
}

/** RPCs that return a composite row give all-null columns for "no row": treat that as null. */
export function rowOrNull<T extends { id?: unknown }>(row: T | null): T | null {
  return row && row.id !== null && row.id !== undefined ? row : null;
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
