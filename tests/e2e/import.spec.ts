/**
 * Phase 2 screens, end to end: import (P2-14, T2-03), owner-only (T2-07), the column
 * chooser (P2-10 … P2-13, T2-08) and the raw CSV archive (P2-16 … P2-22, T2-09 … T2-11).
 * Every order name and file is unique to the run; everything is removed afterwards.
 */
import { columnHeader, DEFAULT_VISIBLE_COLUMNS, sha256Hex } from '@happyhome/core/import';
import type { Download, Page } from '@playwright/test';
import { adminClient, signedInClient } from '../support/clients';
import { ageBatch, cleanUpRun, csvOf, postImport, runOrders } from '../support/imports';
import { uniq } from '../support/schema';
import { TEST_USERS } from '../support/users';
import { expect, signIn, test } from './helpers';

const newRun = (prefix: string) =>
  uniq(prefix)
    .replace(/[^a-z0-9]/gi, '')
    .slice(-10);

async function importViaApi(name: string, bytes: Uint8Array): Promise<string> {
  const owner = await signedInClient(TEST_USERS.owner.email, TEST_USERS.owner.password);
  const res = await postImport(owner, name, bytes);
  if (res.status !== 200) throw new Error(JSON.stringify(res.body));
  return res.body.result!.batch_id;
}

async function downloadBytes(download: Download): Promise<Uint8Array> {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return new Uint8Array(Buffer.concat(chunks));
}

/** Entries of a "stored" (uncompressed) ZIP, as written by core/zip. */
function unzipStored(bytes: Uint8Array): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = 0;
  while (p + 30 <= bytes.length && view.getUint32(p, true) === 0x04034b50) {
    const size = view.getUint32(p + 18, true);
    const nameLength = view.getUint16(p + 26, true);
    const extraLength = view.getUint16(p + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 30, p + 30 + nameLength));
    const start = p + 30 + nameLength + extraLength;
    out.set(name, bytes.subarray(start, start + size));
    p = start + size;
  }
  return out;
}

/** The heading row of the Shipping sheet. */
function xlsxHeadings(bytes: Uint8Array): string[] {
  const files = unzipStored(bytes);
  const text = (name: string) => new TextDecoder().decode(files.get(name));
  const unescape = (s: string) =>
    s
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&');
  const strings = [...text('xl/sharedStrings.xml').matchAll(/<si><t[^>]*>(.*?)<\/t><\/si>/gs)].map(
    (m) => unescape(m[1]!),
  );
  const firstRow = /<row r="1"[^>]*>(.*?)<\/row>/s.exec(text('xl/worksheets/sheet1.xml'))![1]!;
  return [...firstRow.matchAll(/<c r="[A-Z]+1"[^>]*t="s"><v>(\d+)<\/v><\/c>/g)].map(
    (m) => strings[Number(m[1])]!,
  );
}

async function tableHeadings(page: Page): Promise<string[]> {
  const table = page.getByTestId('batch-table');
  await expect(table).toBeVisible();
  return table
    .locator('thead th[data-column]')
    .evaluateAll((ths) => ths.map((th) => th.getAttribute('data-column') ?? ''));
}

