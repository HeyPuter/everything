import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import {
  addCallout,
  addInkAnnotation,
  addShapeAnnotation,
  listAnnotations,
} from '../../src/core/annotations.js';

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

// A line's box is mostly empty page. Only the line takes the pointer, so the text, notes, and
// pencil strokes beside it in that box can still be reached.
test('a line, a drawing, and a callout take clicks only where they are drawn', async ({ page }) => {
  // Tall enough for the whole page above the zoom controls.
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.route('https://js.puter.com/**', (route) => route.abort());
  const doc = await PDFDocument.create();
  doc.addPage([400, 400]).drawText('Words beside the arrow', { x: 220, y: 330, size: 12 });
  addShapeAnnotation(doc, 0, {
    kind: 'arrow',
    points: [
      { x: 20, y: 380 },
      { x: 380, y: 20 },
    ],
  });
  addInkAnnotation(doc, 0, {
    strokes: [
      [
        { x: 40, y: 60 },
        { x: 40, y: 160 },
      ],
      [
        { x: 160, y: 60 },
        { x: 160, y: 160 },
      ],
    ],
  });
  await addCallout(doc, 0, {
    rect: { x: 220, y: 200, width: 120, height: 40 },
    anchor: { x: 40, y: 260 },
    text: 'Look',
  });
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'thin-targets.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await settled(page);
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  const box = await page.locator('.drawing-overlay').boundingBox();
  const scale = box.width / 400;
  const at = (x, y) => [box.x + x * scale, box.y + (400 - y) * scale];
  const hit = (x, y) =>
    page.evaluate(
      ([px, py]) =>
        document.elementFromPoint(px, py)?.closest('button')?.getAttribute('aria-label'),
      at(x, y),
    );
  // On each drawn line, its comment; beside it, inside its box, what lies beneath.
  expect(await hit(200, 200)).toBe('Line');
  expect(await hit(379, 21)).toBe('Line');
  expect(await hit(40, 100)).toBe('Drawing');
  expect(await hit(100, 100)).not.toBe('Drawing');
  expect(await hit(120, 240)).toBe('Text box: Look');
  expect(await hit(280, 220)).toBe('Text box: Look');
  expect(await hit(100, 200)).not.toBe('Text box: Look');
  expect(await hit(240, 334)).toBe('Edit text: Words beside the arrow');
  await page.mouse.dblclick(...at(240, 334));
  await expect(page.getByRole('textbox', { name: 'Edit text' })).toBeFocused();
  await page.keyboard.press('Escape');
  await settled(page);
  // The line itself still selects and drags.
  await page.mouse.move(...at(200, 200));
  await page.mouse.down();
  await page.mouse.move(...at(220, 200), { steps: 4 });
  await page.mouse.up();
  await settled(page);
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const saved = await PDFDocument.load(await readFile(await (await pending).path()));
  const [line] = listAnnotations(saved, 0);
  expect(line.points[0].x).toBeCloseTo(40, 0);
});
