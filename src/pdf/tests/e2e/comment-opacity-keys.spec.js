import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { addShapeAnnotation, listAnnotations } from '../../src/core/annotations.js';

const settled = (page) => expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');

async function open(page) {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  addShapeAnnotation(doc, 0, {
    kind: 'square',
    rect: { x: 100, y: 500, width: 120, height: 60 },
    text: 'Box',
  });
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'opacity.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await settled(page);
  await page.getByRole('button', { name: 'Rectangle: Box' }).focus();
  return page.getByRole('complementary', { name: 'Selection properties' }).getByLabel('Opacity');
}
async function saved(page) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  return listAnnotations(await PDFDocument.load(await readFile(await (await pending).path())), 0);
}

// Each arrow key press on a comment's Opacity was saved at once, which drew the panel again
// while the next was pressed: six presses made one step, and each step was an Undo of its own.
test('arrow keys on a comment’s opacity step it once per press, as one edit', async ({ page }) => {
  const opacity = await open(page);
  await opacity.focus();
  for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowLeft');
  await settled(page);
  await expect(opacity).toHaveValue('70');
  await expect(opacity).toBeFocused();
  const undo = page.getByRole('button', { name: 'Undo', exact: true });
  await undo.click();
  await settled(page);
  await expect(undo).toBeDisabled();
  await expect(opacity).toHaveValue('100');
});

test('a download right after the opacity keys includes them', async ({ page }) => {
  const opacity = await open(page);
  await opacity.focus();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  const [box] = await saved(page);
  expect(box.opacity).toBeCloseTo(0.9, 5);
});
