// import-batch — stores one Shopify CSV and its parsed orders (Phase 2, P2-15).
//
// The browser parses the file with the ported legacy converter and sends
//   multipart/form-data: file = the raw CSV, payload = JSON (packages/core/src/import/payload.ts)
// This function:
//   1. checks the caller is a signed-in, active OWNER (import is owner only);
//   2. checks the payload belongs to this exact file (size + SHA-256 computed here);
//   3. refuses a file whose SHA-256 was imported before (HTTP 409, the app shows it in Bulgarian);
//   4. stores the raw file in the private raw-imports bucket;
//   5. calls public.import_commit(), which writes the batch, orders, lines, flags and
//      audit entries in ONE transaction. If that fails, the stored file is removed again.
//
// Responses (JSON): 200 { ok, result }, 400 bad_request | file_mismatch, 401 not_signed_in,
// 403 not_a_member | owner_only, 409 duplicate_file { batch }, 413 file_too_large, 500 *_failed.
import { createClient } from 'npm:@supabase/supabase-js@2.119.0';

const MAX_BYTES = 50 * 1024 * 1024; // same limit as the raw-imports bucket

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

interface PayloadFile {
  name: string;
  size: number;
  sha256: string;
}

function isPayload(value: unknown): value is { version: 1; file: PayloadFile; orders: unknown[] } {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  const file = v.file as Record<string, unknown> | undefined;
  return (
    v.version === 1 &&
    !!file &&
    typeof file.name === 'string' &&
    typeof file.size === 'number' &&
    typeof file.sha256 === 'string' &&
    Array.isArray(file.columns) &&
    Array.isArray(v.orders) &&
    Array.isArray(v.skipped) &&
    Array.isArray(v.batch_flags)
  );
}

function serviceKey(): string {
  // Older stacks expose the legacy JWT; newer ones may only expose the secret keys.
  const legacy = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (legacy) return legacy;
  const keys = Deno.env.get('SUPABASE_SECRET_KEYS');
  if (keys) {
    const parsed = JSON.parse(keys) as Record<string, string>;
    const first = parsed.default ?? Object.values(parsed)[0];
    if (first) return first;
  }
  throw new Error('No service key in the Edge Function environment');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, serviceKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // 1. Who is calling?
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return json(401, { error: 'not_signed_in' });
  const { data: auth, error: authError } = await admin.auth.getUser(token);
  if (authError || !auth.user) return json(401, { error: 'not_signed_in' });
  const userId = auth.user.id;
  const { data: member, error: memberError } = await admin
    .from('members')
    .select('role, active')
    .eq('user_id', userId)
    .maybeSingle();
  if (memberError) return json(500, { error: 'lookup_failed' });
  if (!member || !member.active) return json(403, { error: 'not_a_member' });
  if (member.role !== 'owner') return json(403, { error: 'owner_only' });

  // 2. The file and its parse result.
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json(400, { error: 'bad_request' });
  }
  const file = form.get('file');
  const payloadText = form.get('payload');
  if (!(file instanceof File) || typeof payloadText !== 'string') {
    return json(400, { error: 'bad_request' });
  }
  if (file.size > MAX_BYTES) return json(413, { error: 'file_too_large' });
  let payload: unknown;
  try {
    payload = JSON.parse(payloadText);
  } catch {
    return json(400, { error: 'bad_request' });
  }
  if (!isPayload(payload)) return json(400, { error: 'bad_request' });

  const bytes = new Uint8Array(await file.arrayBuffer());
  const sha256 = await sha256Hex(bytes);
  if (payload.file.sha256 !== sha256 || payload.file.size !== bytes.length) {
    return json(400, { error: 'file_mismatch' });
  }

  // 3. Imported before?
  const duplicate = async () => {
    const { data } = await admin
      .from('import_batches')
      .select('id, file_name, created_at')
      .eq('sha256', sha256)
      .maybeSingle();
    return data;
  };
  const existing = await duplicate();
  if (existing) return json(409, { error: 'duplicate_file', batch: existing });

  // 4. Keep the raw file (ASCII-only key; the original name is stored in the batch row).
  const batchId = crypto.randomUUID();
  const path = `${new Date().getUTCFullYear()}/${batchId}.csv`;
  const raw = admin.storage.from('raw-imports');
  const { error: uploadError } = await raw.upload(path, bytes, {
    contentType: 'text/csv',
    upsert: false,
  });
  if (uploadError) return json(500, { error: 'storage_failed' });

  // 5. Everything else in one transaction.
  const { data: result, error: commitError } = await admin.rpc('import_commit', {
    p_actor: userId,
    p_batch_id: batchId,
    p_storage_path: path,
    p_payload: payload,
  });
  if (commitError) {
    await raw.remove([path]);
    if (commitError.code === '23505') {
      return json(409, { error: 'duplicate_file', batch: await duplicate() });
    }
    if (commitError.code === '42501') return json(403, { error: 'owner_only' });
    // No customer data in logs: only the database error code.
    console.error('import_commit failed', commitError.code);
    return json(500, { error: 'import_failed' });
  }
  return json(200, { ok: true, result });
});
