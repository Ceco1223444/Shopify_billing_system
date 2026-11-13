/**
 * Phase 4 owner screen, end to end: counts and last sync per courier (P4-26), the red banner
 * when a courier's list did not update (P4-10, T4-05 on screen), the map of one town (P4-27),
 * the "Обнови офисите" button and the search. Packers see none of it.
 *
 * The points and runs are written straight into the local database. Map tiles and the sync
 * call are intercepted: no request leaves the computer.
 */
import type pg from 'pg';
import type { Page } from '@playwright/test';
import { pgClient, resetCourierData } from '../support/couriers';
import { TEST_USERS } from '../support/users';
import { expect, test } from './helpers';

/** A 1×1 transparent PNG for every map tile. */
const TILE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

async function offlineTiles(page: Page) {
  await page.route('https://tile.openstreetmap.org/**', (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: TILE }),
  );
}

let db: pg.Client;

const POINTS = [
  // carrier, id, type, name, city, postcode, address, lat, lng
  [
    'econt',
    'E1',
    'office',
    'Пловдив Капана',
    'Пловдив',
    '4000',
    'ул. Райко Даскалов 34',
    42.1497,
    24.7503,
  ],
  [
    'econt',
    'E2',
    'locker',
    'Еконтомат Тракия',
    'Пловдив',
    '4023',
    'ж.к. Тракия бл. 30',
    42.1352,
    24.7895,
  ],
  ['speedy', 'S1', 'office', 'ПЛОВДИВ - ОФИС', 'Пловдив', null, 'бул. Руски 6', 42.1466, 24.7488],
  [
    'speedy',
    'S2',
    'locker',
    'ПЛОВДИВ - ТРАКИЯ (АВТОМАТ)',
    'Пловдив',
    null,
    'жк Тракия бл. 148',
    null,
    null,
  ],
  [
    'speedy',
    'S3',
    'office',
    'СОФИЯ - ЦЕНТЪР',
    'София',
    null,
    'ул. Граф Игнатиев 10',
    42.6915,
    23.3258,
  ],
] as const;

