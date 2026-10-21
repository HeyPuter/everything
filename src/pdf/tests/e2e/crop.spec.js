import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { PDFDocument, PDFName, PDFNumber, StandardFonts } from 'pdf-lib';

const PUTER_MOCK = `window.puter = { env: 'web', auth: { isSignedIn: () => true, getUser: async () => ({username:'test-user'}), signIn: async () => {}, signOut: async () => {} }, fs: { readdir: async () => [], write: async () => ({}) }, ui: { onLaunchedWithItems: () => {}, onItemsOpened: () => {} } };`;
async function mockPuter(page) {
  await page.route('https://js.puter.com/**', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: PUTER_MOCK }),
  );
}
async function openPdf(page, doc) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'test.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText(`Page 1 of ${doc.getPageCount()}`);
}
/** Choose a menu item by name from the menu bar, or from the folded phone menu. */
async function menu(page, name) {
  const bar = page.getByRole('menubar', { name: 'PDF menus' });
  const item = page.getByRole('menu').getByRole('menuitem', { name, exact: true });
  if (await bar.isVisible()) {
    for (const title of ['File', 'Edit', 'View', 'Page', 'Insert']) {
      await bar.getByRole('menuitem', { name: title, exact: true }).click();
      if (await item.count()) return item.click();
      await page.keyboard.press('Escape');
    }
  } else {
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    if (await item.count()) return item.click();
    // Crop lives in the Page menu; trying it first keeps the phone path short under load.
    for (const section of ['Page', 'Edit', 'View', 'Insert']) {
      await page.getByRole('menu').getByRole('menuitem', { name: section, exact: true }).click();
      if (await item.count()) return item.click();
      await page.keyboard.press('Escape');
    }
  }
  throw new Error(`No menu item named ${name}`);
}
const settled = (page) => expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
const canvasBox = (page) => page.locator('.workspace .paper > canvas').first().boundingBox();
async function squarePages() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 2; i++)
    doc.addPage([400, 400]).drawText(`Square page ${i + 1}`, { x: 40, y: 300, size: 18, font });
  return doc;
}

test('dragging a crop area crops the page, Remove crop restores it, and Escape leaves the mode', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await squarePages());
  await menu(page, 'Crop pages…');
  await expect(page.locator('.tool-hint')).toContainText('Drag over the part of the page to keep');
  await expect(page.getByRole('button', { name: 'Margins…', exact: true })).toBeVisible();
  const overlay = page.locator('.drawing-overlay');
  const box = await overlay.boundingBox();
  await page.mouse.move(box.x + box.width * 0.1, box.y + box.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.4, { steps: 5 });
  await page.mouse.move(box.x + box.width * 0.9, box.y + box.height * 0.6, { steps: 5 });
  await page.mouse.up();
  const panel = page.getByRole('group', { name: 'Crop area' });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Crop this page', exact: true })).toBeFocused();
  await panel.getByRole('button', { name: 'Crop this page', exact: true }).click();
  await expect(page.locator('#toast')).toHaveText('Page cropped.');
  await settled(page);
  // The kept area is 80% wide and 40% tall: the page now shows twice as wide as it is tall.
  const cropped = await canvasBox(page);
  expect(cropped.width / cropped.height).toBeGreaterThan(1.9);
  expect(cropped.width / cropped.height).toBeLessThan(2.1);
  await expect(page.getByRole('button', { name: 'Select', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(page.locator('.page-caption')).toHaveText('Page 2 of 2');
  await settled(page);
  const other = await canvasBox(page);
  expect(Math.abs(other.width - other.height)).toBeLessThan(2);
  await menu(page, 'Remove crop');
  await expect(page.locator('#toast')).toHaveText('This page is not cropped.');
  await page.getByRole('button', { name: 'Previous page', exact: true }).click();
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 2');
  await settled(page);
  await menu(page, 'Remove crop');
  await expect(page.locator('#toast')).toHaveText('The full page is shown again.');
  await settled(page);
  const restored = await canvasBox(page);
  expect(Math.abs(restored.width - restored.height)).toBeLessThan(2);
  await menu(page, 'Crop pages…');
  await expect(page.locator('.tool-hint')).toContainText('Drag over the part of the page');
  // Escape in the find bar only closes the find bar; the crop mode stays.
  await page.keyboard.press('ControlOrMeta+f');
  const find = page.getByRole('searchbox', { name: 'Find in PDF' });
  await find.fill('page');
  await find.press('Escape');
  await expect(page.locator('.find-bar')).toBeHidden();
  await expect(page.locator('.tool-hint')).toContainText('Drag over the part of the page');
  await page.locator('.drawing-overlay').focus();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Select', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.locator('.drawing-overlay')).not.toHaveClass(/active/);
});

test('typed margins crop every page and undo brings the pages back', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await squarePages());
  await menu(page, 'Crop pages…');
  await page.getByRole('button', { name: 'Margins…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Crop pages' });
  await expect(dialog.getByLabel('Top (pt)')).toBeFocused();
  await dialog.getByLabel('Top (pt)').fill('100');
  await dialog.getByLabel('Left (pt)').fill('200');
  await dialog.getByRole('radio', { name: 'Pages', exact: true }).check();
  await dialog.getByLabel('Page range').fill('1-2');
  await dialog.getByRole('button', { name: 'Crop', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('#toast')).toHaveText('All 2 pages cropped.');
  await settled(page);
  // 200 of 400 points remain across, 300 of 400 down.
  const cropped = await canvasBox(page);
  expect(cropped.width / cropped.height).toBeGreaterThan(0.63);
  expect(cropped.width / cropped.height).toBeLessThan(0.7);
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(page.locator('.page-caption')).toHaveText('Page 2 of 2');
  await settled(page);
  const second = await canvasBox(page);
  expect(second.width / second.height).toBeLessThan(0.7);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await settled(page);
  const restored = await canvasBox(page);
  expect(Math.abs(restored.width - restored.height)).toBeLessThan(2);
  await menu(page, 'Crop pages…');
  await page.getByRole('button', { name: 'Margins…', exact: true }).click();
  await page.getByRole('dialog', { name: 'Crop pages' }).getByLabel('Left (pt)').fill('390');
  await page
    .getByRole('dialog', { name: 'Crop pages' })
    .getByRole('button', { name: 'Crop', exact: true })
    .click();
  await expect(page.getByRole('dialog', { name: 'Crop pages' }).getByRole('alert')).toHaveText(
    'Keep at least half an inch of the page.',
  );
});

