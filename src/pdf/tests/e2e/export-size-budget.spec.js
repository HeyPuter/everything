import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { protectPdf, unlockPdf } from '../../src/core/security.js';
import { readFile } from 'node:fs/promises';

const ERROR =
  'This export would exceed the 100 MB PDF limit. Reduce file size before saving or downloading.';
async function setup(page, limit) {
  await page.route('https://js.puter.com/**', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: `window.exportWrites = 0; window.exportPickers = 0;
    window.puter = {env:'web', auth:{isSignedIn:()=>true,getUser:async()=>({username:'test-user'}),signIn:async()=>{},signOut:async()=>{}},
    fs:{readdir:async()=>[],write:async()=>{window.exportWrites++;return {path:'PDFs/saved.pdf'};}},
    ui:{onLaunchedWithItems:()=>{},onItemsOpened:()=>{},showSaveFilePicker:async()=>{window.exportPickers++;return {path:'PDFs/chosen.pdf'};}}};`,
    }),
  );
  if (limit)
    await page.route('**/src/core/file-limits.js', async (route) => {
      const response = await route.fetch();
      const body = await response.text();
      expect(body).toContain('const MAX_FILE_SIZE = 100 * 1024 * 1024;');
      // Exercise real encryption and every export path with a small resource budget.
      // A separate case below verifies the production 100 MB limit with a real large PDF.
      await route.fulfill({
        response,
        body: body.replace(
          'const MAX_FILE_SIZE = 100 * 1024 * 1024;',
          `const MAX_FILE_SIZE = ${limit};`,
        ),
      });
    });
  await page.goto('/');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
}
async function menu(page, name) {
  const bar = page.getByRole('menubar', { name: 'PDF menus' });
  const item = page.getByRole('menu').getByRole('menuitem', { name, exact: true });
  if (await bar.isVisible()) {
    for (const title of ['File', 'Page']) {
      await bar.getByRole('menuitem', { name: title, exact: true }).click();
      if (await item.count()) return item.click();
      await page.keyboard.press('Escape');
    }
  } else {
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    if (await item.count()) return item.click();
    await page.getByRole('menu').getByRole('menuitem', { name: 'Page', exact: true }).click();
    if (await item.count()) return item.click();
  }
  throw new Error(`Missing menu item ${name}`);
}
async function protect(page) {
  await menu(page, 'Protect with password…');
  const dialog = page.getByRole('dialog', { name: 'Protect with password', exact: true });
  await dialog.getByLabel('Password to open', { exact: true }).fill('secret');
  await dialog.getByLabel('Confirm password', { exact: true }).fill('secret');
  await dialog.getByRole('button', { name: 'Protect', exact: true }).click();
  await expect(dialog).toBeHidden();
}
async function choose(page, bytes) {
  const pending = page.waitForEvent('filechooser');
  await page.keyboard.press('ControlOrMeta+o');
  await (
    await pending
  ).setFiles({ name: 'original.pdf', mimeType: 'application/pdf', buffer: Buffer.from(bytes) });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 2');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
}
async function exportAction(page, action) {
  if (action === 'download')
    return page.getByRole('button', { name: 'Download', exact: true }).click();
  if (action === 'save')
    return page.getByRole('button', { name: 'Save to Puter', exact: true }).click();
  if (action === 'copy') return menu(page, 'Save a copy to Puter');
  if (action === 'picker') return menu(page, 'Save to another Puter folder…');
  if (action === 'page') {
    if (!(await page.locator('#page-sidebar').isVisible()))
      await page.getByRole('button', { name: 'Toggle pages panel', exact: true }).click();
    await page.locator('.thumb-item').nth(1).hover();
    await page.getByRole('button', { name: 'Page 2 actions', exact: true }).click();
    return page.getByRole('menuitem', { name: 'Extract this page', exact: true }).click();
  }
  const split = action === 'split';
  await menu(page, split ? 'Split PDF…' : 'Extract pages…');
  return page
    .getByRole('dialog', { name: split ? 'Split PDF' : 'Extract pages', exact: true })
    .getByRole('button', { name: split ? 'Download ZIP' : 'Download pages', exact: true })
    .click();
}
async function twoPages() {
  const doc = await PDFDocument.create();
  doc.addPage([300, 400]);
  doc.addPage([300, 400]);
  return doc.save();
}

