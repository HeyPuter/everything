import { test, expect } from '@playwright/test';
import {
  PDFDocument,
  concatTransformationMatrix,
  drawObject,
  popGraphicsState,
  pushGraphicsState,
} from 'pdf-lib';

/** Pages that each show a picture, as a scan does. */
async function scanBytes(count) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < count; i++) {
    const page = doc.addPage([400, 500]);
    const picture = doc.context.flateStream(new Uint8Array(300 * 300 * 3).fill(40 + (i % 8) * 20), {
      Type: 'XObject',
      Subtype: 'Image',
      Width: 300,
      Height: 300,
      ColorSpace: 'DeviceRGB',
      BitsPerComponent: 8,
    });
    const name = page.node.newXObject('Im', doc.context.register(picture));
    page.pushOperators(
      pushGraphicsState(),
      concatTransformationMatrix(300, 0, 0, 300, 50, 100),
      drawObject(name),
      popGraphicsState(),
    );
  }
  return Buffer.from(await doc.save());
}

/**
 * Watch every page PDF.js draws, through the same PDF.js module the editor loaded, and let the
 * pictures of pages 5 to 20 take a while, as a large scan's do: they are done, or given up,
 * only once the reader has scrolled on past them.
 */
async function slowMiddlePictures(page) {
  await page.evaluate(async () => {
    const url = performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .find((name) => name.includes('/deps/pdfjs-dist.js'));
    const pdfjs = await import(url);
    const text =
      '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 10 10]>>endobj\ntrailer<</Root 1 0 R>>';
    const task = pdfjs.getDocument({ data: Uint8Array.from(text, (c) => c.charCodeAt(0)) });
    const proto = Object.getPrototypeOf(await (await task.promise).getPage(1));
    const render = proto.render;
    window.drawnPages = new Set();
    window.slowPictures = 0;
    proto.render = function (...args) {
      window.drawnPages.add(this);
      const task = render.apply(this, args);
      if (this.pageNumber < 5 || this.pageNumber > 20) return task;
      window.slowPictures++;
      const cancel = task.cancel.bind(task);
      const done = new Promise((resolve, reject) => {
        task.promise.then(() => setTimeout(resolve, 1500), reject);
        task.cancel = () => {
          cancel();
          reject(new Error('Rendering cancelled'));
        };
      });
      Object.defineProperty(task, 'promise', { value: done });
      return task;
    };
  });
}
/** How many of pages 1 to 24, other than the page being worked on, still hold decoded pictures. */
const held = (page, current) =>
  page.evaluate(
    (current) =>
      [...window.drawnPages].filter(
        (pdfPage) =>
          pdfPage.pageNumber < 25 && pdfPage.pageNumber !== current && [...pdfPage.objs].length,
      ).length,
    current,
  );

test('pages scrolled past before their pictures were done let go of them', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
  await page.goto('/#library');
  const opened = page.waitForEvent('filechooser');
  await page.keyboard.press('ControlOrMeta+o');
  await (
    await opened
  ).setFiles({ name: 'scan.pdf', mimeType: 'application/pdf', buffer: await scanBytes(30) });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 30');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await slowMiddlePictures(page);
  const workspace = page.locator('.workspace');
  for (let step = 1; step <= 30; step++) {
    await workspace.evaluate((node, step) => (node.scrollTop = step * node.clientHeight), step);
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 30)));
  }
  await workspace.evaluate((node) => (node.scrollTop = node.scrollHeight));
  await expect(page.locator('.page-caption')).toHaveText('Page 30 of 30');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  expect(await page.evaluate(() => window.slowPictures)).toBeGreaterThan(3);
  // Every page passed on the way lets go of its decoded picture once its drawing is done.
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 2000)));
  await expect.poll(() => held(page, 30)).toBe(0);
});

test('Organize pages lets go of the pictures of pages scrolled past before they were drawn', async ({
  page,
}) => {
  await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
  await page.goto('/#library');
  const opened = page.waitForEvent('filechooser');
  await page.keyboard.press('ControlOrMeta+o');
  await (
    await opened
  ).setFiles({ name: 'scan.pdf', mimeType: 'application/pdf', buffer: await scanBytes(150) });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 150');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await slowMiddlePictures(page);
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await page
    .getByRole('complementary', { name: 'Tools' })
    .getByRole('button', { name: 'Organize pages', exact: true })
    .click();
  const grid = page.getByRole('listbox', { name: 'Pages' });
  await expect(page.getByRole('option', { name: 'Page 1', exact: true })).toBeVisible();
  for (let step = 1; step <= 30; step++) {
    await grid.evaluate((node, step) => (node.scrollTop = step * node.clientHeight), step);
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 30)));
  }
  await expect(page.getByRole('option', { name: 'Page 150', exact: true })).toBeInViewport();
  expect(await page.evaluate(() => window.slowPictures)).toBeGreaterThan(3);
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 2000)));
  // Page 1, behind the grid, is the page being worked on.
  await expect.poll(() => held(page, 1)).toBe(0);
});
