import { test, expect } from '@playwright/test';
import { PDFDocument, PDFName, PDFNull, PDFString } from 'pdf-lib';

test.skip(({ isMobile }) => isMobile, 'desktop workspace');

async function open(page, doc) {
  await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'opens.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
}
/** Where PDF height `y` on a 1400-point page is, measured from the top of the view. */
const fromTop = (page, index, y) =>
  page.evaluate(
    ({ index, y }) => {
      const slot = document
        .querySelector(`.page-slot[data-page="${index}"]`)
        .getBoundingClientRect();
      const view = document.querySelector('.workspace').getBoundingClientRect();
      return slot.top + ((1400 - y) * slot.height) / 1400 - view.top;
    },
    { index, y },
  );

test('a PDF that opens at a place on a page shows that place at the top', async ({ page }) => {
  const doc = await PDFDocument.create();
  for (let i = 0; i < 3; i++) doc.addPage([400, 1400]);
  doc.catalog.set(
    PDFName.of('OpenAction'),
    doc.context.obj([doc.getPage(1).ref, 'XYZ', PDFNull, 300, PDFNull]),
  );
  await open(page, doc);
  await expect(page.locator('.page-caption')).toHaveText('Page 2 of 3');
  await expect.poll(async () => Math.abs(await fromTop(page, 1, 300))).toBeLessThan(2);
});

test('a named opening destination on the first page keeps its place and zoom', async ({ page }) => {
  const doc = await PDFDocument.create();
  for (let i = 0; i < 2; i++) doc.addPage([400, 1400]);
  doc.catalog.set(
    PDFName.of('Names'),
    doc.context.obj({
      Dests: doc.context.obj({
        Names: [PDFString.of('middle'), doc.context.obj([doc.getPage(0).ref, 'XYZ', 0, 700, 1.5])],
      }),
    }),
  );
  doc.catalog.set(
    PDFName.of('OpenAction'),
    doc.context.obj({ S: 'GoTo', D: PDFString.of('middle') }),
  );
  await open(page, doc);
  await expect(page.getByLabel('Zoom', { exact: true })).toHaveValue('1.5');
  await expect.poll(async () => Math.abs(await fromTop(page, 0, 700))).toBeLessThan(2);
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 2');
});