for (const action of ['download', 'save', 'copy', 'picker', 'extract', 'page', 'split'])
  test(`${action} rejects an oversized protected export and can retry after removing protection`, async ({
    page,
  }) => {
    const downloads = [],
      errors = [];
    page.on('download', (download) => downloads.push(download));
    page.on('pageerror', (error) => errors.push(error.message));
    await setup(page, 1024);
    await choose(page, await twoPages());
    await protect(page);
    await exportAction(page, action);
    const error =
      action === 'extract'
        ? page.getByRole('dialog', { name: 'Extract pages', exact: true }).getByRole('alert')
        : page.locator('#toast');
    await expect(error).toHaveText(ERROR);
    expect(downloads).toHaveLength(0);
    expect(await page.evaluate(() => [window.exportWrites, window.exportPickers])).toEqual([0, 0]);
    await expect(page.locator('.save-status')).toHaveText('Unsaved changes');
    await expect(page).toHaveTitle('* original.pdf · PDF Editor');
    await expect(page.locator('.page-caption')).toHaveText('Page 1 of 2');
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Download', exact: true })).toBeEnabled();
    if (action === 'extract') {
      const dialog = page.getByRole('dialog', { name: 'Extract pages', exact: true });
      await expect(
        dialog.getByRole('button', { name: 'Download pages', exact: true }),
      ).toBeEnabled();
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    }
    await page.getByRole('button', { name: 'Protected', exact: true }).click();
    await page
      .getByRole('dialog', { name: 'Change password', exact: true })
      .getByRole('button', { name: 'Remove password', exact: true })
      .click();
    await exportAction(page, action);
    if (['save', 'copy'].includes(action))
      await expect.poll(() => page.evaluate(() => window.exportWrites)).toBe(1);
    else if (action === 'picker')
      await expect.poll(() => page.evaluate(() => window.exportPickers)).toBe(1);
    else await expect.poll(() => downloads.length).toBe(1);
    await expect(page.locator('#toast')).not.toHaveText(ERROR);
    expect(errors).toEqual([]);
  });

test('a protected PDF exactly at the export byte limit is still downloadable and readable', async ({
  page,
}) => {
  const plain = await twoPages();
  const limit = (await protectPdf(plain, { open: 'secret' })).length;
  await setup(page, limit);
  await choose(page, plain);
  await protect(page);
  const pending = page.waitForEvent('download');
  await exportAction(page, 'download');
  const bytes = new Uint8Array(await readFile(await (await pending).path()));
  expect(bytes.length).toBe(limit);
  expect((await PDFDocument.load((await unlockPdf(bytes, 'secret')).bytes)).getPageCount()).toBe(2);
  await expect(page.locator('.save-status')).toHaveText('Downloaded');
});

test('the real 100 MB limit rejects encryption growth and keeps the working copy unsaved', async ({
  page,
}) => {
  test.setTimeout(60000);
  const downloads = [];
  page.on('download', (download) => downloads.push(download));
  await setup(page);
  await page.evaluate(async () => {
    const { blankPdf, validatePdf, MAX_FILE_SIZE } = await import('/src/core/document.js');
    const doc = await validatePdf(await blankPdf());
    const stream = doc.context.stream(new Uint8Array(MAX_FILE_SIZE - 4096));
    const ref = doc.context.register(stream);
    const date = doc
      .getInfoDict()
      .entries()
      .find(([key]) => key.decodeText() === 'CreationDate')[1];
    for (const [key, value] of doc.context
      .obj({ PieceInfo: { PDFEditor: { LastModified: date, Private: ref } } })
      .entries())
      doc.getPage(0).node.set(key, value);
    const initial = await doc.save();
    stream.contents = new Uint8Array(stream.contents.length + MAX_FILE_SIZE - 128 - initial.length);
    const transfer = new DataTransfer();
    transfer.items.add(new File([await doc.save()], 'near-limit.pdf', { type: 'application/pdf' }));
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true }));
  });
  await expect(page).toHaveTitle('near-limit.pdf · PDF Editor');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await protect(page);
  await exportAction(page, 'download');
  await expect(page.locator('#toast')).toHaveText(ERROR, { timeout: 30000 });
  expect(downloads).toHaveLength(0);
  await expect(page.locator('.save-status')).toHaveText('Unsaved changes');
  await expect(page).toHaveTitle('* near-limit.pdf · PDF Editor');
  await expect(page.getByRole('button', { name: 'Download', exact: true })).toBeEnabled();
});
