import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { PDFDocument, degrees } from 'pdf-lib';
import { readFile } from 'node:fs/promises';

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
    for (const section of ['Edit', 'View', 'Page', 'Insert']) {
      await page.getByRole('menu').getByRole('menuitem', { name: section, exact: true }).click();
      if (await item.count()) return item.click();
      await page.keyboard.press('Escape');
    }
  }
  throw new Error(`No menu item named ${name}`);
}
const settled = (page) => expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
/** Text PDF.js laid over the page, where the drawn marks show up as selectable text. */
const pageView = (page) => page.locator('.workspace .textLayer');
const pageCanvas = (page) => page.locator('.workspace .paper > canvas').first();
async function threePages(rotation = 0) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < 3; i++) doc.addPage([400, 500]).setRotation(degrees(rotation));
  return doc;
}

test('page numbers land at the bottom center of every page and stay editable text', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await threePages());
  await menu(page, 'Page numbers…');
  const dialog = page.getByRole('dialog', { name: 'Add page numbers' });
  await expect(dialog.getByLabel('Position')).toHaveValue('bottom-center');
  await expect(dialog.getByLabel('Format')).toHaveValue('of');
  await expect(dialog.getByRole('option', { name: 'Page 1 of 3' })).toBeAttached();
  await expect(dialog.getByRole('radio', { name: 'All pages (3)' })).toBeChecked();
  const accessibility = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(accessibility.violations).toEqual([]);
  await dialog.getByRole('button', { name: 'Add page numbers', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('#toast')).toHaveText('Page numbers added to 3 pages.');
  await settled(page);
  const label = pageView(page).getByText('Page 1 of 3', { exact: true });
  await expect(label).toBeVisible();
  const canvas = await pageCanvas(page).boundingBox();
  const box = await label.boundingBox();
  expect(Math.abs(box.x + box.width / 2 - (canvas.x + canvas.width / 2))).toBeLessThan(6);
  expect(box.y + box.height).toBeGreaterThan(canvas.y + canvas.height * 0.9);
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(pageView(page).getByText('Page 2 of 3', { exact: true })).toBeVisible();
  // The numbers are ordinary text: the Text tool offers them for editing.
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Edit text: Page 2 of 3', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await settled(page);
  await expect(pageView(page).getByText('Page 2 of 3', { exact: true })).toHaveCount(0);
});

test('page numbers read upright at the displayed bottom of rotated pages and follow the options', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await threePages(90));
  await menu(page, 'Page numbers…');
  const dialog = page.getByRole('dialog', { name: 'Add page numbers' });
  await dialog.getByLabel('Position').selectOption('top-right');
  await dialog.getByLabel('Format').selectOption('plain');
  await dialog.getByLabel('Start at').fill('7');
  await dialog.getByLabel('Size (pt)').fill('20');
  await dialog.getByRole('radio', { name: 'Pages', exact: true }).check();
  await dialog.getByLabel('Page range').fill('2-3');
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  await expect(page.locator('#toast')).toHaveText('Page numbers added to 2 pages.');
  await settled(page);
  await expect(pageView(page).getByText('7')).toHaveCount(0);
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  const label = pageView(page).getByText('7', { exact: true });
  await expect(label).toBeVisible();
  const canvas = await pageCanvas(page).boundingBox();
  const box = await label.boundingBox();
  expect(box.x + box.width).toBeGreaterThan(canvas.x + canvas.width * 0.8);
  expect(box.y).toBeLessThan(canvas.y + canvas.height * 0.2);
  // Wider than tall: the text runs along the reader's horizontal even though the page is turned.
  expect(box.width).toBeGreaterThan(box.height * 0.4);
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(pageView(page).getByText('8', { exact: true })).toBeVisible();
});

