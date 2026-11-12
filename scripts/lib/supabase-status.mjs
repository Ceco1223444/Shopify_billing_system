import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const cliPath = join(dirname(require.resolve('supabase/package.json')), 'dist', 'supabase.js');

/** Runs the project's pinned Supabase CLI and returns stdout (no pnpm wrapper output). */
export function supabaseCli(args, options = {}) {
  return execFileSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
}

/** Reads the running local Supabase stack's URLs and keys (`supabase status -o json`). */
export function localSupabaseStatus() {
  let out;
  try {
    out = supabaseCli(['status', '-o', 'json']);
  } catch (error) {
    throw new Error(
      'Local Supabase is not running. Start Docker Desktop, then run `pnpm db:start`.\n' +
        String(error.stderr ?? error.message),
      { cause: error },
    );
  }
  const start = out.indexOf('{');
  const end = out.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error(`Unexpected output from supabase status:\n${out}`);
  const status = JSON.parse(out.slice(start, end + 1));
  for (const key of ['API_URL', 'DB_URL']) {
    if (!status[key]) throw new Error(`supabase status did not report ${key}`);
  }
  return {
    apiUrl: status.API_URL,
    dbUrl: status.DB_URL,
    publishableKey: status.PUBLISHABLE_KEY ?? status.ANON_KEY,
    secretKey: status.SECRET_KEY ?? status.SERVICE_ROLE_KEY,
  };
}
