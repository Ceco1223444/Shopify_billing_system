import { expect, type Browser, type Page } from '@playwright/test';
import type { TestUser } from '../support/users';

/** Opens a fresh browser context (= a separate computer) and signs in through the login page. */
export async function openAs(browser: Browser, user: TestUser): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/login');
  await page.getByLabel('Имейл').fill(user.email);
  await page.getByLabel('Парола').fill(user.password);
  await page.getByRole('button', { name: 'Вход' }).click();
  await expect(page.getByTestId('current-user')).toContainText(user.displayName);
  return page;
}
