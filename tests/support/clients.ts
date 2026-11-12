import type { Database } from '@happyhome/core';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { testEnv } from './env';

export type Client = SupabaseClient<Database>;

const noSession = { auth: { persistSession: false, autoRefreshToken: false } } as const;

/** Service role: bypasses RLS. Only for test setup and clean-up. */
export function adminClient(): Client {
  const env = testEnv();
  return createClient<Database>(env.url, env.secretKey, noSession);
}

/** Signed-out visitor with the public (publishable) key. */
export function anonClient(): Client {
  const env = testEnv();
  return createClient<Database>(env.url, env.publishableKey, noSession);
}

export async function signedInClient(email: string, password: string): Promise<Client> {
  const client = anonClient();
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`Sign-in failed for ${email}: ${error.message}`);
  return client;
}
