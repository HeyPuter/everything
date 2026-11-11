import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
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

test('dropping several model files asks for their options one at a time', async ({ page }) => {
  const errors = await openApp(page);
  await page.evaluate(async (src) => {
    const dt = new DataTransfer();
    dt.items.add(new File([src.replace('Tri', 'First')], 'first.obj', { type: 'text/plain' }));
    dt.items.add(new File([src.replace('Tri', 'Second')], 'second.obj', { type: 'text/plain' }));
    const canvas = document.querySelector('.view3d') as HTMLElement;
    canvas.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
    canvas.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, OBJ);
  const dlg = page.locator('.io-dialog');
  await expect(dlg).toHaveCount(1);
  // Escape skips the first file only; the second one's dialog follows
  await page.keyboard.press('Escape');
  await expect(dlg).toHaveCount(1);
  await dlg.locator('button', { hasText: /^Import$/ }).click();
  await expect.poll(() => objectNames(page)).toContain('Second');
  await expect(dlg).toHaveCount(0);
  expect(await objectNames(page)).not.toContain('First');
  await expectNoErrors(errors);
});

test('companion files picked for one model are not reused for another model with the same names', async ({ page }, info) => {
  const errors = await openApp(page);
  const obj = (name: string) => Buffer.from(`mtllib mat.mtl\no ${name}\nusemtl Mat\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n`);
  // files on disk (a re-picked file is the same file)
  const onDisk = (name: string, data: Buffer) => {
    const p = info.outputPath(name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, data);
    return p;
  };
  const aObj = onDisk('a.obj', obj('First'));
  const importObj = async (files: string[]) => {
    const chooser = page.waitForEvent('filechooser');
    await page.evaluate(() => (window as any).app.run('wm.obj_import', {}, { invoke: true })); // eslint-disable-line @typescript-eslint/no-explicit-any
    await (await chooser).setFiles(files);
    await page.locator('.io-dialog button', { hasText: /^Import$/ }).click();
  };
  // the model and its material library picked together
  await importObj([aObj, onDisk('mat.mtl', Buffer.from('newmtl Mat\nKd 1 0 0\n'))]);
  await expect.poll(() => objectNames(page)).toContain('First');
  // another model (from elsewhere) using a library of the same name: it is asked for, not taken from the first import
  const chooser = page.waitForEvent('filechooser');
  await page.evaluate(() => (window as any).app.run('wm.obj_import', {}, { invoke: true })); // eslint-disable-line @typescript-eslint/no-explicit-any
  await (await chooser).setFiles([{ name: 'b.obj', mimeType: 'text/plain', buffer: obj('Second') }]);
  await page.locator('.io-dialog button', { hasText: /^Import$/ }).click();
  const ask = page.locator('.io-dialog', { hasText: 'material libraries' });
  await expect(ask).toBeVisible();
  await ask.locator('button', { hasText: 'Skip' }).click();
  await expect.poll(() => objectNames(page)).toContain('Second');
  const reports = await page.evaluate(() => (window as any).app.reports.map((r: any) => r.message).join('\n')); // eslint-disable-line @typescript-eslint/no-explicit-any
  expect(reports).toMatch(/mat\.mtl/);
  // the first model again: its library is known, nothing is asked
  await importObj([aObj]);
  await expect(page.locator('.io-dialog')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => Object.values((window as any).app.doc.objects).filter((o: any) => o.name.startsWith('First')).length)).toBe(2); // eslint-disable-line @typescript-eslint/no-explicit-any
  await expectNoErrors(errors);
});

test('a model dropped together with its material library uses it', async ({ page }) => {
  const errors = await openApp(page);
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['mtllib mat.mtl\no Dropped\nusemtl Mat\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n'], 'a.obj'));
    dt.items.add(new File(['newmtl Mat\nKd 1 0 0\n'], 'mat.mtl'));
    const canvas = document.querySelector('.view3d') as HTMLElement;
    canvas.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
    canvas.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  const dlg = page.locator('.io-dialog');
  await expect(dlg).toHaveCount(1);
  await dlg.locator('button', { hasText: /^Import$/ }).click();
  await expect.poll(() => objectNames(page)).toContain('Dropped');
  // the library was not asked for again, and was not "imported" on its own
  await expect(dlg).toHaveCount(0);
  const reports = await page.evaluate(() => (window as any).app.reports.map((r: any) => `${r.type} ${r.message}`)); // eslint-disable-line @typescript-eslint/no-explicit-any
  expect(reports.filter((r: string) => r.startsWith('ERROR') || /not provided|not found/.test(r))).toEqual([]);
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

test('File ▸ External Data entries all have working operators', async ({ page }) => {
  const errors = await openApp(page);
  const missing = await page.evaluate(() => {
    const a = (window as unknown as { app: { poll(id: string): boolean } }).app;
    // operators without a context requirement (registered and runnable in a fresh file)
    const ops = ['file.autopack_toggle', 'file.pack_all', 'file.make_paths_relative', 'file.make_paths_absolute', 'file.report_missing_files', 'wm.previews_ensure', 'wm.previews_clear', 'wm.previews_batch_generate', 'wm.previews_batch_clear'];
    return ops.filter((id) => !a.poll(id));
  });
  expect(missing).toEqual([]);
  await fileMenu(page, 'External Data');
  await page.locator('.popup-layer .menu .mi-label', { hasText: /^Automatically Pack Resources$/ }).click();
  expect(await page.evaluate(() => (window as unknown as { app: { doc: { use_autopack?: boolean } } }).app.doc.use_autopack)).toBe(true);
  await expectNoErrors(errors);
});