test.describe('import screen', () => {
  const run = newRun('ui');
  const batchIds: string[] = [];
  test.afterAll(async () => cleanUpRun(run, batchIds));

  test('the owner drops in a Shopify export, sees the Bulgarian summary, and the same file again is refused', async ({
    openAs,
  }) => {
    const O = runOrders(run);
    const bytes = csvOf([O.o2001, O.o2002, O.o2003]);
    const file = {
      name: `orders_export_${run}.csv`,
      mimeType: 'text/csv',
      buffer: Buffer.from(bytes),
    };

    const page = await openAs(TEST_USERS.owner);
    await page
      .getByRole('navigation', { name: 'Основно меню' })
      .getByRole('link', { name: 'Внасяне' })
      .click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Внасяне на поръчки');
    await expect(page.getByTestId('dropzone')).toBeVisible();

    await page.getByTestId('file-input').setInputFiles(file);
    const done = page.getByTestId('import-done');
    await expect(done).toBeVisible({ timeout: 20_000 });
    await expect(done.getByTestId('import-summary')).toHaveText(/^3 нови поръчки/);

    const card = page.getByTestId('import-card').filter({ has: done });
    const href = await card.getByRole('link').getAttribute('href');
    const batchId = href!.split('/').pop()!;
    batchIds.push(batchId);

    // The history lists the file with its counts.
    await expect(page.getByTestId('batch-history')).toContainText(file.name);

    // T2-03 (screen): the very same file again -> a clear Bulgarian message, nothing changed.
    await page.getByTestId('file-input').setInputFiles(file);
    await expect(page.getByTestId('import-duplicate')).toContainText('Този файл вече е внесен');
    await expect(page.getByTestId('import-duplicate')).toContainText(file.name);
    const { count } = await adminClient()
      .from('import_batches')
      .select('id', { count: 'exact', head: true })
      .eq('sha256', await sha256Hex(bytes));
    expect(count).toBe(1);

    // The batch view: the legacy 18 columns + photo, one table row per product row.
    await card.getByRole('link').click();
    await expect(page.getByTestId('batch-title')).toContainText(file.name);
    expect(await tableHeadings(page)).toEqual([...DEFAULT_VISIBLE_COLUMNS]);
    await expect(
      page.getByTestId('batch-table').locator('tbody tr[data-order]').first(),
    ).toBeVisible();
    for (const o of [O.o2001, O.o2002, O.o2003]) {
      await expect(page.locator(`tr[data-order="${o.name}"]`).first()).toBeVisible();
    }

    // "Изтегли Excel": the legacy workbook with the same columns.
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('download-excel').click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^shipping-orders-.*\.xlsx$/);
    expect(xlsxHeadings(await downloadBytes(download))).toEqual(
      DEFAULT_VISIBLE_COLUMNS.map(columnHeader),
    );

    // "Изтегли CSV": the original bytes, untouched.
    const [csv] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('download-csv').click(),
    ]);
    expect(await sha256Hex(await downloadBytes(csv))).toBe(await sha256Hex(bytes));
  });

  test('packers do not see or use the import, and cannot change settings', async ({ openAs }) => {
    const page = await openAs(TEST_USERS.packer);
    const nav = page.getByRole('navigation', { name: 'Основно меню' });
    await expect(nav.getByRole('link', { name: 'Пратки' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Внасяне' })).toHaveCount(0);

    await page.goto('/import');
    await expect(page.getByTestId('import-owner-only')).toBeVisible();
    await expect(page.getByTestId('dropzone')).toHaveCount(0);

    await page.goto('/settings');
    await expect(page.getByTestId('settings-owner-only')).toBeVisible();
    await expect(page.getByTestId('column-list')).toHaveCount(0);
    await expect(page.getByTestId('archive-banner')).toHaveCount(0);
  });
});

test.describe('column chooser', () => {
  const run = newRun('col');
  const batchIds: string[] = [];
  let saved: { key: string; value: unknown }[] = [];

  test.beforeAll(async () => {
    const { data } = await adminClient()
      .from('settings')
      .select('key, value')
      .in('key', ['visible_columns', 'hidden_columns']);
    saved = data ?? [];
  });
  test.afterAll(async () => {
    const admin = adminClient();
    for (const s of saved)
      await admin
        .from('settings')
        .update({ value: s.value as never })
        .eq('key', s.key);
    await cleanUpRun(run, batchIds);
  });

  test('hiding, adding and reordering columns changes the batch view and the Excel file only', async ({
    openAs,
  }) => {
    const O = runOrders(run);
    const batchId = await importViaApi(`columns_${run}.csv`, csvOf([O.o2001, O.o2002]));
    batchIds.push(batchId);

    const page = await openAs(TEST_USERS.owner);
    await page.goto('/settings');
    const list = page.getByTestId('column-list');
    await expect(list.locator('li[data-column="Tags"]')).toBeVisible(); // every column found (P2-10)
    // Nothing hidden by default (P2-11): all default columns ticked.
    for (const c of DEFAULT_VISIBLE_COLUMNS)
      await expect(page.getByLabel(`Показвай ${c}`, { exact: true })).toBeChecked();

    await page.getByLabel('Показвай Email', { exact: true }).uncheck();
    await page.getByLabel('Показвай Tags', { exact: true }).check();
    // Drag "Tags" onto "Name" (HTML5 drag and drop) ...
    // (Start the drag before the long list scrolls, so the browser picks up the right row.)
    const tags = list.locator('li[data-column="Tags"]');
    await tags.hover();
    await page.mouse.down();
    const box = (await tags.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2 + 5, box.y + box.height / 2 + 5);
    await list.locator('li[data-column="Name"]').hover();
    await page.mouse.up();
    // ... and move "Total" up one place with the arrow button.
    await page.getByRole('button', { name: 'Премести Total нагоре' }).click();
    await page.getByTestId('save-columns').click();
    await expect(page.getByTestId('columns-saved')).toBeVisible();

    const base = DEFAULT_VISIBLE_COLUMNS.filter((c) => c !== 'Email');
    const expected = [base[0]!, 'Tags', ...base.slice(1)];
    const t = expected.indexOf('Total');
    [expected[t - 1], expected[t]] = [expected[t]!, expected[t - 1]!];

    const { data: setting } = await adminClient()
      .from('settings')
      .select('value')
      .eq('key', 'visible_columns')
      .single();
    expect(setting!.value).toEqual(expected);

    await page.goto(`/import/${batchId}`);
    expect(await tableHeadings(page)).toEqual(expected);
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('download-excel').click(),
    ]);
    expect(xlsxHeadings(await downloadBytes(download))).toEqual(expected.map(columnHeader));

    // The data itself is untouched (P2-12): the order still has its email.
    const { data: order } = await adminClient()
      .from('orders')
      .select('email')
      .eq('name', O.o2001.name)
      .single();
    expect(order!.email).toBeTruthy();
  });
});

