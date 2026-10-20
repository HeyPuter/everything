import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { listAnnotations } from '../../src/core/annotations.js';

const settled = (page) => expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');

// The comment tools live in the desktop tools pane; phones reach them through phone-shell.
test.skip(({ isMobile }) => isMobile, 'desktop workspace');

/** Drag on the 400 pt square page from one PDF point to another, holding Shift. */
async function shiftDrag(page, from, to) {
  const box = await page.locator('.drawing-overlay').boundingBox();
  const scale = box.width / 400;
  const at = (p) => [box.x + p.x * scale, box.y + (400 - p.y) * scale];
  await page.mouse.move(...at(from));
  await page.mouse.down();
  await page.keyboard.down('Shift');
  await page.mouse.move(...at(to), { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await settled(page);
}

test('Shift keeps comment shapes regular, as the preview shows', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  const doc = await PDFDocument.create();
  doc.addPage([400, 400]);
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'comment-shapes.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await settled(page);
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Tools' });
  await pane.getByRole('button', { name: 'Shapes', exact: true }).click();
  await expect(page.locator('.tool-hint')).toContainText('Hold Shift to keep it regular.');
  await shiftDrag(page, { x: 40, y: 360 }, { x: 140, y: 300 });
  await page.getByLabel('Comment shape', { exact: true }).selectOption('line');
  await shiftDrag(page, { x: 200, y: 200 }, { x: 300, y: 230 });

  // Pressing Shift mid-drag updates the preview at once, before the pointer moves again.
  await page.getByLabel('Comment shape', { exact: true }).selectOption('circle');
  const overlay = page.locator('.drawing-overlay');
  const box = await overlay.boundingBox();
  const pixels = () => overlay.evaluate((canvas) => canvas.toDataURL());
  await page.mouse.move(box.x + box.width * 0.1, box.y + box.height * 0.6);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.7, { steps: 3 });
  const oval = await pixels();
  await page.keyboard.down('Shift');
  await expect.poll(async () => (await pixels()) === oval).toBe(false);
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await settled(page);

  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const saved = await PDFDocument.load(await readFile(await (await pending).path()));
  const [square, line, circle] = listAnnotations(saved, 0);
  expect(square.subtype).toBe('Square');
  // 100 by 60 became 60 by 60, anchored at the start corner.
  expect(square.box.width).toBeCloseTo(60, 0);
  expect(square.box.height).toBeCloseTo(60, 0);
  expect(square.box.x).toBeCloseTo(40, 0);
  expect(square.box.y + square.box.height).toBeCloseTo(360, 0);
  // A 17 degree drag snapped to level, keeping its length.
  expect(line.subtype).toBe('Line');
  const [start, end] = line.points;
  expect(end.y).toBeCloseTo(start.y, 1);
  expect(end.x - start.x).toBeCloseTo(Math.hypot(100, 30), 0);
  expect(circle.subtype).toBe('Circle');
  expect(circle.box.width).toBeCloseTo(circle.box.height, 1);
});
