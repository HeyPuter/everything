import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { listAnnotations } from '../../src/core/annotations.js';

const settled = (page) => expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');

test.skip(({ isMobile }) => isMobile, 'desktop workspace');

const inside = (box, size) =>
  box.x >= -1e-6 &&
  box.y >= -1e-6 &&
  box.x + box.width <= size + 1e-6 &&
  box.y + box.height <= size + 1e-6;

// A text box, callout or note placed with a click by the page's right or bottom edge ran on
// from the click, off the page: only a sliver of it showed, and its words could not be read.
test('comments placed by a click at the page edge land on the page', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  const doc = await PDFDocument.create();
  doc.addPage([400, 400]);
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'edge-placement.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await settled(page);
  const sheet = await page.locator('.drawing-overlay').boundingBox();
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Tools' });

  await pane.getByRole('button', { name: 'Add text comment', exact: true }).click();
  await page.mouse.click(sheet.x + sheet.width - 4, sheet.y + sheet.height - 4);
  let dialog = page.getByRole('dialog', { name: 'Text box' });
  await dialog.getByLabel('Text').fill('Corner');
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(dialog).toBeHidden();
  await settled(page);

  // By the right edge, the callout's box goes to the left of its point.
  await pane.getByRole('button', { name: 'Callout', exact: true }).click();
  await page.mouse.click(sheet.x + sheet.width * 0.97, sheet.y + sheet.height / 2);
  dialog = page.getByRole('dialog', { name: 'Callout' });
  await dialog.getByLabel('Text').fill('Right');
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(dialog).toBeHidden();
  await settled(page);
  // By the top edge, it moves down, still clear of its point.
  await page.mouse.click(sheet.x + sheet.width / 2, sheet.y + 4);
  await dialog.getByLabel('Text').fill('Top');
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(dialog).toBeHidden();
  await settled(page);

  await pane.getByRole('button', { name: 'Sticky note', exact: true }).click();
  await page.mouse.click(sheet.x + sheet.width - 2, sheet.y + sheet.height - 2);
  const note = page
    .getByRole('complementary', { name: 'Selection properties' })
    .locator('textarea');
  await note.fill('Corner note');
  await note.press('Control+Enter');
  await settled(page);

  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const saved = await PDFDocument.load(await readFile(await (await pending).path()));
  const placed = listAnnotations(saved, 0);
  expect(placed.map((entry) => entry.contents)).toEqual(['Corner', 'Right', 'Top', 'Corner note']);
  // A callout's arrowhead may reach past the edge from a point beside it, not its box.
  for (const entry of placed)
    expect(inside(entry.box ?? entry.rect, 400), entry.contents).toBe(true);
  // The text boxes keep their size, against the corner the click was in.
  expect(placed[0].box).toEqual({ x: 220, y: 0, width: 180, height: 50 });
  for (const callout of placed.slice(1, 3)) {
    const [point] = callout.points;
    const { x, y, width, height } = callout.box;
    expect(width).toBeCloseTo(180, 3);
    expect(point.x < x || point.x > x + width || point.y < y || point.y > y + height).toBe(true);
  }
  expect(placed[1].box.x + placed[1].box.width).toBeLessThan(placed[1].points[0].x);
});
