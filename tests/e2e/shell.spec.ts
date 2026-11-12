import { expect, test } from '@playwright/test';
import { TEST_USERS } from '../support/users';
import { openAs } from './helpers';

test('a signed-out visitor is sent to the login page', async ({ page }) => {
  await page.goto('/settings');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'Вход' })).toBeVisible();
});

test('a wrong password shows a clear Bulgarian message', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Имейл').fill(TEST_USERS.packer.email);
  await page.getByLabel('Парола').fill('wrong-password');
  await page.getByRole('button', { name: 'Вход' }).click();
  await expect(page.getByRole('alert')).toHaveText(/Грешен имейл или парола/);
});

test('a login that is not a shop member sees "Нямате достъп"', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/login');
  await page.getByLabel('Имейл').fill(TEST_USERS.outsider.email);
  await page.getByLabel('Парола').fill(TEST_USERS.outsider.password);
  await page.getByRole('button', { name: 'Вход' }).click();
  await expect(page.getByRole('heading', { name: 'Нямате достъп' })).toBeVisible();
});

test('the shell shows all six sections and switches between Bulgarian and English', async ({
  browser,
}) => {
  const page = await openAs(browser, TEST_USERS.packer);
  await expect(page).toHaveURL(/\/shipments$/);
  const nav = page.getByRole('navigation', { name: 'Основно меню' });
  for (const name of ['Пратки', 'Внасяне', 'Продукти', 'Наличност', 'Отчети', 'Настройки']) {
    await expect(nav.getByRole('link', { name })).toBeVisible();
  }

  await nav.getByRole('link', { name: 'Внасяне' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Внасяне на поръчки');

  await page.getByRole('button', { name: 'EN' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Import orders');
  await expect(page.getByRole('navigation', { name: 'Main menu' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');

  // The choice is remembered on this computer.
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Import orders');

  await page.getByRole('button', { name: 'БГ' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Внасяне на поръчки');

  await page.getByRole('button', { name: 'Изход' }).click();
  await expect(page.getByRole('heading', { name: 'Вход' })).toBeVisible();
});
