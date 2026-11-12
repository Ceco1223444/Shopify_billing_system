import { test as base, expect, type BrowserContext, type Page } from '@playwright/test';
import type { TestUser } from '../support/users';

interface Fixtures {
  /** A fresh browser context (= a separate computer). Closed automatically after the test. */
  newComputer: () => Promise<BrowserContext>;
  /** A separate computer, signed in as `user` through the login page. */
  openAs: (user: TestUser) => Promise<Page>;
}

/**
 * Every window a test opens is closed when the test ends. Otherwise a window left on
 * /dev/sync keeps that person "looking at" the test shipment, and later tests see it
 * (correctly) in presence.
 */
export const test = base.extend<Fixtures>({
  newComputer: async ({ browser }, use) => {
    const contexts: BrowserContext[] = [];
    await use(async () => {
      const context = await browser.newContext();
      contexts.push(context);
      return context;
    });
    await Promise.all(contexts.map((context) => context.close()));
  },
  openAs: async ({ newComputer }, use) => {
    await use(async (user) => {
      const page = await (await newComputer()).newPage();
      await signIn(page, user);
      return page;
    });
  },
});

export { expect };

/** Signs in through the login page and waits until the app shows the person's name. */
export async function signIn(page: Page, user: TestUser): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Имейл').fill(user.email);
  await page.getByLabel('Парола').fill(user.password);
  await page.getByRole('button', { name: 'Вход' }).click();
  await expect(page.getByTestId('current-user')).toContainText(user.displayName);
}
