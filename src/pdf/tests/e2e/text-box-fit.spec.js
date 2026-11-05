import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { listAnnotations } from '../../src/core/annotations.js';

const settled = (page) => expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');

test.skip(({ isMobile }) => isMobile, 'desktop workspace');

// A text box or callout placed with a click was 50 points tall whatever was typed into it:
// the lines that did not fit were cut off at its bottom edge, out of sight.
test('a clicked text box and callout grow to show every line typed', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  const doc = await PDFDocument.create();
  doc.addPage([400, 400]);
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'text-box-fit.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await settled(page);
  const sheet = await page.locator('.drawing-overlay').boundingBox();
  const scale = sheet.width / 400;
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Tools' });
  const words = 'One\nTwo\nThree\nFour\nFive\nSix';
  for (const [tool, x, y] of [
    ['Add text comment', 40, 60],
    ['Callout', 40, 250],
  ]) {
    await pane.getByRole('button', { name: tool, exact: true }).click();
    await page.mouse.click(sheet.x + x * scale, sheet.y + y * scale);
    const dialog = page.getByRole('dialog', { name: tool === 'Callout' ? 'Callout' : 'Text box' });
    await dialog.getByLabel('Text').fill(words);
    await dialog.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(dialog).toBeHidden();
    await settled(page);
  }
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const saved = await PDFDocument.load(await readFile(await (await pending).path()));
  const [box, callout] = listAnnotations(saved, 0);
  // Six lines of 12 point text, and the top where it was clicked.
  expect(box.box.height).toBeGreaterThan(6 * 12 * 1.2);
  expect(box.box.y + box.box.height).toBeCloseTo(400 - 60, 0);
  expect(callout.box.height).toBeGreaterThan(6 * 12 * 1.2);
  expect(box.box.width).toBeCloseTo(180, 3);
});
