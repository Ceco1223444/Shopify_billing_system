/**
 * Phase 5 screens: the delivery chips in the Пратки list (acceptance: carrier badge, type icon,
 * office name and a green / amber / red chip with the reason), and the call tools on the shipment
 * page, used by the owner AND the packers (owner's decision, 14 Nov 2026).
 *
 * Orders are imported through the real Edge Function; the detection runs here with a fake
 * Nominatim (no test address goes to the real one). An address edit runs the real detect-delivery
 * function, whose geocoder is off on the local stack.
 */
import type { SampleOrder } from '@happyhome/core/import';
import type pg from 'pg';
import { runDetection, type DeliveryJobDeps } from '../../supabase/functions/_shared/delivery';
import { adminClient, signedInClient } from '../support/clients';
import { pgClient, resetCourierData, rpcDb } from '../support/couriers';
import { cleanUpRun, csvOf, postImport } from '../support/imports';
import { uniq } from '../support/schema';
import { TEST_USERS } from '../support/users';
import { expect, test } from './helpers';

const run = uniq('dlv')
  .replace(/[^a-z0-9]/gi, '')
  .slice(-10);
const digits = String([...run].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 1000, 0)).padStart(
  3,
  '0',
);

const OFFICES = [
  [
    'econt',
    '4064',
    'office',
    'Пловдив Капана',
    'Пловдив',
    '4000',
    'ул. Стефан Веркович №3',
    42.150058,
    24.749258,
  ],
  [
    'speedy',
    '202',
    'office',
    'РУСЕ - БУРОВ',
    'Русе',
    null,
    'гр. Русе ул. Буров No 2',
    43.846591,
    25.951992,
  ],
  [
    'speedy',
    '737',
    'office',
    'РУСЕ - БОРИСОВА',
    'Русе',
    null,
    'гр. Русе ул. Борисова No 113',
    43.835456,
    25.956028,
  ],
] as const;

const NOMINATIM: Record<string, unknown[]> = {
  Русе: [
    {
      lat: '43.8475',
      lon: '25.9532',
      display_name: 'Русе, България',
      addresstype: 'city',
      category: 'place',
      type: 'city',
      place_rank: 16,
      address: { country_code: 'bg', city: 'Русе' },
    },
  ],
};
const fakeFetch = (async (input: RequestInfo | URL) => {
  const q = new URL(String(input)).searchParams.get('q') ?? '';
  return new Response(JSON.stringify(NOMINATIM[q] ?? []), {
    headers: { 'Content-Type': 'application/json' },
  });
}) as typeof fetch;
const jobDeps = (): DeliveryJobDeps => ({
  db: rpcDb(adminClient()),
  fetch: fakeFetch,
  geocoder: { provider: 'nominatim', url: 'https://nominatim.test', enabled: true, email: null },
  geocodeMaxWaitMs: 20_000,
});

let seq = 0;
function order(key: string, over: Partial<SampleOrder>): SampleOrder {
  seq += 1;
  return {
    name: `#${run}-${key}`,
    id: `${run}6${String(seq).padStart(4, '0')}`,
    email: `${key}.${run}@example.com`,
    created: `2026-11-14 1${seq}:00:00 +0200`,
    recipient: `Клиент ${run} ${key}`,
    a1: '',
    city: '',
    zip: '',
    phone: `0887${digits}${String(seq).padStart(3, '0')}`,
    lines: [{ title: 'Спален комплект - Син', sku: `SKU-${run}`, price: 40, qty: 1 }],
    ...over,
  };
}

const ORDERS = {
  sure: order('sure', { a1: 'Еконт офис Капана', city: 'Пловдив', zip: '4000' }),
  call: order('call', { a1: 'до офис на спиди', city: 'Русе', zip: '7000' }),
  error: order('error', { a1: 'BOX NOW Лозенец', city: 'София', zip: '1000' }),
  refuse: order('refuse', { a1: 'до офис на спиди', city: 'Русе', zip: '7000' }),
  edit: order('edit', { a1: 'Еконт', city: 'Пловдив', zip: '4000' }),
};
type Key = keyof typeof ORDERS;
const ref = (k: Key) => ORDERS[k].name;
const shipmentOf = {} as Record<Key, string>;
let db: pg.Client;
let batchId = '';