test('a watermark is centered on the chosen pages with the typed text, layout, and opacity', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await threePages());
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await menu(page, 'Watermark…');
  const dialog = page.getByRole('dialog', { name: 'Add watermark' });
  await expect(dialog.getByLabel('Text')).toHaveValue('CONFIDENTIAL');
  await expect(dialog.getByLabel('Opacity')).toHaveValue('25');
  await expect(dialog.getByText('25%')).toBeVisible();
  await dialog.getByLabel('Text').fill('   ');
  await dialog.getByRole('button', { name: 'Add watermark', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Enter the watermark text.');
  await dialog.getByLabel('Text').fill('DRAFT');
  await dialog.getByLabel('Layout').selectOption('horizontal');
  await dialog.getByLabel('Opacity').fill('60');
  await expect(dialog.getByText('60%')).toBeVisible();
  await dialog.getByRole('radio', { name: 'Current page (2)' }).check();
  await dialog.getByRole('button', { name: 'Add watermark', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('#toast')).toHaveText('Watermark added to the page.');
  await settled(page);
  const mark = pageView(page).getByText('DRAFT', { exact: true });
  await expect(mark).toBeVisible();
  // The selectable span uses browser font metrics, not the painted glyph bounds.
  // Measure the actual watermark on this otherwise blank page, in CSS pixels.
  const ink = await pageCanvas(page).evaluate((canvas) => {
    const { width, height } = canvas;
    const data = canvas.getContext('2d').getImageData(0, 0, width, height).data;
    let left = width,
      right = -1,
      top = height,
      bottom = -1,
      darkest = 255;
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const value = data[(y * width + x) * 4];
        darkest = Math.min(darkest, value);
        if (value >= 230) continue;
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
    const box = canvas.getBoundingClientRect();
    return {
      dx: ((left + right + 1 - width) / 2) * (box.width / width),
      dy: ((top + bottom + 1 - height) / 2) * (box.height / height),
      widthFraction: (right - left + 1) / width,
      darkest,
    };
  });
  expect(Math.abs(ink.dx)).toBeLessThan(8);
  expect(Math.abs(ink.dy)).toBeLessThan(8);
  expect(ink.widthFraction).toBeGreaterThan(0.3);
  // Black at 60% opacity on a white page is approximately RGB(102, 102, 102).
  expect(Math.abs(ink.darkest - 102)).toBeLessThanOrEqual(1);
  await page.getByRole('button', { name: 'Previous page', exact: true }).click();
  await expect(pageView(page).getByText('DRAFT', { exact: true })).toHaveCount(0);
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const saved = await PDFDocument.load(await readFile(await (await pending).path()));
  expect(saved.getPageCount()).toBe(3);
});

test('a header and footer fill in the file name and page numbers on every page', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await threePages());
  await menu(page, 'Header and footer…');
  const dialog = page.getByRole('dialog', { name: 'Header and footer' });
  await expect(dialog.getByLabel('Top left')).toBeFocused();
  await dialog.getByRole('button', { name: 'Add header and footer', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('at least one');
  await dialog.getByLabel('Top right').fill('Confidential');
  await dialog.getByLabel('Bottom center').fill('{file} · {page} of {pages}');
  await dialog.getByLabel('Bottom center').press('Enter');
  await expect(dialog).toBeHidden();
  await expect(page.locator('#toast')).toHaveText('Header and footer added to 3 pages.');
  await settled(page);
  const footer = pageView(page).getByText('test · 1 of 3', { exact: true });
  await expect(footer).toBeVisible();
  const canvas = await pageCanvas(page).boundingBox();
  const footerBox = await footer.boundingBox();
  expect(footerBox.y + footerBox.height).toBeGreaterThan(canvas.y + canvas.height * 0.9);
  const header = pageView(page).getByText('Confidential', { exact: true });
  const headerBox = await header.boundingBox();
  expect(headerBox.y).toBeLessThan(canvas.y + canvas.height * 0.1);
  expect(headerBox.x + headerBox.width).toBeGreaterThan(canvas.x + canvas.width * 0.8);
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(pageView(page).getByText('test · 2 of 3', { exact: true })).toBeVisible();
});

test('page numbering rejects an empty start and accepts an explicit zero with fractional text size', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await threePages());
  await menu(page, 'Page numbers…');
  const dialog = page.getByRole('dialog', { name: 'Add page numbers' });
  const start = dialog.getByLabel('Start at');
  await start.fill('');
  await dialog.getByRole('button', { name: 'Add page numbers', exact: true }).click();
  await expect(start).toBeFocused();
  await expect(dialog).toBeVisible();
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await expect(page.locator('.save-status')).toHaveText('Local file');
  await start.fill('0');
  await dialog.getByLabel('Size (pt)').fill('11.5');
  await dialog.getByRole('button', { name: 'Add page numbers', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await settled(page);
  await expect(pageView(page).getByText('Page 0 of 2', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(pageView(page).getByText('Page 1 of 2', { exact: true })).toBeVisible();
});

for (const kind of ['watermark', 'numbers', 'header'])
  for (const fails of [false, true])
    test(`cancelling ${kind} preparation ignores a late font ${fails ? 'failure' : 'success'}`, async ({
      page,
    }) => {
      await mockPuter(page);
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      await page.route('**/fonts/NotoSans-Regular.ttf', async (route) => {
        if (route.request().resourceType() === 'fetch') {
          await gate;
          if (fails) return route.fulfill({ status: 503, body: 'Unavailable' });
        }
        await route.continue();
      });
      await page.goto('/#library');
      await openPdf(page, await threePages());
      const labels = {
        watermark: ['Watermark…', 'Add watermark', 'Add watermark'],
        numbers: ['Page numbers…', 'Add page numbers', 'Add page numbers'],
        header: ['Header and footer…', 'Header and footer', 'Add header and footer'],
      }[kind];
      await menu(page, labels[0]);
      const dialog = page.getByRole('dialog', { name: labels[1], exact: true });
      if (kind === 'header') await dialog.getByLabel('Top left').fill('Pending header');
      const requested = page.waitForRequest(
        (r) => r.url().endsWith('/fonts/NotoSans-Regular.ttf') && r.resourceType() === 'fetch',
      );
      await dialog.getByRole('button', { name: labels[2], exact: true }).click();
      await requested;
      await expect(dialog).toHaveAttribute('aria-busy', 'true');
      await expect(dialog.getByRole('button', { name: labels[2], exact: true })).toBeDisabled();
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await settled(page);
      await menu(page, labels[0]);
      const reopened = page.getByRole('dialog', { name: labels[1], exact: true });
      await expect(reopened.getByRole('button', { name: labels[2], exact: true })).toBeEnabled();
      const response = page.waitForResponse(
        (r) =>
          r.url().endsWith('/fonts/NotoSans-Regular.ttf') && r.request().resourceType() === 'fetch',
      );
      release();
      await (await response).finished();
      await settled(page);
      await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 150)));
      await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
      await expect(page.locator('.save-status')).toHaveText('Local file');
      await expect(pageView(page).locator('span')).toHaveCount(0);
      await expect(reopened).toBeVisible();
      await expect(reopened.getByRole('alert')).toBeHidden();
    });

