// Deno-side helpers shared by the Edge Functions (not imported by the Node tests).
import { createClient } from 'npm:@supabase/supabase-js@2.119.0';

export const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

/** Every service key this project has (legacy JWT and/or the new secret keys). */
export function serviceKeys(): string[] {
  const keys: string[] = [];
  const legacy = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (legacy) keys.push(legacy);
  const secret = Deno.env.get('SUPABASE_SECRET_KEYS');
  if (secret) {
    try {
      keys.push(...Object.values(JSON.parse(secret) as Record<string, string>));
    } catch {
      // ignore a malformed value; the legacy key may still be there
    }
  }
  if (!keys.length) throw new Error('No service key in the Edge Function environment');
  return keys;
}

export function adminClient() {
  return createClient(Deno.env.get('SUPABASE_URL')!, serviceKeys()[0]!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export type Admin = ReturnType<typeof adminClient>;

/** True on the local development / CI stack (never on the hosted project). */
export function isLocalStack(): boolean {
  const host = new URL(Deno.env.get('SUPABASE_URL') ?? 'http://localhost').hostname;
  return ['kong', 'localhost', '127.0.0.1', 'host.docker.internal'].includes(host);
}

export type Caller =
  | { kind: 'service' }
  | { kind: 'cron' }
  | { kind: 'member'; role: 'owner' | 'packer'; userId: string };

/**
 * Who is calling: a service key (scripts, tests), pg_cron (its token), or a signed-in member.
 * Returns an error Response for everyone else.
 */
export async function identify(req: Request, admin: Admin): Promise<Caller | Response> {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return json(401, { error: 'not_signed_in' });
  if (serviceKeys().includes(token)) return { kind: 'service' };
  if (!token.includes('.')) {
    const { data: isCron } = await admin.rpc('courier_sync_check_token', { p_token: token });
    return isCron === true ? { kind: 'cron' } : json(401, { error: 'not_signed_in' });
  }
  const { data: auth, error: authError } = await admin.auth.getUser(token);
  if (authError || !auth.user) return json(401, { error: 'not_signed_in' });
  const { data: member, error } = await admin
    .from('members')
    .select('role, active')
    .eq('user_id', auth.user.id)
    .maybeSingle();
  if (error) return json(500, { error: 'lookup_failed' });
  if (!member || !member.active) return json(403, { error: 'not_a_member' });
  return { kind: 'member', role: member.role as 'owner' | 'packer', userId: auth.user.id };
}

/** The Econt production login, when the owner has set the Supabase secrets. */
export function econtProductionLogin(): { username: string; password: string } | null {
  const username = Deno.env.get('ECONT_USERNAME');
  const password = Deno.env.get('ECONT_PASSWORD');
  return username && password ? { username, password } : null;
}