test('typed margins for some of the pages say how many were cropped', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await squarePages();
  doc.addPage([400, 400]);
  await openPdf(page, doc);
  await menu(page, 'Crop pages…');
  await page.getByRole('button', { name: 'Margins…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Crop pages' });
  await dialog.getByLabel('Top (pt)').fill('100');
  await dialog.getByRole('radio', { name: 'Pages', exact: true }).check();
  // Page 2 named twice is still one page.
  await dialog.getByLabel('Page range').fill('1-2, 2');
  await dialog.getByRole('button', { name: 'Crop', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('#toast')).toHaveText('2 pages cropped.');
});

test('typed crop margins retain their point sizes on a scaled PDF page', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  const source = await squarePages();
  source.getPages().forEach((p) => p.node.set(PDFName.of('UserUnit'), PDFNumber.of(2)));
  await openPdf(page, source);
  await menu(page, 'Crop pages…');
  await page.getByRole('button', { name: 'Margins…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Crop pages' });
  await dialog.getByLabel('Top (pt)').fill('72');
  await dialog.getByLabel('Left (pt)').fill('36');
  await dialog.getByRole('button', { name: 'Crop', exact: true }).click();
  await settled(page);
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const exported = await PDFDocument.load(await readFile(await (await pending).path()));
  expect(exported.getPage(0).getCropBox()).toEqual({ x: 18, y: 0, width: 382, height: 364 });
});

test('an empty crop margin stays editable without modifying the PDF', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await squarePages());
  await menu(page, 'Crop pages…');
  await page.getByRole('button', { name: 'Margins…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Crop pages' });
  const top = dialog.getByLabel('Top (pt)');
  await top.fill('');
  await dialog.getByLabel('Left (pt)').fill('36');
  await dialog.getByRole('button', { name: 'Crop', exact: true }).click();
  await expect(dialog).toBeVisible();
  await expect(top).toBeFocused();
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await expect(page.locator('.save-status')).toHaveText('Local file');
  await top.fill('18.5');
  await dialog.getByRole('button', { name: 'Crop', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await settled(page);
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const exported = await PDFDocument.load(await readFile(await (await pending).path()));
  expect(exported.getPage(0).getCropBox()).toEqual({ x: 36, y: 0, width: 364, height: 381.5 });
});
