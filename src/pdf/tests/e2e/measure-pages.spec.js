import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { listAnnotations } from '../../src/core/annotations.js';

const settled = (page) => expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');

test.skip(({ isMobile }) => isMobile, 'desktop workspace');

// Corners clicked on one page are not carried to the next: an area measured there is its own.
test('an area measured after turning the page uses only that page’s corners', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
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
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 2');
  await settled(page);
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Tools' });
  await pane.getByRole('button', { name: 'View more' }).click();
  await pane.getByRole('button', { name: 'Measure', exact: true }).click();
  await pane.getByRole('button', { name: 'Area', exact: true }).click();
  const corners = async (points) => {
    const paper = await page.locator('.paper').boundingBox();
    const inch = paper.width / 8.5;
    for (const [x, y] of points) await page.mouse.click(paper.x + x * inch, paper.y + y * inch);
  };
  await corners([
    [5, 6],
    [7, 6],
  ]);
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(page.locator('.page-caption')).toHaveText('Page 2 of 2');
  await settled(page);
  await corners([
    [1, 3],
    [3, 3],
    [3, 5],
    [1, 5],
  ]);
  await page.keyboard.press('Enter');
  await expect(page.locator('#toast')).toContainText(/Measured: 4\.0\d sq in/);
  await settled(page);
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const saved = await PDFDocument.load(await readFile(await (await pending).path()));
  expect(listAnnotations(saved, 0)).toEqual([]);
  const polygon = listAnnotations(saved, 1).find((a) => a.subtype === 'Polygon');
  expect(polygon.points).toHaveLength(4);
});
