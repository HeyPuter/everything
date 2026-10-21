import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { listAnnotations } from '../../src/core/annotations.js';

const settled = (page) => expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');

test.skip(({ isMobile }) => isMobile, 'desktop workspace');
// A locale that writes numbers in its own digits, which the label's fonts do not have.
test.use({ locale: 'ar-EG' });

test('a measurement is labeled in any language', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'measure.pdf',
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
  expect(
    listAnnotations(saved, 0)
      .filter((a) => a.subtype === 'FreeText')
      .map((a) => a.contents),
  ).toEqual([expect.stringMatching(/^2\.0\d in$/)]);
});