test.beforeAll(async () => {
  db = await pgClient();
  await resetCourierData(db);
  for (const [carrier, id, type, name, city, postcode, address, lat, lng] of OFFICES) {
    await db.query(
      `insert into public.courier_offices (carrier, external_id, code, type, name_bg, city, postcode, address_text, lat, lng, source, coord_source)
       values ($1, $2, $2, $3, $4, $5, $6, $7, $8, $9, 'test', 'courier')`,
      [carrier, id, type, name, city, postcode, address, lat, lng],
    );
  }
  const owner = await signedInClient(TEST_USERS.owner.email, TEST_USERS.owner.password);
  const res = await postImport(owner, `delivery_${run}.csv`, csvOf(Object.values(ORDERS)));
  if (res.status !== 200) throw new Error(JSON.stringify(res.body));
  batchId = res.body.result!.batch_id;
  for (const [key, o] of Object.entries(ORDERS)) {
    const { rows } = await db.query(
      `select so.shipment_id from public.shipment_orders so join public.orders o on o.id = so.order_id where o.name = $1`,
      [o.name],
    );
    shipmentOf[key as Key] = rows[0].shipment_id;
  }
  const results = await runDetection(jobDeps(), {
    ids: Object.values(shipmentOf),
    budgetMs: 50_000,
  });
  if (results.some((r) => r.result !== 'applied')) throw new Error(JSON.stringify(results));
});

test.afterAll(async () => {
  await cleanUpRun(run, batchId ? [batchId] : []);
  await resetCourierData(db);
  await db.end();
});

const row = (page: import('@playwright/test').Page, k: Key) =>
  page.locator(`tr[data-reference="${ref(k)}"]`);

test('the queue shows carrier, type, office and a green / amber / red chip with the reason', async ({
  openAs,
}) => {
  const page = await openAs(TEST_USERS.owner);
  await page.getByTestId('filter-all').click();

  const sure = row(page, 'sure');
  await expect(sure.getByTestId('carrier-badge')).toHaveText('Еконт');
  await expect(sure.getByTestId('delivery-type')).toContainText('Офис');
  await expect(sure.getByTestId('office-name')).toHaveText('Пловдив Капана');
  await expect(sure.getByTestId('certainty-chip')).toContainText('Сигурно');
  await expect(sure.getByTestId('certainty-chip')).toHaveClass(/badge-ok/);
  await expect(sure.getByTestId('certainty-reason')).not.toBeEmpty();

  const call = row(page, 'call');
  await expect(call.getByTestId('carrier-badge')).toHaveText('Спиди');
  await expect(call.getByTestId('delivery-suggestion')).toContainText('РУСЕ - БУРОВ');
  await expect(call.getByTestId('certainty-chip')).toContainText('Обадете се');
  await expect(call.getByTestId('certainty-chip')).toHaveClass(/badge-warn/);
  await expect(call.getByTestId('certainty-reason')).not.toBeEmpty();

  const error = row(page, 'error');
  await expect(error.getByTestId('certainty-chip')).toContainText('Грешка');
  await expect(error.getByTestId('certainty-chip')).toHaveClass(/badge-error/);
  await expect(error.getByTestId('certainty-reason')).toContainText(/BOX NOW|Еконт и Спиди/);

  // "Обадете се" filter: exactly the shipments that need a call
  await page.getByTestId('filter-call').click();
  await expect(row(page, 'call')).toBeVisible();
  await expect(row(page, 'error')).toBeVisible();
  await expect(row(page, 'sure')).toHaveCount(0);
});

