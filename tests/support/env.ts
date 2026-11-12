import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const envFile = fileURLToPath(new URL('../.env.test.local', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

function need(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. Start local Supabase (pnpm db:start), then run pnpm env:local.`,
    );
  }
  return value;
}

/** Connection details of the LOCAL Supabase stack. Tests never run against the hosted project. */
export function testEnv() {
  const env = {
    url: need('SUPABASE_URL'),
    publishableKey: need('SUPABASE_PUBLISHABLE_KEY'),
    secretKey: need('SUPABASE_SECRET_KEY'),
    dbUrl: need('SUPABASE_DB_URL'),
  };
  const host = new URL(env.url).hostname;
  if (host !== '127.0.0.1' && host !== 'localhost') {
    throw new Error(`Refusing to run tests against ${env.url}: tests create and delete data.`);
  }
  return env;
}
