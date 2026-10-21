import { test, expect } from '@playwright/test';
import { PDFDocument, PDFName, PDFNumber } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { listAnnotations } from '../../src/core/annotations.js';

const settled = (page) => expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');

test.skip(({ isMobile }) => isMobile, 'desktop workspace');

// Large drawings set a UserUnit so their pages fit PDF's coordinate limits; a page unit of
// ten points makes Letter paper 61.2 by 79.2 units.
test('a measurement on a page with large units is labeled like any other', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  const doc = await PDFDocument.create();
  doc.addPage([61.2, 79.2]).node.set(PDFName.of('UserUnit'), PDFNumber.of(10));
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'drawing.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await settled(page);
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Tools' });
  await pane.getByRole('button', { name: 'View more' }).click();
  await pane.getByRole('button', { name: 'Measure', exact: true }).click();
  await pane.getByRole('button', { name: 'Distance', exact: true }).click();
  const paper = await page.locator('.paper').boundingBox();
  const inch = paper.width / 8.5;
  await page.mouse.move(paper.x + inch, paper.y + inch);
  await page.mouse.down();
  await page.mouse.move(paper.x + 3 * inch, paper.y + inch, { steps: 6 });
  await page.mouse.up();
  await expect(page.locator('#toast')).toContainText(/Measured: 2\.0\d in/);
  await settled(page);
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const saved = await PDFDocument.load(await readFile(await (await pending).path()));
  const [line, label] = listAnnotations(saved, 0);
  // Drawn at the sizes of any other page: a 1 point line and a 9 point label.
  expect(line.width * 10).toBeCloseTo(1);
  expect(label.fontSize * 10).toBeCloseTo(9);
});
