import { ensureTestUsers } from './users';

/** Shared by Vitest (integration) and Playwright (e2e). */
export default async function globalSetup() {
  await ensureTestUsers();
}