test.describe('raw CSV archive', () => {
  const run = newRun('arc');
  const batchIds: string[] = [];
  test.afterAll(async () => cleanUpRun(run, batchIds));

  test('a file past the retention days waits, then is saved to the chosen folder, checked, and only then deleted', async ({
    newComputer,
  }) => {
    const O = runOrders(run);
    const name = `archive_${run}.csv`;
    const bytes = csvOf([O.o2003]);
    const batchId = await importViaApi(name, bytes);
    batchIds.push(batchId);
    await ageBatch(batchId, 100);

    const context = await newComputer();
    // Stand-in for the folder picker: the browser's private file system (same API as a real folder).
    await context.addInitScript(() => {
      (
        window as { showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle> }
      ).showDirectoryPicker = async () =>
        (await navigator.storage.getDirectory()).getDirectoryHandle('csv-archive', {
          create: true,
        });
    });
    const page = await context.newPage();
    await signIn(page, TEST_USERS.owner);

    // P2-21: the banner, because no folder is chosen on this computer yet.
    const banner = page.getByTestId('archive-banner');
    await expect(banner).toContainText(/CSV файла? чака/);
    const admin = adminClient();
    const { data: waiting } = await admin
      .from('import_batches')
      .select('archive_state, storage_path, raw_deleted_at')
      .eq('id', batchId)
      .single();
    expect(waiting).toMatchObject({ archive_state: 'waiting', raw_deleted_at: null });

    await banner.getByRole('link', { name: 'Към архива' }).click();
    await expect(page).toHaveURL(/\/settings#archive$/);
    await expect(page.getByTestId('archive-folder')).toHaveText(
      'Още не е избрана папка на този компютър.',
    );
    await page.getByTestId('choose-folder').click();

    await expect(page.getByTestId('archive-settings')).toContainText(`Запазен: `);
    await expect(page.getByTestId('archive-settings')).toContainText(name);
    await expect(page.getByTestId('archive-folder')).toHaveText('Папка: csv-archive');
    await expect(banner).toHaveCount(0);

    const { data: archived } = await admin
      .from('import_batches')
      .select(
        'archive_state, archive_method, archived_path, archived_on, raw_deleted_at, storage_path',
      )
      .eq('id', batchId)
      .single();
    expect(archived).toMatchObject({ archive_state: 'archived', archive_method: 'folder' });
    expect(archived!.raw_deleted_at).not.toBeNull();
    expect(archived!.archived_path).toMatch(
      new RegExp(`^\\d{4}/\\d{4}-\\d{2}-\\d{2}_archive_${run}\\.csv$`),
    );
    const { data: gone } = await admin.storage
      .from('raw-imports')
      .list(waiting!.storage_path!.split('/')[0], { search: waiting!.storage_path!.split('/')[1] });
    expect(gone ?? []).toHaveLength(0);

    // The copy in the folder is byte-identical to the imported file.
    const copy = await page.evaluate(async (path) => {
      let dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('csv-archive');
      const parts = path.split('/');
      for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p);
      const file = await (await dir.getFileHandle(parts.at(-1)!)).getFile();
      return Array.from(new Uint8Array(await file.arrayBuffer()));
    }, archived!.archived_path!);
    expect(await sha256Hex(new Uint8Array(copy))).toBe(await sha256Hex(bytes));

    // The batch keeps its history; the CSV can no longer be downloaded from the cloud.
    await page.goto(`/import/${batchId}`);
    await expect(page.getByTestId('batch-archive-state')).toContainText(archived!.archived_path!);
    await expect(page.getByTestId('download-csv')).toBeDisabled();
  });

  test('without folder access (Firefox, Safari) the owner downloads a ZIP and confirms "Свалих ги"', async ({
    newComputer,
  }) => {
    const O = runOrders(run);
    const name = `zip_${run}.csv`;
    const bytes = csvOf([O.o2004]);
    const batchId = await importViaApi(name, bytes);
    batchIds.push(batchId);
    await ageBatch(batchId, 100);

    const context = await newComputer();
    await context.addInitScript(() => {
      Object.defineProperty(window, 'showDirectoryPicker', {
        value: undefined,
        configurable: true,
        writable: true,
      });
    });
    const page = await context.newPage();
    await signIn(page, TEST_USERS.owner);
    await expect(page.getByTestId('archive-banner')).toBeVisible();
    await page.goto('/settings#archive');
    await expect(page.getByTestId('archive-settings')).toContainText(
      'Изтеглете файловете като ZIP',
    );

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Изтегли ZIP' }).click(),
    ]);
    const entries = unzipStored(await downloadBytes(download));
    const entry = [...entries.entries()].find(([path]) => path.endsWith(`_zip_${run}.csv`));
    expect(entry).toBeTruthy();
    expect(await sha256Hex(entry![1])).toBe(await sha256Hex(bytes));

    // Nothing is deleted until the owner says the files are saved.
    const admin = adminClient();
    const before = await admin
      .from('import_batches')
      .select('archive_state')
      .eq('id', batchId)
      .single();
    expect(before.data!.archive_state).toBe('waiting');

    await page.getByRole('button', { name: 'Свалих ги' }).click();
    await expect(page.getByTestId('archive-settings')).toContainText(`_zip_${run}.csv`);
    await expect(page.getByTestId('archive-waiting')).toHaveText(
      'Няма файлове, които чакат архивиране.',
    );
    await expect(page.getByTestId('archive-banner')).toHaveCount(0);
    const { data: after } = await admin
      .from('import_batches')
      .select('archive_state, archive_method, raw_deleted_at')
      .eq('id', batchId)
      .single();
    expect(after).toMatchObject({ archive_state: 'archived', archive_method: 'zip' });
    expect(after!.raw_deleted_at).not.toBeNull();
  });
});
