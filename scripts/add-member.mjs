// Creates (or updates) a login and adds the person to the shop.
//
//   pnpm member:add --email mama@example.com --name "Мама" --role packer
//   pnpm member:add --email me@example.com --name "Ceco" --role owner --env-file .env.admin
//
// Options
//   --email      login email (required)
//   --name       name shown in the app, e.g. "Мама" (required)
//   --role       owner | packer (required)
//   --password   optional; if left out a strong password is generated and printed once
//   --env-file   file with SUPABASE_URL and SUPABASE_SECRET_KEY (the hosted project's
//                secret / service_role key). Without it the LOCAL stack is used.
//
// The secret key bypasses all security rules: keep that env file on your own computer only
// (*.env files are git-ignored) and never paste the key into chat, code or the web app.
import { createClient } from '@supabase/supabase-js';
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { localSupabaseStatus } from './lib/supabase-status.mjs';

const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    name: { type: 'string' },
    role: { type: 'string' },
    password: { type: 'string' },
    'env-file': { type: 'string' },
  },
});

const fail = (msg) => {
  console.error(`Error: ${msg}\nSee the usage notes at the top of scripts/add-member.mjs.`);
  process.exit(1);
};

const email = values.email?.trim().toLowerCase();
const name = values.name?.trim();
const role = values.role;
if (!email || !email.includes('@')) fail('--email is required');
if (!name) fail('--name is required');
if (role !== 'owner' && role !== 'packer') fail('--role must be owner or packer');

let url;
let secretKey;
if (values['env-file']) {
  process.loadEnvFile(values['env-file']);
  url = process.env.SUPABASE_URL;
  secretKey = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !secretKey)
    fail(`${values['env-file']} must set SUPABASE_URL and SUPABASE_SECRET_KEY`);
} else {
  const s = localSupabaseStatus();
  url = s.apiUrl;
  secretKey = s.secretKey;
}

const generated = !values.password;
const password = values.password ?? randomBytes(12).toString('base64url');
if (password.length < 8) fail('--password must be at least 8 characters');

const admin = createClient(url, secretKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function findUserByEmail(target) {
  for (let page = 1; page < 50; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const hit = data.users.find((u) => u.email?.toLowerCase() === target);
    if (hit) return hit;
    if (data.users.length < 200) return null;
  }
  return null;
}

let user = await findUserByEmail(email);
if (user) {
  const { error } = await admin.auth.admin.updateUserById(user.id, {
    password,
    email_confirm: true,
  });
  if (error) fail(error.message);
  console.log(`Existing login found for ${email}; password updated.`);
} else {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error) fail(error.message);
  user = data.user;
  console.log(`Login created for ${email}.`);
}

const { error: memberError } = await admin
  .from('members')
  .upsert({ user_id: user.id, display_name: name, role, active: true }, { onConflict: 'user_id' });
if (memberError) fail(memberError.message);

console.log(`${name} is now a member with role "${role}" on ${url}.`);
if (generated) console.log(`Password (shown once, give it to ${name} in person): ${password}`);
