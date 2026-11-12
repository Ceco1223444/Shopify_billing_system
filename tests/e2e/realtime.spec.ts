import { expect, test } from '@playwright/test';
import { uniq } from '../support/schema';
import { TEST_USERS } from '../support/users';
import { openAs } from './helpers';

test('an edit in one window appears in another user’s window in under 3 seconds', async ({
  browser,
}) => {
  const probe = uniq('e2e');
  const owner = await openAs(browser, TEST_USERS.owner);
  const packer = await openAs(browser, TEST_USERS.packer);

  await owner.goto(`/dev/sync?probe=${probe}`);
  await packer.goto(`/dev/sync?probe=${probe}`);
  await expect(owner.getByTestId('probe-status')).toHaveAttribute('data-status', 'live');
  await expect(packer.getByTestId('probe-status')).toHaveAttribute('data-status', 'live');

  const value = `Пратка за Пловдив ${Date.now()}`;
  await owner.getByTestId('probe-input').fill(value);
  const started = Date.now();
  await owner.getByTestId('probe-save').click();

  await expect(packer.getByTestId('probe-value')).toHaveText(value, { timeout: 3000 });
  expect(Date.now() - started).toBeLessThan(3000);

  // And back the other way.
  const reply = `Готово ${Date.now()}`;
  await packer.getByTestId('probe-input').fill(reply);
  await packer.getByTestId('probe-save').click();
  await expect(owner.getByTestId('probe-value')).toHaveText(reply, { timeout: 3000 });
});

test('presence: each person sees who else is looking at the same shipment', async ({ browser }) => {
  const owner = await openAs(browser, TEST_USERS.owner);
  const packer = await openAs(browser, TEST_USERS.packer);

  await owner.goto('/dev/sync');
  await packer.goto('/dev/sync');

  await expect(owner.getByTestId('viewers-badge')).toHaveText(/Мама гледа тази пратка/);
  await expect(packer.getByTestId('viewers-badge')).toHaveText(
    new RegExp(`${TEST_USERS.owner.displayName} гледа тази пратка`),
  );
  await expect(owner.getByTestId('online-now')).toContainText('Мама');

  // When Mum leaves the shipment, the badge disappears for the owner.
  await packer.getByRole('link', { name: 'Пратки' }).click();
  await expect(owner.getByTestId('viewers-badge')).toHaveCount(0);
  await expect(owner.getByTestId('presence-nobody')).toBeVisible();
});
