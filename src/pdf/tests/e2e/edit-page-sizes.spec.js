import { test, expect } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { addShapeAnnotation } from '../../src/core/annotations.js';

const settled = (page) => expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');

test.skip(({ isMobile }) => isMobile, 'desktop workspace');

// Fit width follows the widest page. Every page's size used to be read again after each edit,
// and the page was drawn at the zoom the pages read so far allowed, then shrunk again once the
// wide page far down the PDF had been read.
test('an edit and its undo keep a long PDF at the zoom that fits its widest page', async ({
  page,
}) => {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 200; i++)
    doc
      .addPage(i === 190 ? [1000, 612] : [612, 792])
      .drawText(`Page ${i + 1}`, { x: 50, y: 500, size: 14, font });
  addShapeAnnotation(doc, 0, { kind: 'square', rect: { x: 100, y: 100, width: 80, height: 60 } });
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'wide-page.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 200');
  await settled(page);
  const paper = page.locator('.paper');
  const width = () => paper.evaluate((node) => node.getBoundingClientRect().width);
  const room = await page.locator('.workspace').evaluate((node) => node.clientWidth - 120);
  // Opening fits the page once every size is known: a 612 pt page beside a 1,000 pt one.
  await expect.poll(width).toBeCloseTo((room * 612) / 1000, 0);
  const fitted = await width();

  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: 'Rectangle', exact: true }).click();
  await page.keyboard.press('ArrowRight');
  await settled(page);
  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    const node = document.querySelector('.paper');
    window.paperWidths = [];
    new MutationObserver(() => window.paperWidths.push(node.style.width)).observe(node, {
      attributes: true,
      attributeFilter: ['style'],
    });
  });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await settled(page);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await settled(page);
  // Give a late refit, which reading the sizes ends with, the time to happen.
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 1000)));
  const widths = await page.evaluate(() => window.paperWidths.map((value) => parseFloat(value)));
  expect(widths.length).toBeGreaterThan(0);
  for (const value of widths) expect(value).toBeCloseTo(fitted, 0);
});
