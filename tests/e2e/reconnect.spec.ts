import type { BrowserContext, Page } from '@playwright/test';
import { uniq } from '../support/schema';
import { TEST_USERS } from '../support/users';
import { expect, test } from './helpers';

/**
 * The local stack answers in ~1 ms; the hosted project (Ireland) takes tens of ms.
 * Delay every Realtime WebSocket message both ways so timing bugs show up locally too.
 */
async function withRealtimeLatency(context: BrowserContext, ms = 120) {
  await context.routeWebSocket(/\/realtime\/v1\//, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => setTimeout(() => server.send(message), ms));
    server.onMessage((message) => setTimeout(() => ws.send(message), ms));
  });
}

async function expectLive(page: Page) {
  await expect(page.getByTestId('probe-status')).toHaveAttribute('data-status', 'live');
}

async function saveProbe(page: Page, value: string) {
  await page.getByTestId('probe-input').fill(value);
  await page.getByTestId('probe-save').click();
}

test('live sync keeps working after leaving the page and coming straight back', async ({
  openAs,
}) => {
  const probe = uniq('remount');
  const owner = await openAs(TEST_USERS.owner);
  const packer = await openAs(TEST_USERS.packer);
  await withRealtimeLatency(owner.context());
  await withRealtimeLatency(packer.context());
  await owner.goto(`/dev/sync?probe=${probe}`);
  await packer.goto(`/dev/sync?probe=${probe}`);
  await expectLive(owner);
  await expectLive(packer);

  // Leave and come back quickly, several times (re-opens the same channels while the old ones close).
  for (let i = 0; i < 3; i += 1) {
    await packer.getByRole('link', { name: 'Пратки' }).click();
    await packer.goBack();
  }
  await expectLive(packer);
  await expect(owner.getByTestId('viewers-badge')).toHaveText(/Мама гледа тази пратка/);

  const value = `след връщане ${Date.now()}`;
  await saveProbe(owner, value);
  await expect(packer.getByTestId('probe-value')).toHaveText(value, { timeout: 3000 });

  const reply = `обратно ${Date.now()}`;
  await saveProbe(packer, reply);
  await expect(owner.getByTestId('probe-value')).toHaveText(reply, { timeout: 3000 });
});

test('a window keeps receiving live changes after the login in that browser switches to someone else', async ({
  openAs,
  newComputer,
}) => {
  const probe = uniq('switch');

  // One browser (shared login), two tabs: the second tab signs in as Мама,
  // which switches the first tab to Мама as well.
  const shared = await newComputer();
  await withRealtimeLatency(shared);
  const tab1 = await shared.newPage();
  await tab1.goto('/login');
  await tab1.getByLabel('Имейл').fill(TEST_USERS.owner.email);
  await tab1.getByLabel('Парола').fill(TEST_USERS.owner.password);
  await tab1.getByRole('button', { name: 'Вход' }).click();
  await expect(tab1.getByTestId('current-user')).toContainText(TEST_USERS.owner.displayName);
  await tab1.goto(`/dev/sync?probe=${probe}`);
  await expectLive(tab1);

  const tab2 = await shared.newPage();
  await tab2.goto('/shipments');
  await tab2.getByRole('button', { name: 'Изход' }).click();
  await tab2.getByLabel('Имейл').fill(TEST_USERS.packer.email);
  await tab2.getByLabel('Парола').fill(TEST_USERS.packer.password);
  await tab2.getByRole('button', { name: 'Вход' }).click();
  await expect(tab2.getByTestId('current-user')).toContainText('Мама');

  // Tab 1 follows the browser's login in place, without a reload (expected browser behaviour),
  // and says so loudly. Tab 2, where the login was typed, shows no warning.
  await expect(tab1.getByTestId('current-user')).toContainText('Мама');
  await expect(tab1.getByTestId('account-switched')).toContainText('В този браузър влезе Мама');
  await expect(tab2.getByTestId('account-switched')).toHaveCount(0);
  await expectLive(tab1);

  // ...and must still get live changes from the owner on another computer.
  const owner = await openAs(TEST_USERS.owner);
  await withRealtimeLatency(owner.context());
  await owner.goto(`/dev/sync?probe=${probe}`);
  await expectLive(owner);
  await expect(tab1.getByTestId('viewers-badge')).toHaveText(
    new RegExp(`${TEST_USERS.owner.displayName} гледа тази пратка`),
  );

  const value = `от собственика ${Date.now()}`;
  await saveProbe(owner, value);
  await expect(tab1.getByTestId('probe-value')).toHaveText(value, { timeout: 3000 });

  // The warning can be dismissed.
  await tab1.getByRole('button', { name: 'Разбрах' }).click();
  await expect(tab1.getByTestId('account-switched')).toHaveCount(0);
});

test('signing out and back in as someone else in the SAME tab shows no warning', async ({
  openAs,
}) => {
  const page = await openAs(TEST_USERS.owner);
  await page.getByRole('button', { name: 'Изход' }).click();
  await page.getByLabel('Имейл').fill(TEST_USERS.packer.email);
  await page.getByLabel('Парола').fill(TEST_USERS.packer.password);
  await page.getByRole('button', { name: 'Вход' }).click();
  await expect(page.getByTestId('current-user')).toContainText('Мама');
  await expect(page.getByTestId('account-switched')).toHaveCount(0);
});
