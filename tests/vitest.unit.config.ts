import { defineConfig } from 'vitest/config';

// Unit tests of the Edge Functions' shared code (supabase/functions/_shared): no database,
// fake network. Part of `pnpm test`, so CI runs them in the fast "checks" job.
export default defineConfig({
  test: {
    include: ['unit/**/*.test.ts'],
    environment: 'node',
  },
});
