import { test, expect } from '@playwright/test';
import {
  PDFDocument,
  StandardFonts,
  concatTransformationMatrix,
  drawObject,
  popGraphicsState,
  pushGraphicsState,
} from 'pdf-lib';

test.skip(({ isMobile }) => isMobile, 'desktop workspace');

async function pdfBytes(word) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 12; i++)
    doc.addPage([400, 500]).drawText(`${word} on page ${i + 1}`, { x: 40, y: 250, size: 30, font });
  return Buffer.from(await doc.save());
}

/** How many dark pixels the drawn first page of one side of the comparison has. */
const inkOnFirstPage = (page, side) =>
  page
    .locator(`.compare-paper[data-side="${side}"] canvas`)
    .first()
    .evaluate((canvas) => {
      if (!canvas.width || !canvas.height) return 0;
      const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
      let ink = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i + 3] && data[i] < 128) ink++;
      return ink;
    });

test('the compared pages still draw after the PDF is edited during a comparison', async ({
  page,
}) => {
  await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
  await page.goto('/#library');
  const opened = page.waitForEvent('filechooser');
  await page.keyboard.press('ControlOrMeta+o');
  await (
    await opened
  ).setFiles({ name: 'old.pdf', mimeType: 'application/pdf', buffer: await pdfBytes('Alpha') });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 12');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');

  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Tools' });
  await pane.getByRole('button', { name: 'View more' }).click();
  await pane.getByRole('button', { name: 'Compare files', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Compare files' });
  const chosen = page.waitForEvent('filechooser');
  await dialog.getByRole('button', { name: 'Choose file…' }).click();
  await (
    await chosen
  ).setFiles({ name: 'new.pdf', mimeType: 'application/pdf', buffer: await pdfBytes('Beta') });
  await dialog.getByRole('button', { name: 'Compare', exact: true }).click();
  await expect.poll(() => inkOnFirstPage(page, 'old')).toBeGreaterThan(50);

  // An edit while the comparison is open replaces the editor's document.
  const bar = page.getByRole('menubar', { name: 'PDF menus' });
  await bar.getByRole('menuitem', { name: 'Page', exact: true }).click();
  await page.getByRole('menu').getByRole('menuitem', { name: 'Rotate clockwise' }).click();
  await expect(page.getByText('Unsaved changes')).toBeVisible();
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');

  // Scrolling the first pages far out of view lets their drawings go; back, they draw again.
  const docs = page.locator('.compare-docs');
  await docs.evaluate((node) => (node.scrollTop = node.scrollHeight));
  await expect.poll(() => inkOnFirstPage(page, 'old')).toBe(0);
  await docs.evaluate((node) => (node.scrollTop = 0));
  await expect.poll(() => inkOnFirstPage(page, 'old')).toBeGreaterThan(50);
  await expect.poll(() => inkOnFirstPage(page, 'new')).toBeGreaterThan(50);
});

/** Pages that each show a picture of their own, as a scan's pages do. */
async function picturePdfBytes(shade) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < 4; i++) {
    const page = doc.addPage([400, 500]);
    const picture = doc.context.flateStream(new Uint8Array(400 * 400 * 3).fill(shade + i * 20), {
      Type: 'XObject',
      Subtype: 'Image',
      Width: 400,
      Height: 400,
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

test('the compared pages let go of their decoded pictures once drawn', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
  await page.goto('/#library');
  const opened = page.waitForEvent('filechooser');
  await page.keyboard.press('ControlOrMeta+o');
  await (
    await opened
  ).setFiles({ name: 'old.pdf', mimeType: 'application/pdf', buffer: await picturePdfBytes(40) });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 4');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  // Watch every page PDF.js draws, through the same PDF.js module the editor loaded.
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
    proto.render = function (...args) {
      window.drawnPages.add(this);
      return render.apply(this, args);
    };
  });

  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Tools' });
  await pane.getByRole('button', { name: 'View more' }).click();
  await pane.getByRole('button', { name: 'Compare files', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Compare files' });
  const chosen = page.waitForEvent('filechooser');
  await dialog.getByRole('button', { name: 'Choose file…' }).click();
  await (
    await chosen
  ).setFiles({ name: 'new.pdf', mimeType: 'application/pdf', buffer: await picturePdfBytes(120) });
  await dialog.getByRole('button', { name: 'Compare', exact: true }).click();
  const papers = page.locator('.compare-paper canvas');
  await expect(papers).toHaveCount(8);
  // A drawn page shows its picture in the middle of the sheet.
  const drawn = () =>
    papers.evaluateAll(
      (list) =>
        list.filter((canvas) => {
          const pixel = canvas
            .getContext('2d')
            .getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data;
          return pixel[3] > 0;
        }).length,
    );
  await expect.poll(drawn).toBe(8);
  // Every page of both files has been drawn, and none keeps its picture in memory after.
  const held = await page.evaluate(() =>
    [...window.drawnPages].map((pdfPage) => [...pdfPage.objs].length),
  );
  expect(held.length).toBeGreaterThanOrEqual(8);
  expect(held.filter(Boolean)).toEqual([]);
});

for (const same of [false, true])
  test(`scans whose pictures ${same ? 'match' : 'differ'} are compared by how their pages look`, async ({
    page,
  }) => {
    await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
    await page.goto('/#library');
    const opened = page.waitForEvent('filechooser');
    await page.keyboard.press('ControlOrMeta+o');
    await (
      await opened
    ).setFiles({ name: 'old.pdf', mimeType: 'application/pdf', buffer: await picturePdfBytes(40) });
    await expect(page.locator('.page-caption')).toHaveText('Page 1 of 4');
    await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
    await page.getByRole('button', { name: 'Tools', exact: true }).click();
    const pane = page.getByRole('complementary', { name: 'Tools' });
    await pane.getByRole('button', { name: 'View more' }).click();
    await pane.getByRole('button', { name: 'Compare files', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Compare files' });
    const chosen = page.waitForEvent('filechooser');
    await dialog.getByRole('button', { name: 'Choose file…' }).click();
    await (
      await chosen
    ).setFiles({
      name: 'new.pdf',
      mimeType: 'application/pdf',
      buffer: await picturePdfBytes(same ? 40 : 120),
    });
    await dialog.getByRole('button', { name: 'Compare', exact: true }).click();
    const summary = page.locator('.compare-summary');
    if (same) {
      await expect(summary).toHaveText('No differences found');
      return;
    }
    // The pictures have the same size and place on both sides; only their pixels differ.
    await expect(summary).toHaveText('4 changes: 4 other changes');
    await expect(
      page.getByRole('listbox', { name: 'Changes' }).getByRole('option', {
        name: 'Page appearance differs, page 1',
      }),
    ).toBeVisible();
  });

test('keys the comparison answers itself leave the document behind it alone', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
  await page.goto('/#library');
  const opened = page.waitForEvent('filechooser');
  await page.keyboard.press('ControlOrMeta+o');
  await (
    await opened
  ).setFiles({ name: 'old.pdf', mimeType: 'application/pdf', buffer: await pdfBytes('Alpha') });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 12');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Tools' });
  await pane.getByRole('button', { name: 'View more' }).click();
  await pane.getByRole('button', { name: 'Compare files', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Compare files' });
  const chosen = page.waitForEvent('filechooser');
  await dialog.getByRole('button', { name: 'Choose file…' }).click();
  await (
    await chosen
  ).setFiles({ name: 'new.pdf', mimeType: 'application/pdf', buffer: await pdfBytes('Beta') });
  await dialog.getByRole('button', { name: 'Compare', exact: true }).click();
  const options = page.getByRole('listbox', { name: 'Changes' }).getByRole('option');
  await expect(options).toHaveCount(12);

  // End moves to the last change, not to the last page behind the list.
  await options.first().focus();
  await page.keyboard.press('End');
  await expect(options.last()).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(options.nth(10)).toBeFocused();
  // F3 steps through the changes; it does not open the document's Find bar behind the view.
  await page.keyboard.press('F3');
  await expect(options.last()).toHaveAttribute('aria-selected', 'true');

  await page.getByRole('button', { name: 'Close compare' }).click();
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 12');
  await expect(page.getByRole('combobox', { name: 'Find in PDF' })).toBeHidden();
});

test('a comparison describes each change once, however many lines it marks', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
  // Count the change descriptions the view writes. Each reads through all of its change's text,
  // so writing one per marked line made a long comparison freeze the page as it opened.
  await page.route('**/src/core/compare.js*', async (route) => {
    const response = await route.fetch();
    const body = await response.text();
    const head = 'export function describeChange(change, limit = 120) {';
    expect(body).toContain(head);
    await route.fulfill({
      response,
      body: body.replace(
        head,
        `${head}\nglobalThis.describedChanges = (globalThis.describedChanges || 0) + 1;`,
      ),
    });
  });
  const lines = async (pages) => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let p = 0; p < pages; p++) {
      const sheet = doc.addPage([400, 500]);
      for (let k = 0; k < 30; k++)
        sheet.drawText(`Line ${k + 1} of page ${p + 1}`, {
          x: 40,
          y: 470 - k * 15,
          size: 10,
          font,
        });
    }
    return Buffer.from(await doc.save());
  };
  await page.goto('/#library');
  const opened = page.waitForEvent('filechooser');
  await page.keyboard.press('ControlOrMeta+o');
  await (
    await opened
  ).setFiles({ name: 'old.pdf', mimeType: 'application/pdf', buffer: await lines(1) });
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Tools' });
  await pane.getByRole('button', { name: 'View more' }).click();
  await pane.getByRole('button', { name: 'Compare files', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Compare files' });
  const chosen = page.waitForEvent('filechooser');
  await dialog.getByRole('button', { name: 'Choose file…' }).click();
  await (
    await chosen
  ).setFiles({ name: 'new.pdf', mimeType: 'application/pdf', buffer: await lines(4) });
  await dialog.getByRole('button', { name: 'Compare', exact: true }).click();
  await expect(page.locator('.compare-summary')).toHaveText(
    '6 changes: 3 insertions, 3 pages inserted',
  );
  // Every line of the inserted pages is marked, and each mark is named after its change.
  const marks = page.locator('.compare-mark.is-insert');
  await expect(marks).toHaveCount(90);
  await expect(marks.first()).toHaveAttribute('title', /^Inserted "Line 1 of page 2 /);
  const described = await page.evaluate(() => globalThis.describedChanges);
  expect(described).toBeLessThanOrEqual(3 * 3);
});
