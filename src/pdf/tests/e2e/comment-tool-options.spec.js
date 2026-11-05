import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { listAnnotations } from '../../src/core/annotations.js';

const settled = (page) => expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');

test.skip(({ isMobile }) => isMobile, 'desktop workspace');

// The comment tools were meant to offer a line width (Pencil, Shapes) and a text size (text
// box, callout) above the page, but the toolbar hid both as soon as it was shown: every
// drawing was 2 points wide and every text box 12 point text.
test('the comment tools offer a line width and a text size that apply', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  const doc = await PDFDocument.create();
  doc.addPage([400, 400]);
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'tool-options.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await settled(page);
  const sheet = await page.locator('.drawing-overlay').boundingBox();
  const scale = sheet.width / 400;
  const at = (x, y) => [sheet.x + x * scale, sheet.y + (400 - y) * scale];
  const drag = async (from, to) => {
    await page.mouse.move(...at(...from));
    await page.mouse.down();
    await page.mouse.move(...at(...to), { steps: 5 });
    await page.mouse.up();
    await settled(page);
  };
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Tools' });
  const width = page.getByLabel('Stroke width', { exact: true });
  const size = page.getByLabel('Text size', { exact: true });

  await pane.getByRole('button', { name: 'Shapes', exact: true }).click();
  await expect(width).toBeVisible();
  await expect(size).toBeHidden();
  await width.selectOption('4');
  await drag([40, 360], [140, 300]);
  // Still offered after the shape is placed.
  await expect(width).toBeVisible();

  await pane.getByRole('button', { name: 'Pencil', exact: true }).click();
  await expect(width).toBeVisible();
  await width.selectOption('8');
  await drag([200, 360], [300, 300]);

  await pane.getByRole('button', { name: 'Add text comment', exact: true }).click();
  await expect(size).toBeVisible();
  await expect(width).toBeHidden();
  await size.selectOption('20');
  await page.mouse.click(...at(40, 200));
  const dialog = page.getByRole('dialog', { name: 'Text box' });
  await dialog.getByLabel('Text').fill('Larger');
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(dialog).toBeHidden();
  await settled(page);
  await expect(size).toBeVisible();
  await expect(size).toHaveValue('20');

  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const saved = await PDFDocument.load(await readFile(await (await pending).path()));
  const [square, ink, box] = listAnnotations(saved, 0);
  expect([square.subtype, square.width]).toEqual(['Square', 4]);
  expect([ink.subtype, ink.width]).toEqual(['Ink', 8]);
  expect([box.subtype, box.fontSize]).toEqual(['FreeText', 20]);
});
