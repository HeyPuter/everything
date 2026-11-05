import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { listAnnotations } from '../../src/core/annotations.js';

const settled = (page) => expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');

test.skip(({ isMobile }) => isMobile, 'desktop workspace');

// A measurement's label sits above the middle of what it measures. One along the top of the
// page had its label above the page, where nobody could read it; one by a side ran off it.
test('a measurement by the edge of the page keeps its label on the page', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  const doc = await PDFDocument.create();
  doc.addPage([400, 400]);
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'measure-edge.pdf',
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
  const sheet = await page.locator('.drawing-overlay').boundingBox();
  const scale = sheet.width / 400;
  const at = (x, y) => [sheet.x + x * scale, sheet.y + (400 - y) * scale];
  const measure = async (from, to) => {
    await page.mouse.move(...at(...from));
    await page.mouse.down();
    await page.mouse.move(...at(...to), { steps: 6 });
    await page.mouse.up();
    await settled(page);
  };
  // Along the top edge, and down the right edge.
  await measure([50, 398], [250, 398]);
  await measure([398, 100], [398, 300]);

  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const saved = await PDFDocument.load(await readFile(await (await pending).path()));
  const [top, side] = listAnnotations(saved, 0);
  for (const { group } of [top, side]) {
    expect(group).toHaveLength(1);
    const [label] = group;
    expect(label.x).toBeGreaterThanOrEqual(0);
    expect(label.y).toBeGreaterThanOrEqual(0);
    expect(label.x + label.width).toBeLessThanOrEqual(400 + 1e-6);
    expect(label.y + label.height).toBeLessThanOrEqual(400 + 1e-6);
  }
  // Beneath the line it measures, clear of it, rather than over it.
  expect(top.group[0].y + top.group[0].height).toBeLessThan(398 - 0.5);
});
