import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { PDFDocument } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { inspectPaths } from '../../src/core/path-edit.js';

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
    for (const title of ['Insert', 'File', 'Edit', 'View', 'Page']) {
      await bar.getByRole('menuitem', { name: title, exact: true }).click();
      if (await item.count()) return item.click();
      await page.keyboard.press('Escape');
    }
  } else {
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    if (await item.count()) return item.click();
    for (const section of ['Insert', 'Edit', 'View', 'Page']) {
      await page.getByRole('menu').getByRole('menuitem', { name: section, exact: true }).click();
      if (await item.count()) return item.click();
      await page.keyboard.press('Escape');
    }
  }
  throw new Error(`No menu item named ${name}`);
}
async function exported(page) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  return PDFDocument.load(await readFile(await (await pending).path()));
}
const settled = (page) => expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');

async function normalizedInk(canvas) {
  return canvas.evaluate((source) => {
    const ctx = source.getContext('2d');
    const pixels = ctx.getImageData(0, 0, source.width, source.height).data;
    let left = source.width,
      top = source.height,
      right = -1,
      bottom = -1;
    for (let y = 0; y < source.height; y++)
      for (let x = 0; x < source.width; x++) {
        const i = (y * source.width + x) * 4;
        if (pixels[i + 3] < 128 || Math.min(pixels[i], pixels[i + 1], pixels[i + 2]) > 245)
          continue;
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
    if (right < left) return null;
    const normalized = document.createElement('canvas');
    normalized.width = 240;
    normalized.height = 96;
    const paint = normalized.getContext('2d');
    paint.imageSmoothingQuality = 'high';
    paint.fillStyle = '#fff';
    paint.fillRect(0, 0, 240, 96);
    paint.drawImage(source, left, top, right - left + 1, bottom - top + 1, 0, 0, 240, 96);
    const data = paint.getImageData(0, 0, 240, 96).data;
    return {
      aspect: (right - left + 1) / (bottom - top + 1),
      png: normalized.toDataURL().split(',')[1],
      pixels: Array.from({ length: 240 * 96 }, (_, i) =>
        Math.min(data[4 * i], data[4 * i + 1], data[4 * i + 2]),
      ),
    };
  });
}

for (const label of ['APPROVED', 'Paid in full', 'AbCd '.repeat(6).trim(), 'B\u0308\u0301'])
  test(`the stamp preview matches its PDF lettering and frame for ${label}`, async ({
    page,
  }, testInfo) => {
    await mockPuter(page);
    await page.goto('/#library');
    const doc = await PDFDocument.create();
    doc.addPage([400, 400]);
    await openPdf(page, doc);
    await page.getByLabel('Zoom', { exact: true }).selectOption('4');
    await settled(page);
    await menu(page, 'Stamp…');
    const dialog = page.getByRole('dialog', { name: 'Add stamp' });
    await dialog.getByLabel('Text', { exact: true }).fill(label);
    await dialog.getByLabel('Color', { exact: true }).fill('#2255aa');
    const previewCanvas = dialog.locator('.stamp-preview');
    await expect.poll(async () => Boolean(await normalizedInk(previewCanvas))).toBe(true);
    const preview = await normalizedInk(previewCanvas);
    await dialog.getByRole('button', { name: 'Place stamp', exact: true }).click();
    await expect(page.getByRole('group', { name: 'Edit stamp' })).toBeVisible();
    const rendered = await normalizedInk(page.locator('.paper > canvas').first());
    expect(Math.abs(preview.aspect / rendered.aspect - 1)).toBeLessThan(0.03);
    const difference =
      preview.pixels.reduce((sum, value, i) => sum + Math.abs(value - rendered.pixels[i]), 0) /
      (preview.pixels.length * 255);
    await testInfo.attach('preview', {
      body: Buffer.from(preview.png, 'base64'),
      contentType: 'image/png',
    });
    await testInfo.attach('PDF', {
      body: Buffer.from(rendered.png, 'base64'),
      contentType: 'image/png',
    });
    // A small preview has softer pixel edges than the same paths in a zoomed PDF.
    expect(difference).toBeLessThan(0.06);
  });

test('a delayed stamp preview uses the latest text and redraws when resized', async ({ page }) => {
  let release,
    requests = 0;
  const ready = new Promise((resolve) => (release = resolve));
  await page.route('**/fonts/NotoSans-Regular.ttf', async (route) => {
    requests++;
    await ready;
    await route.continue();
  });
  await mockPuter(page);
  await page.goto('/');
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await menu(page, 'Stamp…');
  const dialog = page.getByRole('dialog', { name: 'Add stamp' });
  const status = dialog.locator('.stamp-preview-status');
  await expect(status).toHaveText('Loading preview…');
  const input = dialog.getByLabel('Text', { exact: true });
  await input.fill('Older text');
  await input.fill('Paid in full');
  release();
  await expect(status).toBeHidden();
  const canvas = dialog.locator('.stamp-preview');
  const latest = await canvas.evaluate((node) => node.toDataURL());
  await input.fill('Older text');
  await expect(status).toBeHidden();
  expect(await canvas.evaluate((node) => node.toDataURL())).not.toBe(latest);
  await input.fill('Paid in full');
  await expect(status).toBeHidden();
  expect(await canvas.evaluate((node) => node.toDataURL())).toBe(latest);
  const before = await normalizedInk(canvas);
  const viewport = page.viewportSize();
  await page.setViewportSize({ width: 320, height: viewport.height });
  await expect
    .poll(() =>
      canvas.evaluate(
        (node) => node.width === Math.round(node.clientWidth * window.devicePixelRatio),
      ),
    )
    .toBe(true);
  await expect(status).toBeHidden();
  const after = await normalizedInk(canvas);
  expect(Math.abs(before.aspect / after.aspect - 1)).toBeLessThan(0.03);
  expect(requests).toBe(1);
});

test('a preset stamp lands centered as one selected vector shape', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  doc.addPage([400, 400]);
  await openPdf(page, doc);
  await menu(page, 'Stamp…');
  const dialog = page.getByRole('dialog', { name: 'Add stamp' });
  await expect(dialog.getByLabel('Text')).toHaveValue('APPROVED');
  const accessibility = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(accessibility.violations).toEqual([]);
  await dialog.getByRole('button', { name: 'CONFIDENTIAL', exact: true }).click();
  await expect(dialog.getByLabel('Text')).toHaveValue('CONFIDENTIAL');
  await expect(dialog.getByLabel('Color')).toHaveValue('#d92626');
  await expect(dialog.getByRole('button', { name: 'CONFIDENTIAL', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await dialog.getByRole('button', { name: 'Place stamp', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('#toast')).toHaveText('Stamp added. Drag to move or resize it.');
  await settled(page);
  // Selected right away as a stamp, with its color controls showing its color.
  await expect(
    page.getByRole('button', { name: 'Move selected stamp', exact: true }),
  ).toBeVisible();
  await expect(page.locator('.properties-heading h2')).toHaveText('Stamp');
  await expect(page.getByLabel('Stamp fill color', { exact: true })).toHaveValue('#d92626');
  await expect(page.getByLabel('Stamp fill enabled', { exact: true })).toBeChecked();
  await expect(page.getByLabel('Stamp stroke enabled', { exact: true })).toBeChecked();
  const paths = inspectPaths(await exported(page), 0);
  expect(paths).toHaveLength(1);
  expect(paths[0]).toMatchObject({ kind: 'stamp', filled: true, stroked: true });
  const [x0, y0, x1, y1] = paths[0].bounds;
  expect(Math.abs((x0 + x1) / 2 - 200)).toBeLessThan(2);
  expect(Math.abs((y0 + y1) / 2 - 200)).toBeLessThan(2);
  expect(x1 - x0).toBeGreaterThan((y1 - y0) * 2);
});

for (const failure of ['unsupported character', 'font download'])
  test(`stamps keep their draft after ${failure} errors`, async ({ page }) => {
    let failFont = failure === 'font download';
    await page.route('**/fonts/NotoSans-Regular.ttf', (route) =>
      failFont ? route.fulfill({ status: 503, body: 'Unavailable' }) : route.continue(),
    );
    await mockPuter(page);
    await page.goto('/#library');
    const doc = await PDFDocument.create();
    doc.addPage([400, 400]);
    await openPdf(page, doc);
    await menu(page, 'Stamp…');
    const dialog = page.getByRole('dialog', { name: 'Add stamp' });
    const draft = failure === 'font download' ? 'Paid in full' : 'Paid 漢';
    await dialog.getByLabel('Text', { exact: true }).fill(draft);
    await dialog.getByLabel('Color', { exact: true }).fill('#2255aa');
    await dialog.getByRole('button', { name: 'Place stamp', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText(
      failure === 'font download' ? 'Could not load the stamp font' : 'stamp font has no',
    );
    await expect(dialog.getByLabel('Text', { exact: true })).toHaveValue(draft);
    await expect(dialog.getByLabel('Text', { exact: true })).toBeFocused();
    await expect(dialog.getByLabel('Color', { exact: true })).toHaveValue('#2255aa');
    failFont = false;
    await dialog.getByLabel('Text', { exact: true }).fill('Paid in full');
    await dialog.getByLabel('Text', { exact: true }).press('Enter');
    await expect(dialog).toBeHidden();
    await settled(page);
    await expect(page.getByLabel('Stamp fill color', { exact: true })).toHaveValue('#2255aa');
    expect(inspectPaths(await exported(page), 0)).toHaveLength(1);
  });

test('custom stamp text and color are validated and used', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  doc.addPage([400, 400]);
  await openPdf(page, doc);
  await menu(page, 'Stamp…');
  const dialog = page.getByRole('dialog', { name: 'Add stamp' });
  await dialog.getByLabel('Text').fill('   ');
  await dialog.getByRole('button', { name: 'Place stamp', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Enter the stamp text.');
  await dialog.getByLabel('Text').fill('Paid in full');
  await dialog.getByLabel('Color').fill('#0b63c4');
  await expect(dialog.locator('.stamp-preview')).toBeVisible();
  await dialog.getByLabel('Text').press('Enter');
  await expect(dialog).toBeHidden();
  await settled(page);
  await expect(page.getByLabel('Stamp fill color', { exact: true })).toHaveValue('#0b63c4');
  const paths = inspectPaths(await exported(page), 0);
  expect(paths).toHaveLength(1);
  expect(paths[0]).toMatchObject({ filled: true, stroked: true });
});
