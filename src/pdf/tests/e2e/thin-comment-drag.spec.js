import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { listAnnotations } from '../../src/core/annotations.js';

const settled = (page) => expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');

// The comment tools live in the desktop tools pane; phones reach them through phone-shell.
test.skip(({ isMobile }) => isMobile, 'desktop workspace');

// A drag along a line is a slip of the hand, not a box: a text box placed that way had no
// room to show its words, and a rectangle or oval failed with "too small for its border".
test('a flat drag places a text box as a click does and adds no flat shape', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'thin-drag.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await settled(page);
  const box = await page.locator('.drawing-overlay').boundingBox();
  const flatDrag = async (x, y, rise = 2) => {
    await page.mouse.move(box.x + x, box.y + y);
    await page.mouse.down();
    await page.mouse.move(box.x + x + 150, box.y + y + rise, { steps: 5 });
    await page.mouse.up();
  };
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Tools' });

  await pane.getByRole('button', { name: 'Add text comment', exact: true }).click();
  for (const [rise, text] of [
    [0, 'Level'],
    [3, 'Readable'],
  ]) {
    await flatDrag(60, rise ? 160 : 60, rise);
    const dialog = page.getByRole('dialog', { name: 'Text box' });
    await dialog.getByLabel('Text').fill(text);
    await dialog.getByRole('button', { name: 'Add', exact: true }).click();
    // The comment is added once the dialog has closed; wait for it before the next drag.
    await expect(page.getByRole('button', { name: `Text box on page 1: ${text}` })).toBeVisible();
    await settled(page);
  }

  await pane.getByRole('button', { name: 'Shapes', exact: true }).click();
  for (const shape of ['square', 'circle', 'cloud'])
    for (const rise of [0, 3]) {
      await page.getByLabel('Comment shape', { exact: true }).selectOption(shape);
      await flatDrag(60, 300, rise);
      await settled(page);
    }
  await expect(page.locator('#toast')).not.toContainText(/too small|Choose where/);
  // A flat line is still a line.
  await page.getByLabel('Comment shape', { exact: true }).selectOption('line');
  await flatDrag(60, 400);
  await settled(page);

  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const saved = await PDFDocument.load(await readFile(await (await pending).path()));
  const placed = listAnnotations(saved, 0);
  expect(placed.map((entry) => [entry.subtype, entry.contents])).toEqual([
    ['FreeText', 'Level'],
    ['FreeText', 'Readable'],
    ['Line', ''],
  ]);
  for (const { box: textBox } of placed.slice(0, 2)) {
    expect(textBox.width).toBeCloseTo(180, 0);
    expect(textBox.height).toBeCloseTo(50, 0);
  }
});
