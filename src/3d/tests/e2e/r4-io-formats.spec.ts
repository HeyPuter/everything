import { test, expect, type Page } from '@playwright/test';
import { openApp, expectNoErrors, objectNames } from './helpers';

async function fileMenu(page: Page, sub: string) {
  await page.locator('.topbar .tb-menu', { hasText: /^File$/ }).dispatchEvent('pointerdown');
  await page.locator('.popup-layer .menu .mi-label', { hasText: new RegExp(`^${sub}$`) }).hover();
}

const OBJ = 'o Tri\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n';

test('File ▸ Import lists the formats in order and imports through the options dialog', async ({ page }) => {
  const errors = await openApp(page);
  await fileMenu(page, 'Import');
  const labels = await page.locator('.popup-layer .menu').last().locator('.mi-label').allTextContents();
  const idx = (s: string) => labels.findIndex((l) => l.startsWith(s));
  expect(idx('Alembic')).toBeGreaterThanOrEqual(0);
  expect(idx('Alembic')).toBeLessThan(idx('Universal Scene'));
  expect(idx('Wavefront')).toBeLessThan(idx('Stanford PLY'));
  expect(idx('STL')).toBeLessThan(idx('FBX'));
  expect(idx('FBX')).toBeLessThan(idx('glTF'));
  const chooser = page.waitForEvent('filechooser');
  await page.locator('.popup-layer .menu .mi-label', { hasText: /^Wavefront/ }).last().click();
  await (await chooser).setFiles({ name: 'tri.obj', mimeType: 'text/plain', buffer: Buffer.from(OBJ) });
  const dlg = page.locator('.io-dialog');
  await expect(dlg).toBeVisible();
  await expect(dlg.locator('.pop-title')).toHaveText('Import Wavefront OBJ');
  await dlg.locator('button', { hasText: /^Import$/ }).click();
  await expect.poll(() => objectNames(page)).toContain('Tri');
  // the import is one undo step
  const undo = await page.evaluate(() => (window as unknown as { app: { undo: { history: { label: string }[] } } }).app.undo.history.map((s) => s.label));
  expect(undo.at(-1)).toBe('Import Wavefront OBJ');
  await expectNoErrors(errors);
});

test('File ▸ Export downloads the file the options ask for', async ({ page }) => {
  const errors = await openApp(page);
  await fileMenu(page, 'Export');
  await page.locator('.popup-layer .menu .mi-label', { hasText: /^STL/ }).last().click();
  const dlg = page.locator('.io-dialog');
  await expect(dlg).toBeVisible();
  await expect(dlg.getByLabel('Selected Only')).toBeVisible();
  await dlg.getByLabel('ASCII').check();
  const dl = page.waitForEvent('download');
  await dlg.locator('button', { hasText: /^Export$/ }).click();
  const d = await dl;
  expect(d.suggestedFilename()).toMatch(/\.stl$/);
  const text = await (await d.createReadStream()).toArray().then((c) => Buffer.concat(c).toString('utf8'));
  expect(text).toMatch(/^solid/);
  expect(text.match(/facet normal/g)?.length).toBe(12);
  await expectNoErrors(errors);
});

test('dropping a model file imports it with its format operator', async ({ page }) => {
  const errors = await openApp(page);
  await page.evaluate(async (src) => {
    const w = window as unknown as { app: { run(id: string, p?: object): string } };
    const dt = new DataTransfer();
    dt.items.add(new File([src], 'drop.obj', { type: 'text/plain' }));
    const canvas = document.querySelector('.view3d') as HTMLElement;
    canvas.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
    canvas.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    void w;
  }, OBJ.replace('Tri', 'Dropped'));
  const dlg = page.locator('.io-dialog');
  await expect(dlg).toBeVisible();
  await dlg.locator('button', { hasText: /^Import$/ }).click();
  await expect.poll(() => objectNames(page)).toContain('Dropped');
  await expectNoErrors(errors);
});

test('Collection ▸ Exporters: add an exporter, edit it and export the collection', async ({ page }) => {
  const errors = await openApp(page);
  await page.locator('.rail-tab[data-tab="COLLECTION"]').click();
  const head = page.getByText('Exporters', { exact: true }).first();
  await head.click();
  const list = page.locator('.uilist[data-list^="colex-"]');
  await expect(list).toBeVisible();
  await list.locator('.ul-side .icon-btn').first().click();
  await page.locator('.popup-layer .menu .mi-label', { hasText: /^STL$/ }).click();
  await expect(list.locator('.ul-label')).toHaveText(['STL']);
  // the exporter's settings are shown below the list
  await expect(page.getByText('ASCII', { exact: true })).toBeVisible();
  const dl = page.waitForEvent('download');
  await page.locator('button', { hasText: 'Export All' }).click();
  expect((await dl).suggestedFilename()).toBe('Collection.stl');
  await expectNoErrors(errors);
});

test('File menu has Data Previews and Export All Collections', async ({ page }) => {
  const errors = await openApp(page);
  await fileMenu(page, 'Data Previews');
  await expect(page.locator('.popup-layer .menu .mi-label', { hasText: 'Refresh Data-Block Previews' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.locator('.topbar .tb-menu', { hasText: /^File$/ }).dispatchEvent('pointerdown');
  await expect(page.locator('.popup-layer .menu .mi-label', { hasText: 'Export All Collections' })).toBeVisible();
  await expectNoErrors(errors);
});
