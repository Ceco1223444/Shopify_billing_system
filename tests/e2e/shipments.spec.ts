/**
 * Phase 3 screens: the Пратки list (P3-16/17), split and merge by the owner (P3-10/11),
 * and what packers see (P3-12/15). Orders are imported through the real Edge Function.
 */
import { sampleLine, SAMPLE_PRODUCTS as P, type SampleOrder } from '@happyhome/core/import';
import { signedInClient } from '../support/clients';
import { cleanUpRun, csvOf, postImport } from '../support/imports';
import { uniq } from '../support/schema';
import { TEST_USERS } from '../support/users';
import { expect, test } from './helpers';

const run = uniq('shp')
  .replace(/[^a-z0-9]/gi, '')
  .slice(-10);
const digits = String([...run].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 1000, 0)).padStart(
  3,
  '0',
);
const L = sampleLine;
let seq = 0;

function order(over: Partial<SampleOrder> & { name: string }): SampleOrder {
  seq += 1;
  return {
    id: `${run}8${String(seq).padStart(4, '0')}`,
    email: `client${seq}.${run}@example.com`,
    created: `2026-11-1${seq % 10} 10:00:00 +0200`,
    recipient: `Клиент ${run} ${seq}`,
    a1: 'ул. Тестова 5',
    city: 'Пловдив',
    zip: '4000',
    phone: `0889${digits}${String(seq).padStart(3, '0')}`,
    lines: [L(P.blue)],
    ...over,
    name: `#${run}-${over.name}`,
  };
}

// Same email, same address -> combined. Same phone, two addresses -> two shipments to check.
const a = order({ name: 'A', email: `maria.${run}@example.com`, lines: [L(P.rose)] });
const b = order({
  name: 'B',
  email: ` Maria.${run}@Example.com `,
  lines: [L(P.towel, 2)],
  created: '2026-11-14 10:00:00 +0200',
});
const c = order({ name: 'C', phone: `0889${digits}900`, a1: 'ул. Първа 1' });
const d = order({
  name: 'D',
  phone: `0889${digits}900`,
  a1: 'Офис Еконт – Пловдив Тест',
  lines: [L(P.duvet)],
  created: '2026-11-15 10:00:00 +0200',
});
const ready = order({ name: 'E', lines: [L(P.pillow)] });

let batchId = '';

test.beforeAll(async () => {
  const owner = await signedInClient(TEST_USERS.owner.email, TEST_USERS.owner.password);
  const res = await postImport(owner, `shipments_${run}.csv`, csvOf([a, b, c, d, ready]));
  if (res.status !== 200) throw new Error(JSON.stringify(res.body));
  batchId = res.body.result!.batch_id;
});
test.afterAll(async () => cleanUpRun(run, batchId ? [batchId] : []));

const row = (page: import('@playwright/test').Page, reference: string) =>
  page.locator(`tr[data-reference="${reference}"]`);

test('the owner sees shipments (not orders), splits one and merges it back', async ({ openAs }) => {
  const page = await openAs(TEST_USERS.owner);
  await expect(page).toHaveURL(/\/shipments$/);
  await page.getByTestId('filter-all').click();

  const combined = row(page, `${a.name} + ${b.name}`);
  await expect(combined).toBeVisible();
  await expect(combined.getByTestId('combined-chip')).toHaveText('Обединени: имейл');
  await expect(combined).toContainText(a.recipient);
  await expect(combined).toContainText('Пловдив');
  await expect(combined.getByTestId('shipment-status')).toBeVisible();
  // One customer, two addresses: two shipments, both to check.
  await expect(row(page, c.name).getByTestId('shipment-status')).toHaveText(/За проверка/);
  await expect(row(page, d.name).getByTestId('flag-counts')).toContainText('за проверка');
  await expect(row(page, ready.name).getByTestId('shipment-status')).toHaveText(/Готова/);

  // Details: COD per order, contents, then split #B out (with a confirmation step).
  await combined.getByRole('link', { name: `${a.name} + ${b.name}` }).click();
  await expect(page.getByTestId('shipment-reference')).toHaveText(`${a.name} + ${b.name}`);
  await expect(page.getByTestId('cod-breakdown').locator('tbody tr')).toHaveCount(2);
  await expect(page.getByTestId('contents')).toContainText('2 × ');
  await page.locator(`li[data-order="${b.name}"]`).getByTestId('split').click();
  await page.getByTestId('split-confirm').click();
  await expect(page.getByTestId('detail-message')).toContainText(`${b.name} е в нова пратка`);
  await expect(page.getByTestId('shipment-reference')).toHaveText(a.name);

  // Back in the list: two shipments; select both and merge them again.
  await page.getByRole('link', { name: '← Всички пратки' }).click();
  await page.getByTestId('filter-all').click();
  await expect(row(page, a.name)).toBeVisible();
  await expect(row(page, b.name)).toBeVisible();
  await row(page, a.name).getByRole('checkbox').check();
  await row(page, b.name).getByRole('checkbox').check();
  await page.getByTestId('merge-selected').click();
  await expect(page.getByText('Да обединим ли тези пратки?')).toBeVisible();
  await page.getByTestId('merge-confirm').click();
  await expect(page.getByTestId('list-message')).toContainText('Пратките са обединени');
  const merged = row(page, `${a.name} + ${b.name}`);
  await expect(merged).toBeVisible();
  await expect(merged.getByTestId('combined-chip')).toHaveText('Обединени: имейл, ръчно');
});

test('packers see only shipments that are checked, and cannot split or merge', async ({
  openAs,
}) => {
  const page = await openAs(TEST_USERS.packer);
  await page.goto('/shipments');
  await page.getByTestId('filter-all').click();
  await expect(page.getByTestId('packer-waiting')).toContainText('чака');
  await expect(row(page, ready.name)).toBeVisible();
  await expect(row(page, c.name)).toHaveCount(0);
  await expect(row(page, d.name)).toHaveCount(0);
  await expect(page.getByTestId('shipment-list').getByRole('checkbox')).toHaveCount(0);

  // Even with the link, a shipment that needs checking stays hidden.
  const owner = await signedInClient(TEST_USERS.owner.email, TEST_USERS.owner.password);
  const { data } = await owner
    .from('shipment_overview')
    .select('id')
    .eq('reference', c.name)
    .single();
  await page.goto(`/shipments/${data!.id}`);
  await expect(page.getByTestId('packer-hidden')).toBeVisible();

  await page.goto('/shipments');
  await page.getByTestId('filter-all').click();
  await row(page, ready.name).getByRole('link').click();
  await expect(page.getByTestId('shipment-reference')).toHaveText(ready.name);
  await expect(page.getByTestId('split')).toHaveCount(0);
  await expect(page.getByTestId('merge-suggested')).toHaveCount(0);
});
