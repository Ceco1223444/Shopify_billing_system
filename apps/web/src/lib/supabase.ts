import type { Database } from '@happyhome/core';
import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
// Publishable key (sb_publishable_...) or, on older projects, the legacy anon key.
const key = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ??
  import.meta.env.VITE_SUPABASE_ANON_KEY) as string | undefined;

if (!url || !key) {
  throw new Error(
    'Missing VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY. ' +
      'Run `pnpm env:local` (local Supabase) or copy apps/web/.env.example to apps/web/.env.local.',
  );
}

export const supabase = createClient<Database>(url, key, {
  auth: { persistSession: true, autoRefreshToken: true },
});

/** Dev-only pages (connection check) are on in `pnpm dev` or when explicitly enabled. */
export const devPagesEnabled =
  import.meta.env.DEV || import.meta.env.VITE_ENABLE_DEV_PAGES === 'true';

/** For direct fetch() calls to Edge Functions (multipart uploads). */
export const supabaseUrl: string = url;
export const supabasePublishableKey: string = key;
