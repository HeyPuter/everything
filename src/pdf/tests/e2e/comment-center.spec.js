import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { listAnnotations } from '../../src/core/annotations.js';

const settled = (page) => expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');

// The comment tools live in the desktop tools pane; phones reach them through phone-shell.
test.skip(({ isMobile }) => isMobile, 'desktop workspace');

test('comment tools place text boxes, callouts, and shapes from the keyboard', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  const doc = await PDFDocument.create();
  doc.addPage([400, 500]);
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'comment-center.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await settled(page);
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Tools' });
  const center = page.getByRole('button', { name: 'Place at page center', exact: true });

  for (const [tool, title, text] of [
    ['Add text comment', 'Text box', 'Centered box'],
    ['Callout', 'Callout', 'Centered callout'],
  ]) {
    await pane.getByRole('button', { name: tool, exact: true }).click();
    await center.press('Enter');
    const dialog = page.getByRole('dialog', { name: title });
    await dialog.getByLabel('Text').fill(text);
    await dialog.getByRole('button', { name: 'Add', exact: true }).click();
    await settled(page);
  }
  await pane.getByRole('button', { name: 'Shapes', exact: true }).click();
  await center.press('Enter');
  await settled(page);
  await page.getByLabel('Comment shape', { exact: true }).selectOption('arrow');
  await center.press('Enter');
  await settled(page);
  // A freehand stroke or a measurement has no shape to place; the button is not offered.
  await pane.getByRole('button', { name: 'Pencil', exact: true }).click();
  await expect(center).toBeHidden();
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await pane.getByRole('button', { name: 'View more' }).click();
  await pane.getByRole('button', { name: 'Measure', exact: true }).click();
  await pane.getByRole('button', { name: 'Distance', exact: true }).click();
  await expect(page.locator('.tool-hint')).toHaveText('Drag to measure a distance.');
  await expect(center).toBeHidden();

  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const saved = await PDFDocument.load(await readFile(await (await pending).path()));
  const placed = listAnnotations(saved, 0);
  expect(placed.map((entry) => [entry.subtype, entry.contents])).toEqual([
    ['FreeText', 'Centered box'],
    ['FreeText', 'Centered callout'],
    ['Square', ''],
    ['Line', ''],
  ]);
  expect(placed[1].points).toHaveLength(3);
  expect(placed[3].lineEndings).toEqual(['None', 'OpenArrow']);
  // Each lands on the page, around its middle.
  for (const { rect } of placed) {
    expect(rect.x).toBeGreaterThan(0);
    expect(rect.y).toBeGreaterThan(0);
    expect(rect.x + rect.width).toBeLessThan(400);
    expect(rect.y + rect.height).toBeLessThan(500);
    expect(rect.x).toBeLessThan(200);
    expect(rect.x + rect.width).toBeGreaterThan(200);
  }
});