test('a packer calls: "Не вдига" is counted with the time, then "Потвърди предложението"', async ({
  openAs,
}) => {
  const page = await openAs(TEST_USERS.packer);
  await page.getByTestId('filter-call').click();
  await row(page, 'call')
    .getByRole('link', { name: ref('call') })
    .click();

  const card = page.getByTestId('delivery-card');
  await expect(card.getByTestId('certainty-chip')).toContainText('Обадете се');
  const box = card.getByTestId('call-box');
  await expect(box.getByTestId('call-tel')).toHaveAttribute('href', /^tel:\+359887/);
  await expect(box.getByTestId('call-script')).toContainText(
    `Здравейте, обаждам се от HappyHome за поръчка ${ref('call')}.`,
  );
  await expect(box.getByTestId('call-script')).toContainText('РУСЕ - БУРОВ');

  await box.getByTestId('call-no-answer').click();
  await expect(card.getByTestId('delivery-message')).toContainText('не вдигна');
  await expect(box.getByTestId('call-attempts')).toContainText('Не вдигна 1 път');
  await expect(box.getByTestId('call-attempts')).toContainText(TEST_USERS.packer.displayName);

  await box.getByTestId('call-confirm').click();
  await expect(card.getByTestId('certainty-chip')).toContainText('Сигурно');
  await expect(card.getByTestId('delivery-office')).toContainText('РУСЕ - БУРОВ');
  await expect(card.getByTestId('call-box')).toHaveCount(0);
  await expect(page.getByTestId('shipment-status')).toContainText('Готова');
});

test('the owner on an error: Google links for the address, then "Друг офис" from the picker', async ({
  openAs,
}) => {
  const page = await openAs(TEST_USERS.owner);
  await page.goto(`/shipments/${shipmentOf.error}`);
  const card = page.getByTestId('delivery-card');
  await expect(card.getByTestId('certainty-chip')).toContainText('Грешка');
  await expect(card.getByTestId('address-links').getByRole('link').first()).toHaveAttribute(
    'href',
    /^https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=BOX%20NOW/,
  );

  await card.getByTestId('call-other-point').click();
  const picker = card.getByTestId('point-picker');
  await picker.getByTestId('picker-query').fill('Капана');
  await picker.getByRole('button', { name: 'Търси' }).click();
  await picker.getByTestId('picker-results').getByText('Пловдив Капана').waitFor();
  await picker.getByTestId('picker-choose').first().click();

  await expect(card.getByTestId('certainty-chip')).toContainText('Сигурно');
  await expect(card.getByTestId('delivery-office')).toContainText('Пловдив Капана');
  await expect(card.getByTestId('delivery-manual')).toBeVisible();
});

test('"Отказва поръчката" asks for a reason and cancels the shipment', async ({ openAs }) => {
  const page = await openAs(TEST_USERS.owner);
  await page.goto(`/shipments/${shipmentOf.refuse}`);
  const box = page.getByTestId('call-box');
  await box.getByTestId('call-refused').click();
  await expect(box.getByTestId('refuse-confirm')).toBeDisabled();
  await box.getByTestId('refuse-reason').fill('Поръча от друг магазин');
  await box.getByTestId('refuse-confirm').click();
  await expect(page.getByTestId('shipment-status')).toContainText('Отказана');
  await expect(page.getByTestId('call-box')).toHaveCount(0);
});

test('an address correction runs the detection again (P5-18)', async ({ openAs }) => {
  const page = await openAs(TEST_USERS.owner);
  await page.goto(`/shipments/${shipmentOf.edit}`);
  const card = page.getByTestId('delivery-card');
  await expect(card.getByTestId('certainty-chip')).toContainText('Обадете се');

  await card.getByTestId('address-edit').click();
  await card.getByTestId('addr-address1').fill('Еконт офис Капана');
  await card.getByTestId('address-save').click();
  await expect(card.getByTestId('delivery-message')).toContainText('Адресът е записан');
  await expect(card.getByTestId('certainty-chip')).toContainText('Сигурно', { timeout: 20_000 });
  await expect(card.getByTestId('delivery-office')).toContainText('Пловдив Капана');
});

test('the owner sees the Phase 5 settings with the agreed defaults and can save them', async ({
  openAs,
}) => {
  const page = await openAs(TEST_USERS.owner);
  await page.goto('/settings');
  const form = page.getByTestId('delivery-settings');
  await expect(form.getByTestId('office-range')).toHaveValue('1');
  await expect(form.getByTestId('tie-econt')).toBeChecked();
  await form.getByTestId('office-range').fill('abc');
  await form.getByTestId('delivery-settings-save').click();
  await expect(form).toContainText('между 0,1 и 50');
  await form.getByTestId('office-range').fill('1');
  await form.getByTestId('delivery-settings-save').click();
  await expect(form.getByTestId('delivery-settings-saved')).toContainText('Запазено');
});