test('closing a page-mark dialog in the serialization turn discards its output', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await threePages());
  await menu(page, 'Watermark…');
  const dialog = page.getByRole('dialog', { name: 'Add watermark', exact: true });
  await page.evaluate(async () => {
    const { blankPdf, validatePdf } = await import('/src/core/document.js');
    const prototype = Object.getPrototypeOf(await validatePdf(await blankPdf()));
    const save = prototype.save;
    prototype.save = async function (...args) {
      prototype.save = save;
      const bytes = await save.apply(this, args);
      await new Promise((resolve) => {
        window.releaseMarkSave = resolve;
      });
      return bytes;
    };
  });
  await dialog.getByRole('button', { name: 'Add watermark', exact: true }).click();
  await expect.poll(() => page.evaluate(() => !!window.releaseMarkSave)).toBe(true);
  await dialog.evaluate((d) => {
    d.close();
    window.releaseMarkSave();
  });
  await settled(page);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await expect(page.locator('.save-status')).toHaveText('Local file');
});

for (const submit of ['button', 'Enter'])
  test(`header and footer accepts a fractional size through ${submit}`, async ({ page }) => {
    await mockPuter(page);
    await page.goto('/#library');
    await openPdf(page, await threePages());
    await menu(page, 'Header and footer…');
    const dialog = page.getByRole('dialog', { name: 'Header and footer', exact: true });
    await dialog.getByLabel('Top left').fill('Fractional header');
    await dialog.getByLabel('Size (pt)').fill('10.5');
    if (submit === 'Enter') await dialog.getByLabel('Size (pt)').press('Enter');
    else await dialog.getByRole('button', { name: 'Add header and footer', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await settled(page);
    await expect(pageView(page).getByText('Fractional header', { exact: true })).toBeVisible();
    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download', exact: true }).click();
    const bytes = await readFile(await (await pending).path());
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task = getDocument({ data: new Uint8Array(bytes) });
    const saved = await task.promise;
    try {
      for (let index = 1; index <= 3; index++) {
        const content = await (await saved.getPage(index)).getTextContent();
        const header = content.items.find((item) => item.str === 'Fractional header');
        expect(header).toBeDefined();
        expect(header.transform[3]).toBeCloseTo(10.5);
      }
    } finally {
      await task.destroy();
    }
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await settled(page);
    await expect(pageView(page).getByText('Fractional header', { exact: true })).toHaveCount(0);
  });

test('page marks count a page named twice in the range once', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await threePages());
  for (const [item, title, buttonName, message] of [
    ['Watermark…', 'Add watermark', 'Add watermark', 'Watermark added to 2 pages.'],
    ['Page numbers…', 'Add page numbers', 'Add page numbers', 'Page numbers added to 2 pages.'],
    [
      'Header and footer…',
      'Header and footer',
      'Add header and footer',
      'Header and footer added to the page.',
    ],
  ]) {
    await menu(page, item);
    const dialog = page.getByRole('dialog', { name: title });
    if (title === 'Header and footer') await dialog.getByLabel('Top left').fill('Report');
    await dialog.getByRole('radio', { name: 'Pages', exact: true }).check();
    await dialog.getByLabel('Page range').fill(title === 'Header and footer' ? '3, 3' : '1-2, 2');
    await dialog.getByRole('button', { name: buttonName, exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('#toast')).toHaveText(message);
    await settled(page);
  }
});