test.describe('courier offices screen', () => {
  test.beforeAll(async () => {
    db = await pgClient();
    await resetCourierData(db);
    for (const [carrier, id, type, name, city, postcode, address, lat, lng] of POINTS) {
      await db.query(
        `insert into public.courier_offices
           (carrier, external_id, type, name_bg, city, postcode, address_text, lat, lng, source, coord_source)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'test', case when $8::float8 is null then null else 'courier' end)`,
        [carrier, id, type, name, city, postcode, address, lat, lng],
      );
    }
    // Econt fine; Speedy: a good run a week ago, then a failed one (the list could not be read).
    await db.query(`
      insert into public.courier_sync_runs
        (carrier, trigger, source, status, stage, started_at, finished_at, fetched, inserted, updated, deactivated, error_code, error_message)
      values
        ('econt', 'cron', 'econt_api', 'ok', 'done', now() - interval '3 hours', now() - interval '3 hours', 2, 2, 0, 0, null, null),
        ('speedy', 'cron', 'speedy_public_list', 'ok', 'done', now() - interval '8 days', now() - interval '8 days', 3, 3, 0, 0, null, null),
        ('speedy', 'cron', 'speedy_public_list', 'failed', 'fetch', now() - interval '1 day', now() - interval '1 day', null, 0, 0, 0, 'parse_failed', 'test')`);
  });

  test.afterAll(async () => {
    await resetCourierData(db);
    await db.end();
  });

  test('the owner sees the banner, the counts, the error and the map of one town', async ({
    openAs,
  }) => {
    const page = await openAs(TEST_USERS.owner);
    await offlineTiles(page);

    // P4-10 / T4-05: the red banner on every screen, with a link to the details.
    const banner = page.getByTestId('courier-sync-banner');
    await expect(banner).toContainText('Списъкът с офиси на Спиди не се обнови');
    await expect(banner).not.toContainText('Еконт');
    await banner.getByRole('link', { name: 'Подробности' }).click();
    await expect(page).toHaveURL(/\/offices$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Офиси и автомати');
    await expect(banner.getByRole('link')).toHaveCount(0);

    // P4-26: counts per courier and type, last sync, the error.
    const econt = page.getByTestId('offices-card-econt');
    await expect(econt.getByTestId('offices-counts-econt')).toContainText('1 офис');
    await expect(econt.getByTestId('offices-counts-econt')).toContainText('1 автомат');
    await expect(econt.getByTestId('offices-status-econt')).toHaveText(/Обновен/);
    await expect(econt.getByTestId('offices-last-ok-econt')).toContainText('Последно обновяване:');
    const speedy = page.getByTestId('offices-card-speedy');
    await expect(speedy.getByTestId('offices-counts-speedy')).toContainText('2 офиса');
    await expect(speedy).toContainText('На картата: 2 от 3');
    await expect(speedy.getByTestId('offices-status-speedy')).toHaveText(/Не се обнови/);
    await expect(speedy.getByTestId('offices-error-speedy')).toContainText('не можа да се прочете');
    await expect(speedy.getByTestId('offices-error-speedy')).toContainText(
      'Старият списък продължава да се използва.',
    );

    // P4-27: Plovdiv by default; the point without coordinates is listed, not drawn.
    await expect(page.getByTestId('offices-map-count')).toContainText('4 точки в Пловдив');
    await expect(page.getByTestId('offices-map-count')).toContainText('1 точка няма координати');
    const map = page.getByTestId('office-map');
    await expect(map.locator('.leaflet-marker-icon')).toHaveCount(3);
    await expect(map.locator('.map-pin-econt.map-pin-locker')).toHaveText('Е');
    await expect(map.locator('.map-pin-speedy.map-pin-office')).toHaveText('С');
    await expect(map.locator('.leaflet-control-attribution')).toContainText('OpenStreetMap');
    await map.locator('.map-pin-econt.map-pin-office').click();
    await expect(map.locator('.leaflet-popup-content')).toContainText('Пловдив Капана');
    await expect(map.locator('.leaflet-popup-content')).toContainText('Еконт · Офис');

    // Another town, by name.
    await page.getByLabel('Град или пощенски код').fill('гр. София');
    await page.getByRole('button', { name: 'Покажи', exact: true }).click();
    await expect(page.getByTestId('offices-map-count')).toContainText('1 точка в гр. София');
    await expect(map.locator('.leaflet-marker-icon')).toHaveCount(1);
  });

  test('search finds a point in Latin and shows its town on the map', async ({ openAs }) => {
    const page = await openAs(TEST_USERS.owner);
    await offlineTiles(page);
    await page.goto('/offices');
    await page.getByRole('button', { name: 'София', exact: true }).click();
    await expect(page.getByTestId('offices-map-count')).toContainText('1 точка в София');

    await page.getByLabel('Име или адрес').fill('ekontomat trakia');
    await page.getByRole('button', { name: 'Търси' }).click();
    const results = page.getByTestId('offices-search-results');
    const row = results.getByTestId('office-row').filter({ hasText: 'Еконтомат Тракия' });
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'Покажи на картата' }).click();
    await expect(page.getByTestId('offices-map-count')).toContainText('4 точки в Пловдив');
    await expect(page.getByLabel('Град или пощенски код')).toHaveValue('Пловдив');
  });

  test('"Обнови офисите" starts the update for both couriers', async ({ openAs }) => {
    const page = await openAs(TEST_USERS.owner);
    await offlineTiles(page);
    let body: unknown = null;
    // The real call would fetch the couriers' lists: answer it here.
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
    };
    await page.route('**/functions/v1/courier-sync', async (route) => {
      if (route.request().method() === 'OPTIONS') {
        return route.fulfill({ status: 204, headers: cors });
      }
      body = route.request().postDataJSON();
      return route.fulfill({
        status: 202,
        headers: cors,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, runs: [] }),
      });
    });
    await page.goto('/offices');
    await page.getByRole('button', { name: 'Обнови офисите' }).click();
    await expect(page.getByText('Обновяването започна.')).toBeVisible();
    expect(body).toEqual({ action: 'start' });
  });

  test('a packer has no offices screen and no banner', async ({ openAs }) => {
    const page = await openAs(TEST_USERS.packer);
    await expect(page.getByRole('navigation').getByRole('link', { name: /Офиси/ })).toHaveCount(0);
    await page.goto('/offices');
    await expect(page.getByTestId('offices-owner-only')).toContainText(
      'Само собственикът вижда и обновява списъка с офиси.',
    );
    await expect(page.getByTestId('courier-sync-banner')).toHaveCount(0);
    await expect(page.getByTestId('office-map')).toHaveCount(0);
  });
});
