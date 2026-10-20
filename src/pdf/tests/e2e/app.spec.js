import { clickAway, pasteText } from './editing-helpers.js';
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFHexString,
  StandardFonts,
  decodePDFRawStream,
  degrees,
} from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { listHighlights } from '../../src/core/highlight.js';
import { inspectImages } from '../../src/core/image-edit.js';
import { inspectPaths, pathColorHex } from '../../src/core/path-edit.js';
import { drawMark } from '../../src/core/document.js';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { parentCyclePdf, repeatedFieldTree } from '../fixtures/form-cycles.js';

async function extractedText(bytes) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    standardFontDataUrl: new URL('../../node_modules/pdfjs-dist/standard_fonts/', import.meta.url)
      .pathname,
  });
  try {
    return (await (await (await task.promise).getPage(1)).getTextContent()).items;
  } finally {
    await task.destroy();
  }
}
for (const [rotation, dx, dy] of [
  [0, 5, -0.5],
  [90, 0.5, 5],
  [180, -5, 0.5],
  [270, -0.5, -5],
])
  test(`positions existing text on rotated crop ${rotation} with physical point controls`, async ({
    page,
  }) => {
    await mockPuter(page);
    await page.goto('/#library');
    const doc = await PDFDocument.create(),
      p = doc.addPage([400, 400]);
    p.setRotation(degrees(rotation));
    p.setCropBox(20, 20, 360, 360);
    p.node.set(PDFName.of('UserUnit'), PDFNumber.of(2));
    p.drawText('Original text', { x: 80, y: 250, size: 18 });
    p.drawText('Neighbor', { x: 220, y: 150, size: 18 });
    await openPdf(page, doc);
    await page.getByRole('button', { name: 'Text', exact: true }).click();
    const target = page.getByRole('button', { name: 'Edit text: Original text', exact: true });
    await target.click();
    await expect(page.locator('.text-draft-background')).toBeVisible();
    await expect(page.getByLabel('Text X in points', { exact: true })).toHaveValue('160');
    await expect(page.getByLabel('Text Y in points', { exact: true })).toHaveValue('500');
    const move = page.getByRole('button', { name: 'Move text', exact: true });
    await move.press('Shift+ArrowRight');
    await move.press('ArrowDown');
    await expect(page.locator('.save-status')).toHaveText('Unsaved changes');
    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download', exact: true }).click();
    const items = await extractedText(new Uint8Array(await readFile(await (await pending).path()))),
      edited = items.find((i) => i.str === 'Original text'),
      neighbor = items.find((i) => i.str === 'Neighbor');
    expect(edited.transform[4]).toBeCloseTo(80 + dx, 5);
    expect(edited.transform[5]).toBeCloseTo(250 + dy, 5);
    expect(neighbor.transform[4]).toBe(220);
    expect(neighbor.transform[5]).toBe(150);
    await expect(page.locator('.text-draft-background')).toHaveCount(0);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeEnabled();
    await target.click();
    await move.press('ArrowRight');
    await move.press('Escape');
    await expect(page.getByRole('textbox', { name: 'Edit text', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  });

test('drags existing text with a clean preview and edits numeric positions through reopen', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create(),
    p = doc.addPage([400, 400]);
  p.drawText('Move this text', { x: 60, y: 220, size: 18 });
  await openPdf(page, doc);
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  await page.getByRole('button', { name: 'Edit text: Move this text', exact: true }).click();
  const move = page.getByRole('button', { name: 'Move text', exact: true }),
    box = await move.boundingBox(),
    scale = (await page.locator('.paper').boundingBox()).width / 400;
  await page.mouse.move(box.x + box.width / 2, box.y + 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 10 * scale, box.y + 2 + 20 * scale, {
    steps: 5,
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: box.x + box.width / 2 + 20 * scale,
    y: box.y + 2 + 30 * scale,
    button: 'left',
    clickCount: 1,
  });
  await expect(page.getByLabel('Text X in points', { exact: true })).toHaveValue('80');
  await expect(page.getByLabel('Text Y in points', { exact: true })).toHaveValue('190');
  await expect(page.locator('.page-text-input')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  const x = page.getByLabel('Text X in points', { exact: true }),
    y = page.getByLabel('Text Y in points', { exact: true });
  await x.fill('100');
  await x.press('Tab');
  await y.fill('160');
  await y.press('Tab');
  await page.getByRole('textbox', { name: 'Edit text', exact: true }).fill('Moved and edited');
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const bytes = new Uint8Array(await readFile(await (await pending).path())),
    item = (await extractedText(bytes)).find((i) => i.str === 'Moved and edited');
  expect(item.transform[4]).toBe(100);
  expect(item.transform[5]).toBe(160);
  await page.getByRole('button', { name: 'Back to your PDFs', exact: true }).click();
  await openPdf(page, await PDFDocument.load(bytes));
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  await page.getByRole('button', { name: 'Edit text: Moved and edited', exact: true }).click();
  await expect(x).toHaveValue('100');
  await expect(y).toHaveValue('160');
  await page.keyboard.press('Escape');
  await expect(page.locator('.text-draft-background')).toHaveCount(0);
});

test('text touch dragging ignores another finger and can cancel without changing the document', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  doc.addPage([400, 400]).drawText('Touch text', { x: 60, y: 220, size: 18 });
  await openPdf(page, doc);
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  await page.getByRole('button', { name: 'Edit text: Touch text', exact: true }).click();
  const box = await page.getByRole('button', { name: 'Move text', exact: true }).boundingBox(),
    cdp = await page.context().newCDPSession(page);
  const first = { id: 1, x: box.x + box.width / 2, y: box.y + 2 },
    second = { id: 2, x: box.x + box.width + 20, y: box.y + box.height + 30 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [first] });
  first.x += 20;
  first.y += 15;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [first] });
  await expect(page.locator('.save-status')).toHaveText('Unsaved changes');
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [first, second] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [second] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
  await expect(page.getByLabel('Text X in points', { exact: true })).toHaveValue('60');
  await expect(page.getByLabel('Text Y in points', { exact: true })).toHaveValue('220');
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await expect(page.locator('.save-status')).toHaveText('Local file');
  await page.keyboard.press('Escape');
  await expect(page.locator('.text-draft-background')).toHaveCount(0);
});

test('new text can be positioned before insertion with physical coordinates and keyboard movement', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  doc.addPage([400, 400]);
  await openPdf(page, doc);
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  await page.getByRole('button', { name: 'Place at page center', exact: true }).click();
  await page.getByRole('textbox', { name: 'Text to add', exact: true }).fill('Positioned new text');
  const x = page.getByLabel('Text X in points', { exact: true }),
    y = page.getByLabel('Text Y in points', { exact: true });
  await x.fill('120');
  await x.press('Tab');
  await y.fill('140');
  await y.press('Tab');
  await page.getByRole('button', { name: 'Move text', exact: true }).press('Shift+ArrowUp');
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const item = (
    await extractedText(new Uint8Array(await readFile(await (await pending).path())))
  ).find((i) => i.str === 'Positioned new text');
  expect(item.transform[4]).toBe(120);
  expect(item.transform[5]).toBe(150);
});

test('edits existing shapes with live movement, numeric resizing, export, reopen and undo', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  doc.addPage([400, 400]);
  drawMark(doc, 0, {
    type: 'shape',
    hex: '#dd2200',
    width: 2,
    rect: { x: 40, y: 220, width: 80, height: 60 },
  });
  const original = inspectPaths(doc, 0)[0].transform;
  await openPdf(page, doc);
  const target = page.getByRole('button', { name: 'Select shape 1', exact: true });
  const box = await target.boundingBox(),
    scale = (await page.locator('.paper').boundingBox()).width / 400;
  // Select the visible outline, then move it while the original path disappears from the preview.
  await page.mouse.move(box.x + scale, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 41 * scale, box.y + box.height / 2 + 50 * scale, { steps: 5 });
  await expect(page.locator('.image-preview')).toBeVisible();
  await page.mouse.up();
  await expect(page.getByLabel('Shape width in points', { exact: true })).toBeEnabled();
  await page.getByLabel('Keep shape proportions', { exact: true }).uncheck();
  await page.getByLabel('Shape width in points', { exact: true }).fill('123');
  await page.getByLabel('Shape width in points', { exact: true }).press('Enter');
  await expect(page.getByLabel('Shape width in points', { exact: true })).toHaveValue('123');
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const exported = await PDFDocument.load(await readFile(await (await pending).path())),
    paths = inspectPaths(exported, 0);
  expect(paths).toHaveLength(1);
  paths[0].transform.forEach((v, i) =>
    expect(v).toBeCloseTo([123, 0, 0, 62, original[4] + 40, original[5] - 50][i], 1),
  );
  await page.getByRole('button', { name: 'Back to your PDFs', exact: true }).click();
  await openPdf(page, exported);
  await target.focus();
  await target.press('Enter');
  const move = page.getByRole('button', { name: 'Move selected shape', exact: true });
  await move.press('ArrowRight');
  await move.press('Escape');
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Delete shape', exact: true }).click();
  await expect(target).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(target).toHaveCount(1);
});

for (const [rotation, dx, dy] of [
  [0, 5, -0.5],
  [90, 0.5, 5],
  [180, -5, 0.5],
  [270, -0.5, -5],
])
  test(`shape editing follows rotated crop ${rotation} and UserUnit`, async ({ page }) => {
    await mockPuter(page);
    await page.goto('/#library');
    const doc = await PDFDocument.create(),
      pdfPage = doc.addPage([400, 400]);
    pdfPage.setRotation(degrees(rotation));
    pdfPage.setCropBox(20, 20, 360, 360);
    pdfPage.node.set(PDFName.of('UserUnit'), PDFNumber.of(2));
    drawMark(doc, 0, {
      type: 'shape',
      hex: '#dd2200',
      width: 2,
      rect: { x: 100, y: 150, width: 80, height: 60 },
    });
    const original = inspectPaths(doc, 0)[0].transform;
    await openPdf(page, doc);
    await page.getByLabel('Zoom', { exact: true }).selectOption('0.5');
    const target = page.getByRole('button', { name: 'Select shape 1', exact: true });
    await expect(page.locator('.paper')).toHaveCSS('width', '360px');
    await expect(target).toBeEnabled();
    await target.focus();
    await target.press('Enter');
    const move = page.getByRole('button', { name: 'Move selected shape', exact: true });
    await move.press('Shift+ArrowRight');
    await move.press('ArrowDown');
    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download', exact: true }).click();
    const path = inspectPaths(
      await PDFDocument.load(await readFile(await (await pending).path())),
      0,
    )[0];
    expect(path.transform[4]).toBeCloseTo(original[4] + dx, 5);
    expect(path.transform[5]).toBeCloseTo(original[5] + dy, 5);
    await page.getByLabel('Zoom', { exact: true }).selectOption('0.75');
    await expect(move).toBeVisible();
    const strokeWidth = page.getByLabel('Shape stroke width in points', { exact: true });
    await expect(strokeWidth).toHaveValue('4');
    await strokeWidth.fill('12');
    await strokeWidth.press('Enter');
    await expect(strokeWidth).toBeEnabled();
    await expect(strokeWidth).toBeFocused();
    const restyled = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download', exact: true }).click();
    const styled = inspectPaths(
      await PDFDocument.load(await readFile(await (await restyled).path())),
      0,
    )[0];
    expect(styled.state.width).toBeCloseTo(6, 6);
    expect(styled.ctm).toEqual(path.ctm);
  });

test('touch selects a shape outline, cancels its draft and commits a later drag', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  doc.addPage([400, 400]);
  drawMark(doc, 0, {
    type: 'shape',
    hex: '#dd2200',
    width: 2,
    rect: { x: 80, y: 140, width: 80, height: 60 },
  });
  await openPdf(page, doc);
  const box = await page.getByRole('button', { name: 'Select shape 1', exact: true }).boundingBox(),
    scale = (await page.locator('.paper').boundingBox()).width / 400;
  const touch = { id: 1, x: box.x + scale, y: box.y + box.height / 2 },
    cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [touch] });
  const move = page.getByRole('button', { name: 'Move selected shape', exact: true });
  await expect(move).toBeVisible();
  touch.x += 20;
  touch.y += 10;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [touch] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  const restored = await move.boundingBox();
  expect(restored.x).toBeCloseTo(box.x, 1);
  expect(restored.y).toBeCloseTo(box.y, 1);
  touch.x = box.x + box.width / 2;
  touch.y = box.y + box.height / 2;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [touch] });
  touch.x += 20;
  touch.y += 10;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [touch] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
  const moved = await move.boundingBox();
  expect(moved.x - box.x).toBeCloseTo(20, 0);
  expect(moved.y - box.y).toBeCloseTo(10, 0);
});

test('restyles native shapes and drawings, preserving focus, export and undo', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create(),
    p = doc.addPage([400, 400]);
  p.node.set(
    PDFName.of('Contents'),
    doc.context.register(
      doc.context.flateStream(
        '1 0 0 rg 0 0 1 RG 2 w 40 220 80 60 re B 240 220 80 60 re B 1 J 1 j 40 100 m 80 140 l 120 100 l S',
      ),
    ),
  );
  await openPdf(page, doc);
  const target = page.getByRole('button', { name: 'Select shape 1', exact: true });
  await target.click();
  const accessibility = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(accessibility.violations).toEqual([]);
  const fill = page.getByLabel('Shape fill color', { exact: true });
  await fill.fill('#00ff00');
  await fill.dispatchEvent('change');
  await expect(fill).toBeEnabled();
  await expect(fill).toHaveValue('#00ff00');
  const stroke = page.getByLabel('Shape stroke color', { exact: true });
  await stroke.fill('#ff00ff');
  await stroke.dispatchEvent('change');
  await expect(stroke).toBeEnabled();
  const width = page.getByLabel('Shape stroke width in points', { exact: true });
  await width.fill('8');
  await width.press('Enter');
  await expect(width).toBeEnabled();
  await expect(width).toBeFocused();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const exported = await PDFDocument.load(await readFile(await (await pending).path())),
    paths = inspectPaths(exported, 0);
  expect(pathColorHex(paths[0].state.fill)).toBe('#00ff00');
  expect(pathColorHex(paths[0].state.stroke)).toBe('#ff00ff');
  expect(paths[0].state.width).toBe(8);
  expect(paths[1].state.fill).toBe('1 0 0 rg');
  expect(paths[1].state.width).toBe(2);
  await page.getByRole('button', { name: 'Back to your PDFs', exact: true }).click();
  await openPdf(page, exported);
  const drawing = page.getByRole('button', { name: 'Select drawing 1', exact: true });
  await drawing.focus();
  await drawing.press('Enter');
  await expect(page.getByLabel('Drawing fill color', { exact: true })).toHaveCount(0);
  const ink = page.getByLabel('Drawing stroke color', { exact: true });
  await ink.fill('#009900');
  await ink.dispatchEvent('change');
  await expect(ink).toBeEnabled();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeEnabled();
  await drawing.focus();
  await drawing.press('Enter');
  await expect(ink).toHaveValue('#0000ff');
  const drawingFill = page.getByLabel('Drawing fill enabled', { exact: true });
  await drawingFill.check();
  await expect(drawingFill).toBeEnabled();
  await expect(drawingFill).toBeFocused();
  await expect(page.getByLabel('Drawing fill color', { exact: true })).toHaveValue('#ff0000');
  await expect(drawing).toHaveAttribute('aria-pressed', 'true');
});

for (const rotation of [0, 90])
  test(`shape fill and stroke toggles survive unpainted export and reopening at ${rotation} degrees`, async ({
    page,
  }) => {
    await mockPuter(page);
    await page.goto('/#library');
    const doc = await PDFDocument.create(),
      p = doc.addPage([400, 400]);
    p.setRotation(degrees(rotation));
    p.setCropBox(20, 20, 360, 360);
    p.node.set(PDFName.of('UserUnit'), PDFNumber.of(2));
    p.node.set(
      PDFName.of('Contents'),
      doc.context.register(
        doc.context.flateStream(
          '1 0 0 rg 0 0 1 RG 2 w 40 220 80 60 re 55 235 50 30 re f* 240 220 80 60 re B',
        ),
      ),
    );
    await openPdf(page, doc);
    await page.getByLabel('Zoom', { exact: true }).selectOption('0.5');
    const target = page.getByRole('button', { name: 'Select shape 1', exact: true }),
      fill = page.getByLabel('Shape fill enabled', { exact: true }),
      stroke = page.getByLabel('Shape stroke enabled', { exact: true });
    await target.focus();
    await target.press('Enter');
    await expect(fill).toBeChecked();
    await expect(stroke).not.toBeChecked();
    await stroke.check();
    await expect(stroke).toBeEnabled();
    await expect(stroke).toBeFocused();
    const panelBox = await page
        .getByRole('group', { name: 'Edit shape', exact: true })
        .boundingBox(),
      shapeBox = await page
        .getByRole('button', { name: 'Move selected shape', exact: true })
        .boundingBox();
    expect(
      Math.max(
        0,
        Math.min(panelBox.x + panelBox.width, shapeBox.x + shapeBox.width) -
          Math.max(panelBox.x, shapeBox.x),
      ) *
        Math.max(
          0,
          Math.min(panelBox.y + panelBox.height, shapeBox.y + shapeBox.height) -
            Math.max(panelBox.y, shapeBox.y),
        ),
    ).toBe(0);
    await expect(page.getByLabel('Shape stroke width in points', { exact: true })).toHaveValue('4');
    await fill.uncheck();
    await expect(fill).toBeEnabled();
    await expect(page.getByLabel('Shape fill color', { exact: true })).toHaveCount(0);
    await stroke.uncheck();
    await expect(stroke).toBeEnabled();
    await expect(fill).not.toBeChecked();
    await expect(stroke).not.toBeChecked();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download', exact: true }).click();
    const bytes = await readFile(await (await download).path());
    const saved = await PDFDocument.load(bytes),
      paths = inspectPaths(saved, 0);
    expect(paths).toHaveLength(2);
    expect(paths[0].invisible).toBe(true);
    expect(paths[0].fillRule).toBe('evenodd');
    expect(paths[1].filled && paths[1].stroked).toBe(true);
    await page.getByRole('button', { name: 'Back to your PDFs', exact: true }).click();
    await openPdf(page, saved);
    const fitted = await page.locator('.paper').evaluate((node) => node.style.width);
    await page.getByLabel('Zoom', { exact: true }).selectOption('0.5');
    // The zoom change re-renders the page; its object targets exist again once that finishes.
    await expect(page.locator('.paper')).not.toHaveCSS('width', fitted);
    await expect(page.locator('.paper')).toHaveAttribute('aria-busy', 'false');
    await expect(target).toBeVisible();
    const box = await target.boundingBox();
    await target.click({ position: { x: 1, y: box.height / 2 } });
    await expect(fill).not.toBeChecked();
    await expect(stroke).not.toBeChecked();
    await fill.check();
    await expect(fill).toBeEnabled();
    await expect(page.getByLabel('Shape fill color', { exact: true })).toHaveValue('#ff0000');
    await stroke.check();
    await expect(stroke).toBeEnabled();
    await expect(page.getByLabel('Shape stroke color', { exact: true })).toHaveValue('#0000ff');
    expect(
      (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
        .violations,
    ).toEqual([]);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeEnabled();
    await target.focus();
    await target.press('Enter');
    await expect(fill).toBeChecked();
    await expect(stroke).not.toBeChecked();
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await expect(target).toBeEnabled();
    await target.focus();
    await target.press('Enter');
    await expect(fill).toBeChecked();
    await expect(stroke).toBeChecked();
  });

test('outline shape selection leaves its empty interior available for images and text', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await imagePdf();
  drawMark(doc, 0, {
    type: 'shape',
    hex: '#dd2200',
    width: 2,
    rect: { x: 35, y: 215, width: 90, height: 70 },
  });
  doc.getPage(0).drawText('Selectable inside', { x: 42, y: 245, size: 7 });
  await openPdf(page, doc);
  const image = page.getByRole('button', { name: 'Select image 1', exact: true }),
    box = await image.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 4);
  await expect(
    page.getByRole('button', { name: 'Move selected image', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Close image editor', exact: true }).click();
  await page.getByRole('button', { name: 'Edit text: Selectable inside', exact: true }).dblclick();
  await expect(page.getByRole('textbox', { name: 'Edit text', exact: true })).toBeEditable();
  await expect(page.locator('.image-controls')).toBeHidden();
});

test('new freehand strokes reopen as one drawing with keyboard movement and deletion', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  doc.addPage([400, 400]);
  await openPdf(page, doc);
  await page.getByRole('button', { name: 'Draw', exact: true }).click();
  const box = await page.locator('.drawing-overlay').boundingBox();
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.4);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3, { steps: 5 });
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.4, { steps: 5 });
  await page.mouse.up();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const exported = await PDFDocument.load(await readFile(await (await pending).path())),
    paths = inspectPaths(exported, 0);
  expect(paths).toHaveLength(1);
  expect(paths[0].kind).toBe('drawing');
  await page.getByRole('button', { name: 'Back to your PDFs', exact: true }).click();
  await openPdf(page, exported);
  const target = page.getByRole('button', { name: 'Select drawing 1', exact: true });
  await target.focus();
  await target.press('Enter');
  await page
    .getByRole('button', { name: 'Move selected drawing', exact: true })
    .press('Shift+ArrowRight');
  const changed = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const after = inspectPaths(
    await PDFDocument.load(await readFile(await (await changed).path())),
    0,
  );
  expect(after).toHaveLength(1);
  expect(after[0].transform[4]).toBeCloseTo(paths[0].transform[4] + 10, 4);
  await page.getByRole('button', { name: 'Delete drawing', exact: true }).click();
  await expect(target).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(target).toHaveCount(1);
});

async function imagePdf({ rotation = 0, userUnit = 1 } = {}) {
  const doc = await PDFDocument.create(),
    page = doc.addPage([400, 400]);
  page.setRotation(degrees(rotation));
  page.node.set(PDFName.of('UserUnit'), PDFNumber.of(userUnit));
  const canvas = createCanvas(40, 30),
    ctx = canvas.getContext('2d');
  ctx.fillStyle = '#dd2200';
  ctx.fillRect(0, 0, 40, 30);
  ctx.fillStyle = '#0088ee';
  ctx.fillRect(20, 0, 20, 15);
  const image = await doc.embedPng(canvas.toBuffer('image/png'));
  page.drawImage(image, { x: 40, y: 220, width: 80, height: 60 });
  page.drawImage(image, { x: 240, y: 220, width: 80, height: 60 });
  page.drawText('Image editing fixture', { x: 40, y: 330, size: 20 });
  return doc;
}

for (const [rotation, dx, dy] of [
  [0, 5, -0.5],
  [90, 0.5, 5],
  [180, -5, 0.5],
  [270, -0.5, -5],
])
  test(`keyboard image movement follows screen directions on rotated crop ${rotation} with UserUnit`, async ({
    page,
  }) => {
    await mockPuter(page);
    await page.goto('/#library');
    const doc = await imagePdf({ rotation, userUnit: 2 });
    doc.getPage(0).setCropBox(20, 20, 360, 360);
    await openPdf(page, doc);
    await page.getByLabel('Zoom', { exact: true }).selectOption('0.5');
    await page.getByRole('button', { name: 'Select image 1', exact: true }).click();
    const move = page.getByRole('button', { name: 'Move selected image', exact: true });
    await move.press('Shift+ArrowRight');
    await move.press('ArrowDown');
    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download', exact: true }).click();
    const result = inspectImages(
      await PDFDocument.load(await readFile(await (await pending).path())),
      0,
    )[0];
    expect(result.transform[4]).toBeCloseTo(40 + dx, 5);
    expect(result.transform[5]).toBeCloseTo(220 + dy, 5);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Select image 1', exact: true }).click();
    await page.getByLabel('Zoom', { exact: true }).selectOption('0.75');
    await expect(move).toBeVisible();
    await expect(move).toBeEnabled();
    await move.press('ArrowRight');
    await move.press('Escape');
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  });

for (const releaseOutside of [false, true])
  test(`holding an image movement arrow produces one undoable action (release outside ${releaseOutside})`, async ({
    page,
  }) => {
    await mockPuter(page);
    await page.goto('/#library');
    await openPdf(page, await imagePdf());
    await page.getByRole('button', { name: 'Select image 1', exact: true }).click();
    const move = page.getByRole('button', { name: 'Move selected image', exact: true });
    await expect(move).toBeFocused();
    const target = page.getByRole('button', { name: 'Select image 1', exact: true });
    const left = async () => {
      const bounds = await target.boundingBox();
      const paper = await page.locator('.paper').boundingBox();
      // Committing a keyboard move redraws the target. Retry while either box is absent.
      return bounds && paper ? bounds.x - paper.x : NaN;
    };
    const originalLeft = await left();
    const scale = (await page.locator('.paper').boundingBox()).width / 400;
    await page.keyboard.down('ArrowRight');
    // The native repeat delay exceeds the short debounce used for separate nudges.
    await page.waitForTimeout(500);
    await expect(move).toBeFocused();
    await page.keyboard.down('ArrowRight');
    await page.keyboard.down('ArrowRight');
    const download = page.getByRole('button', { name: 'Download', exact: true });
    if (releaseOutside) await download.focus();
    await page.keyboard.up('ArrowRight');
    // The page target catches up only after the keyboard draft has actually committed.
    await expect.poll(left).toBeCloseTo(originalLeft + 3 * scale, 1);
    if (releaseOutside) await expect(download).toBeFocused();
    const x = async () => {
      const pending = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Download', exact: true }).click();
      return inspectImages(
        await PDFDocument.load(await readFile(await (await pending).path())),
        0,
      )[0].transform[4];
    };
    expect(await x()).toBeCloseTo(43, 5);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    expect(await x()).toBeCloseTo(40, 5);
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    expect(await x()).toBeCloseTo(43, 5);
  });

test('image selection commits pending form values and leaves text over an image editable', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await imagePdf();
  const field = doc.getForm().createTextField('Name');
  field.addToPage(doc.getPage(0), { x: 40, y: 100, width: 200, height: 30 });
  doc.getPage(0).drawText('Words on an image', { x: 42, y: 230, size: 7 });
  await openPdf(page, doc);
  await page.getByRole('button', { name: 'Edit text: Words on an image', exact: true }).dblclick();
  const input = page.getByRole('textbox', { name: 'Edit text', exact: true });
  await expect(input).toBeEditable();
  await expect(page.locator('.image-controls')).toBeHidden();
  await expect(input).toHaveValue('Words on an image');
  await input.press('Escape');
  await page.getByLabel('Name (on page)', { exact: true }).fill('Keep my name');
  await page.getByRole('button', { name: 'Select image 2', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Move selected image', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Move selected image', exact: true }).press('Delete');
  await expect(page.locator('.image-target')).toHaveCount(1);
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const exported = await PDFDocument.load(await readFile(await (await pending).path()));
  expect(exported.getForm().getTextField('Name').getText()).toBe('Keep my name');
  expect(inspectImages(exported, 0)).toHaveLength(1);
});

test('image touch gestures ignore a second finger and cancel without creating history', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await imagePdf());
  const box = await page.getByRole('button', { name: 'Select image 1', exact: true }).boundingBox();
  const other = await page
    .getByRole('button', { name: 'Select image 2', exact: true })
    .boundingBox();
  const first = { id: 1, x: box.x + box.width / 2, y: box.y + box.height / 2 },
    second = { id: 2, x: other.x + other.width / 2, y: other.y + other.height / 2 };
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [first] });
  await expect(
    page.getByRole('button', { name: 'Move selected image', exact: true }),
  ).toBeVisible();
  first.x += 20;
  first.y += 10;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [first] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [first, second] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [second] });
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await expect(page.locator('.save-status')).toHaveText('Local file');
  const move = page.getByRole('button', { name: 'Move selected image', exact: true });
  const restored = await move.boundingBox();
  expect(restored.x).toBeCloseTo(box.x, 1);
  expect(restored.y).toBeCloseTo(box.y, 1);
  first.x = box.x + box.width / 2;
  first.y = box.y + box.height / 2;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [first] });
  first.x += 20;
  first.y += 10;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [first] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(move).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
  const moved = await move.boundingBox();
  expect(moved.x - box.x).toBeCloseTo(20, 0);
  expect(moved.y - box.y).toBeCloseTo(10, 0);
});

test('resizing the window commits a pending image nudge and preserves selection', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await imagePdf());
  await page.getByRole('button', { name: 'Select image 1', exact: true }).click();
  const move = page.getByRole('button', { name: 'Move selected image', exact: true });
  const oldWidth = await page.locator('.paper').evaluate((node) => node.clientWidth);
  await move.press('ArrowRight');
  await page.setViewportSize({ width: 520, height: 800 });
  // The selection keeps the page's scale, so its handles stay put while it is selected.
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await expect(move).toBeVisible();
  await expect(move).toBeEnabled();
  expect(await page.locator('.paper').evaluate((node) => node.clientWidth)).toBe(oldWidth);
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const result = inspectImages(
    await PDFDocument.load(await readFile(await (await pending).path())),
    0,
  )[0];
  expect(result.transform[4]).toBeCloseTo(41, 5);
  // Clearing the selection fits the page to the resized window.
  await move.press('Escape');
  await expect(move).toBeHidden();
  await expect
    .poll(() => page.locator('.paper').evaluate((node) => node.clientWidth))
    .not.toBe(oldWidth);
});

test('image dimensions reflect a clipping limit without creating a false edit', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.load(await (await imagePdf()).save());
  const image = inspectImages(doc, 0)[0].object;
  doc
    .getPage(0)
    .node.set(
      PDFName.of('Resources'),
      doc.context.obj({ XObject: { Picture: doc.context.getObjectRef(image) } }),
    );
  doc
    .getPage(0)
    .node.set(
      PDFName.of('Contents'),
      doc.context.register(
        doc.context.flateStream('q 40 220 80 60 re W n 80 0 0 60 40 220 cm /Picture Do Q'),
      ),
    );
  await openPdf(page, doc);
  await page.getByRole('button', { name: 'Select image 1', exact: true }).click();
  const width = page.getByLabel('Image width in points', { exact: true });
  await width.fill('100');
  await width.press('Enter');
  await expect(width).toHaveValue('80');
  await expect(page.locator('.save-status')).toHaveText('Local file');
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
});

test('shrinking an image past its opposite corner keeps its proportions and allows recovery', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await imagePdf());
  await page.getByRole('button', { name: 'Select image 1', exact: true }).click();
  const first = await page
    .getByRole('button', { name: 'Resize image, corner 1', exact: true })
    .boundingBox();
  const handle = await page
    .getByRole('button', { name: 'Resize image, corner 3', exact: true })
    .boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(first.x - 20, first.y - 20, { steps: 5 });
  await page.mouse.up();
  const width = page.getByLabel('Image width in points', { exact: true });
  await expect.poll(async () => Number(await width.inputValue())).toBeLessThan(2);
  await expect(page.getByLabel('Image height in points', { exact: true })).toHaveValue('1');
  expect(Number(await width.inputValue())).toBeCloseTo(4 / 3, 2);
  await width.fill('80');
  await width.press('Enter');
  await expect(width).toHaveValue('80');
  await expect
    .poll(async () =>
      Number(await page.getByLabel('Image height in points', { exact: true }).inputValue()),
    )
    .toBeCloseTo(60, 2);
});

test('moves an existing image with a live preview and preserves it through export, undo and reopen', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await imagePdf());
  const first = page.getByRole('button', { name: 'Select image 1', exact: true });
  const box = await first.boundingBox();
  const paper = await page.locator('.paper').boundingBox(),
    scale = paper.width / 400;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 40 * scale, box.y + box.height / 2 + 60 * scale, {
    steps: 5,
  });
  await expect(page.locator('.image-preview')).toBeVisible();
  await expect(page.locator('.save-status')).toHaveText('Unsaved changes');
  await page.mouse.up();
  await expect(
    page.getByRole('button', { name: 'Move selected image', exact: true }),
  ).toBeEnabled();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const exported = await PDFDocument.load(await readFile(await (await pending).path()));
  const images = inspectImages(exported, 0);
  images[0].transform.forEach((n, i) => expect(n).toBeCloseTo([80, 0, 0, 60, 80, 160][i], 1));
  expect(images[1].transform).toEqual([80, 0, 0, 60, 240, 220]);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(first).toBeEnabled();
  const restored = await first.boundingBox();
  expect(restored.x).toBeCloseTo(box.x, 1);
  expect(restored.y).toBeCloseTo(box.y, 1);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(first).toBeEnabled();
  await page.getByRole('button', { name: 'Back to your PDFs', exact: true }).click();
  await openPdf(page, exported);
  await first.click();
  await page.getByRole('button', { name: 'Delete image', exact: true }).click();
  await expect(page.locator('.image-target')).toHaveCount(1);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('.image-target')).toHaveCount(2);
});

test('resizes existing images with proportions and numeric dimensions, and cancels drafts with Escape', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await imagePdf());
  await page.getByRole('button', { name: 'Select image 1', exact: true }).click();
  const handle = await page
    .getByRole('button', { name: 'Resize image, corner 3', exact: true })
    .boundingBox();
  const scale = (await page.locator('.paper').boundingBox()).width / 400;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    handle.x + handle.width / 2 + 40 * scale,
    handle.y + handle.height / 2 + 30 * scale,
    { steps: 5 },
  );
  await page.mouse.up();
  await expect
    .poll(async () =>
      Math.abs(
        Number(await page.getByLabel('Image width in points', { exact: true }).inputValue()) - 120,
      ),
    )
    .toBeLessThan(0.05);
  await expect
    .poll(async () =>
      Math.abs(
        Number(await page.getByLabel('Image height in points', { exact: true }).inputValue()) - 90,
      ),
    )
    .toBeLessThan(0.05);
  await page.getByLabel('Keep image proportions', { exact: true }).uncheck();
  await page.getByLabel('Image width in points', { exact: true }).fill('150');
  await page.getByLabel('Image width in points', { exact: true }).press('Enter');
  await expect(page.getByLabel('Image width in points', { exact: true })).toBeEnabled();
  await expect
    .poll(async () =>
      Math.abs(
        Number(await page.getByLabel('Image height in points', { exact: true }).inputValue()) - 90,
      ),
    )
    .toBeLessThan(0.05);
  const move = page.getByRole('button', { name: 'Move selected image', exact: true });
  const box = await move.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 20, box.y + box.height / 2 + 20, { steps: 4 });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(page.locator('.image-preview')).toBeHidden();
  const restored = await move.boundingBox();
  expect(restored.x).toBeCloseTo(box.x, 1);
  expect(restored.y).toBeCloseTo(box.y, 1);
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const result = inspectImages(
    await PDFDocument.load(await readFile(await (await pending).path())),
    0,
  )[0];
  result.transform.forEach((n, i) => expect(n).toBeCloseTo([150, 0, 0, 90, 40, 190][i], 1));
});

async function selectPdfText(page, from, start, to = from, end) {
  await page.locator('.textLayer').evaluate(
    (layer, { from, start, to, end }) => {
      const spans = [...layer.querySelectorAll('span')];
      const first = spans.find((s) => s.textContent === from);
      const last = spans.find((s) => s.textContent === to);
      const range = document.createRange();
      range.setStart(first.firstChild, start);
      range.setEnd(last.firstChild, end ?? to.length);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    },
    { from, start, to, end },
  );
  await expect(
    page.getByRole('button', { name: 'Highlight selection', exact: true }),
  ).toBeEnabled();
}

test('dragging text in either direction creates a highlight and Area remains available for scans', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  const pdfPage = doc.addPage([400, 400]);
  pdfPage.drawText('Select these words', { x: 40, y: 300, size: 20 });
  await openPdf(page, doc);
  await page.getByRole('button', { name: 'Highlight', exact: true }).click();
  const text = page.locator('.textLayer span').filter({ hasText: 'Select these words' });
  await selectPdfText(page, 'Select these words', 0);
  await page.keyboard.press('Escape');
  await expect(
    page.getByRole('button', { name: 'Highlight selection', exact: true }),
  ).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  for (const reverse of [false, true]) {
    const box = await text.boundingBox();
    const start = { x: box.x + 2, y: box.y + box.height / 2 };
    const end = { x: box.x + box.width - 2, y: start.y };
    await page.mouse.move(...(reverse ? [end.x, end.y] : [start.x, start.y]));
    await page.mouse.down();
    await page.mouse.move(...(reverse ? [start.x, start.y] : [end.x, end.y]), { steps: 10 });
    await page.mouse.up();
    const apply = page.getByRole('button', { name: 'Highlight selection', exact: true });
    await expect(apply).toBeEnabled();
    await apply.click();
    await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  }
  await page.getByLabel('Highlight mode', { exact: true }).selectOption('area');
  const box = await page.locator('.paper').boundingBox();
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.6, { steps: 5 });
  await page.mouse.up();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const result = await PDFDocument.load(await readFile(await (await pending).path()));
  const marks = listHighlights(result, 0);
  expect(marks).toHaveLength(3);
  expect(marks[0].text).toBe(marks[1].text);
  expect(marks[0].text).toContain('Select these words');
  expect(marks[2].text).toBe('');
  expect(Math.abs(marks[2].quads[0][2] - marks[2].quads[0][0] - 240)).toBeLessThan(2);
});

test('highlights selected words across lines and supports recolor, delete, undo and reopen', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  const pdfPage = doc.addPage([400, 400]);
  pdfPage.drawText('Keep these selected words', { x: 40, y: 300, size: 20 });
  pdfPage.drawText('and this next line ends here', { x: 40, y: 260, size: 20 });
  await openPdf(page, doc);
  await page.getByRole('button', { name: 'Highlight', exact: true }).click();
  await selectPdfText(page, 'Keep these selected words', 5, 'and this next line ends here', 13);
  await page.getByRole('button', { name: 'Highlight selection', exact: true }).click();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const exported = await PDFDocument.load(await readFile(await (await pending).path()));
  const marks = listHighlights(exported, 0);
  expect(marks).toHaveLength(1);
  expect(marks[0].quads).toHaveLength(2);
  expect(marks[0].text).toContain('these selected words');
  expect(marks[0].text).not.toContain('Keep');
  expect(marks[0].quads[0][0]).toBeGreaterThan(80);
  expect(marks[0].quads[1][2]).toBeLessThan(180);
  await page.getByRole('button', { name: 'Back to your PDFs', exact: true }).click();
  await openPdf(page, exported);
  const targets = page.locator('.highlight-target');
  await expect(targets).toHaveCount(2);
  await targets.first().click();
  await page.getByLabel('Highlight color', { exact: true }).fill('#00ccff');
  await page.getByLabel('Highlight color', { exact: true }).dispatchEvent('change');
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
  // The recolored highlight stays selected for further adjustment, with focus on the picker.
  await expect(page.locator('.highlight-edit-panel')).toHaveCount(1);
  await expect(page.getByLabel('Highlight color', { exact: true })).toHaveValue('#00ccff');
  await expect(page.getByLabel('Highlight color', { exact: true })).toBeFocused();
  await expect(targets.first()).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await expect(page.locator('.highlight-edit-panel')).toHaveCount(0);
  await targets.first().click();
  await expect(page.getByLabel('Highlight color', { exact: true })).toHaveValue('#00ccff');
  await page.getByRole('button', { name: 'Delete highlight', exact: true }).click();
  await expect(targets).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(targets).toHaveCount(2);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await targets.first().click();
  await expect(page.getByLabel('Highlight color', { exact: true })).toHaveValue('#f2c438');
  await page.keyboard.press('Escape');
  await expect(page.locator('.highlight-edit-panel')).toHaveCount(0);
});

test('text selection dragged past the page still highlights only the selected PDF words', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  doc.addPage([400, 400]).drawText('Select these words', { x: 40, y: 60, size: 20 });
  await openPdf(page, doc);
  await page.getByRole('button', { name: 'Highlight', exact: true }).click();
  const span = page.locator('.textLayer span').filter({ hasText: 'Select these words' });
  // Bring the bottom of the page and the gap below it into view.
  await page.locator('.workspace').evaluate((node) => (node.scrollTop = node.scrollHeight));
  const start = await span.boundingBox(),
    sheet = await page.locator('.paper').boundingBox();
  await page.mouse.move(start.x + 1, start.y + start.height / 2);
  await page.mouse.down();
  // Below the page, into the gap before the next one.
  await page.mouse.move(sheet.x + sheet.width - 2, sheet.y + sheet.height + 8, { steps: 10 });
  await page.mouse.up();
  await expect
    .poll(() => page.evaluate(() => getSelection().toString()))
    .toContain('Select these words');
  const apply = page.getByRole('button', { name: 'Highlight selection', exact: true });
  await expect(apply).toBeEnabled();
  await apply.click();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const [mark] = listHighlights(
    await PDFDocument.load(await readFile(await (await pending).path())),
    0,
  );
  expect(mark.text.trim()).toBe('Select these words');
  expect(mark.quads).toHaveLength(1);
});

for (const rotation of [0, 90, 180, 270])
  test(`text highlights preserve partial-word geometry at page rotation ${rotation}`, async ({
    page,
  }) => {
    await mockPuter(page);
    await page.goto('/#library');
    const doc = await PDFDocument.create();
    const pdfPage = doc.addPage([400, 400]);
    pdfPage.setRotation(degrees(rotation));
    pdfPage.setCropBox(20, 20, 360, 360);
    pdfPage.node.set(PDFName.of('UserUnit'), PDFNumber.of(2));
    const font = await doc.embedFont(StandardFonts.Helvetica);
    pdfPage.drawText('WiWi partial oblique', {
      x: 100,
      y: 140,
      size: 18,
      font,
      rotate: degrees(25),
    });
    await openPdf(page, doc);
    await page.getByLabel('Zoom', { exact: true }).selectOption('0.5');
    await expect(page.locator('.paper')).toHaveAttribute('aria-busy', 'false');
    await page.getByRole('button', { name: 'Highlight', exact: true }).click();
    await selectPdfText(page, 'WiWi partial oblique', 2, 'WiWi partial oblique', 12);
    await page.getByRole('button', { name: 'Highlight selection', exact: true }).click();
    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download', exact: true }).click();
    const result = await PDFDocument.load(await readFile(await (await pending).path()));
    const [quad] = listHighlights(result, 0)[0].quads;
    const angle = (Math.atan2(quad[3] - quad[1], quad[2] - quad[0]) * 180) / Math.PI;
    expect(angle).toBeCloseTo(25, 2);
    const width = Math.hypot(quad[2] - quad[0], quad[3] - quad[1]);
    expect(Math.abs(width - font.widthOfTextAtSize('Wi partial', 18))).toBeLessThan(2);
    expect(quad[0]).toBeGreaterThan(100);
    expect(quad[0]).toBeLessThan(125);
    expect(quad[1]).toBeGreaterThan(155);
    expect(quad[1]).toBeLessThan(175);
  });

async function mockPuter(
  page,
  { app = false, failSave = false, signedIn = true, deferList = false, launch = null } = {},
) {
  await page.route('https://js.puter.com/**', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: `
    window.puter = { env: ${JSON.stringify(app ? 'app' : 'web')}, auth: { isSignedIn: () => ${signedIn}, getUser: async () => ({username:'test-user'}), signIn: async () => {}, signOut: async () => {} }, fs: { read: async () => new Blob([Uint8Array.from(atob(${JSON.stringify(launch || '')}), (c) => c.charCodeAt(0))], { type: 'application/pdf' }), readdir: async () => { window.readdirCalls = (window.readdirCalls || 0) + 1; ${deferList ? 'return new Promise((resolve, reject) => { window.finishLibrary = resolve; window.failLibrary = reject; });' : 'return [];'} }, write: async (path, blob, options) => { ${failSave ? "throw new Error('Storage unavailable')" : "window.lastSave = {path, size:blob.size, options}; return {path, name:path.split('/').pop()}"} } }, ui: { onLaunchedWithItems: (cb) => { ${launch ? "setTimeout(() => cb([{ path: 'PDF Editor/launch.pdf', name: 'launch.pdf', size: 1000 }]), 0);" : ''} }, onItemsOpened: (cb) => { ${launch ? "setTimeout(() => cb([{ path: 'PDF Editor/launch.pdf', name: 'launch.pdf', size: 1000 }]), 0);" : ''} } } };`,
    }),
  );
}
async function sample(page) {
  await page.getByRole('button', { name: 'Try a sample PDF' }).click();
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
}
/** Choose a menu item by name from the menu bar, or from the folded phone menu. */
async function menu(page, name) {
  const bar = page.getByRole('menubar', { name: 'PDF menus' });
  const item = page.getByRole('menu').getByRole('menuitem', { name, exact: true });
  if (await bar.isVisible()) {
    for (const title of ['File', 'Edit', 'View', 'Page', 'Insert']) {
      await bar.getByRole('menuitem', { name: title, exact: true }).click();
      if (await item.count()) return item.click();
      await page.keyboard.press('Escape');
    }
  } else {
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    if (await item.count()) return item.click();
    for (const section of ['Edit', 'View', 'Page', 'Insert']) {
      await page.getByRole('menu').getByRole('menuitem', { name: section, exact: true }).click();
      if (await item.count()) return item.click();
      await page.keyboard.press('Escape');
    }
  }
  throw new Error(`No menu item named ${name}`);
}

async function openPdf(page, doc, name = 'test.pdf') {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name,
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText(`Page 1 of ${doc.getPageCount()}`);
}

test('clears default-only form values through save, undo and reopen', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  const pdfPage = doc.addPage([400, 400]);
  const form = doc.getForm();
  const text = form.createTextField('Name');
  text.setText('Default name');
  text.addToPage(pdfPage, { x: 40, y: 280, width: 240, height: 30 });
  const choice = form.createDropdown('Choice');
  choice.setOptions(['A', 'B']);
  choice.select('A');
  choice.addToPage(pdfPage, { x: 40, y: 220, width: 240, height: 30 });
  form.updateFieldAppearances();
  for (const [field, value] of [
    [text, 'Default name'],
    [choice, 'A'],
  ]) {
    field.acroField.dict.set(PDFName.of('DV'), PDFHexString.fromText(value));
    field.acroField.dict.delete(PDFName.of('V'));
  }
  await openPdf(page, doc);
  const input = page.getByLabel('Name (on page)', { exact: true });
  const select = page.getByLabel('Choice (on page)', { exact: true });
  await expect(input).toHaveValue('Default name');
  await expect(select).toHaveValue('A');
  await input.fill('');
  await select.selectOption({ label: 'Choose an option' });
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const exported = await PDFDocument.load(await readFile(await (await pending).path()));
  await expect(input).toHaveValue('');
  await expect(select).toHaveValue('');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(input).toHaveValue('Default name');
  await expect(select).toHaveValue('A');
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(input).toHaveValue('');
  await page.getByRole('button', { name: 'Back to your PDFs', exact: true }).click();
  await openPdf(page, exported);
  await expect(input).toHaveValue('');
  await expect(select).toHaveValue('');
  await input.fill('New name');
  await input.press('Enter');
  await expect(input).toHaveValue('New name');
  await expect(page.locator('.save-status')).toHaveText('Unsaved changes');
});

test('library filters preserve loading and failure feedback until a retry succeeds', async ({
  page,
}) => {
  await mockPuter(page, { deferList: true });
  await page.goto('/#library');
  const library = page.locator('.file-list');
  await expect(library).toHaveText('Loading your PDFs…');
  await page.getByRole('searchbox', { name: 'Search PDFs', exact: true }).fill('budget');
  await page.getByLabel('Sort PDFs', { exact: true }).selectOption('name');
  await expect(library).toHaveText('Loading your PDFs…');
  await page.evaluate(() => window.failLibrary(new Error('Offline')));
  await expect(library).toContainText('Your library could not be loaded.');
  await page.getByRole('searchbox', { name: 'Search PDFs', exact: true }).fill('invoice');
  await page.getByLabel('Sort PDFs', { exact: true }).selectOption('size');
  await expect(library).toContainText('Your library could not be loaded.');
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(library).toHaveText('Loading your PDFs…');
  await page.getByRole('searchbox', { name: 'Search PDFs', exact: true }).fill('budget');
  await page.evaluate(() =>
    window.finishLibrary([
      { name: 'Budget.pdf', path: 'PDF Editor/Budget.pdf', size: 1000 },
      { name: 'Invoice.pdf', path: 'PDF Editor/Invoice.pdf', size: 2000 },
    ]),
  );
  await expect(page.locator('.file-open')).toHaveText(['Budget.pdf']);
});

test('accepting an unchanged PDF name preserves its cloud save destination', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  await sample(page);
  await page.getByRole('button', { name: 'Save to Puter', exact: true }).click();
  await expect(page.locator('.save-status')).toHaveText('Saved to Puter');
  for (const name of ['Getting started', 'Getting started.PDF', '  Getting started  ']) {
    await page.getByRole('button', { name: 'Rename Getting started.pdf', exact: true }).click();
    await page.getByLabel('File name', { exact: true }).fill(name);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.locator('.save-status')).toHaveText('Saved to Puter');
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
  }
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.save-status')).toHaveText('Saved to Puter');
  expect(await page.evaluate(() => window.lastSave)).toMatchObject({
    path: 'PDF Editor/Getting started.pdf',
    options: { overwrite: true, dedupeName: false },
  });
});

for (const tool of ['Draw', 'Shape']) {
  test(`zooming during a pending ${tool} edit keeps its PDF coordinates`, async ({ page }) => {
    await mockPuter(page);
    await page.goto('/#library');
    const doc = await PDFDocument.create();
    doc.addPage([400, 400]);
    await openPdf(page, doc);
    await page.evaluate(async () => {
      const { PdfSession } = await import('/src/core/document.js');
      const change = PdfSession.prototype.change;
      PdfSession.prototype.change = async function (operation) {
        await new Promise((resolve) => {
          window.finishEdit = () => {
            PdfSession.prototype.change = change;
            resolve();
          };
        });
        return change.call(this, operation);
      };
    });
    await page.getByRole('button', { name: tool, exact: true }).click();
    const box = await page.locator('.drawing-overlay').boundingBox();
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.4);
    await page.mouse.up();
    await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'true');
    await page.getByLabel('Zoom', { exact: true }).selectOption('2');
    await expect(page.locator('.paper')).toHaveCSS('width', '800px');
    await page.evaluate(() => window.finishEdit());
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download', exact: true }).click();
    const exported = await PDFDocument.load(await readFile(await (await pending).path()));
    const contents = exported
      .getPage(0)
      .node.Contents()
      .asArray()
      .map((ref) =>
        Buffer.from(decodePDFRawStream(exported.context.lookup(ref)).decode()).toString(),
      )
      .join('\n');
    if (tool === 'Draw') {
      const lines = [...contents.matchAll(/([-\d.]+) ([-\d.]+) m\s+([-\d.]+) ([-\d.]+) l/g)];
      expect(lines).toHaveLength(1);
      for (const [index, expected] of [80, 320, 160, 240].entries())
        expect(Number(lines[0][index + 1])).toBeCloseTo(expected, 0);
    } else {
      const origin = contents.match(/1 0 0 1 ([-\d.]+) ([-\d.]+) cm/);
      expect(Number(origin[1])).toBeCloseTo(80, 0);
      expect(Number(origin[2])).toBeCloseTo(240, 0);
      const corners = [...contents.matchAll(/([-\d.]+) ([-\d.]+) l/g)];
      expect(corners).toHaveLength(3);
      for (const [index, [x, y]] of [
        [0, 80],
        [80, 80],
        [80, 0],
      ].entries()) {
        expect(Number(corners[index][1])).toBeCloseTo(x, 0);
        expect(Number(corners[index][2])).toBeCloseTo(y, 0);
      }
    }
  });
}

for (const unit of [0.5, 2]) {
  test(`annotation point sizes are preserved on pages with UserUnit ${unit}`, async ({ page }) => {
    await mockPuter(page);
    await page.goto('/#library');
    const doc = await PDFDocument.create();
    doc.addPage([400, 500]).node.set(PDFName.of('UserUnit'), PDFNumber.of(unit));
    await openPdf(page, doc);
    await page.getByRole('button', { name: 'Shape', exact: true }).click();
    await page.getByLabel('Stroke width', { exact: true }).selectOption('4');
    await page.getByRole('button', { name: 'Place at page center' }).click();
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Text', exact: true }).click();
    await page.getByLabel('Text size', { exact: true }).selectOption('20');
    await page.getByRole('button', { name: 'Place at page center' }).click();
    await page.getByLabel('Text to add').fill('Sized text');
    await clickAway(page);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByRole('button', { name: 'Draw', exact: true }).click();
    // Inline text editing scrolls its insertion point into view. Draw on the visible page.
    await page.locator('.workspace').evaluate((node) => {
      node.scrollTop = 0;
    });
    const box = await page.locator('.drawing-overlay').boundingBox();
    await page.mouse.move(box.x + box.width * 0.1, box.y + box.height * 0.1);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.1);
    await page.mouse.up();
    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download', exact: true }).click();
    const exported = await PDFDocument.load(await readFile(await (await pending).path()));
    const contents = exported
      .getPage(0)
      .node.Contents()
      .asArray()
      .map((ref) =>
        Buffer.from(decodePDFRawStream(exported.context.lookup(ref)).decode()).toString(),
      )
      .join('\n');
    const widths = [...contents.matchAll(/([\d.]+) w\b/g)].map((match) => Number(match[1]));
    const sizes = [...contents.matchAll(/([\d.]+) Tf\b/g)].map((match) => Number(match[1]));
    expect(widths.map((width) => width * unit)).toEqual([4, 4]);
    expect(sizes.map((size) => size * unit)).toContain(20);
  });
}

test('find matches and highlights words and phrases split across text styles', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  doc.addPage().drawText('Other page');
  const pdfPage = doc.addPage();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const size = 18;
  const x = 50;
  pdfPage.drawText('paper', { x, y: 700, size, font: regular });
  pdfPage.drawText('work', {
    x: x + regular.widthOfTextAtSize('paper', size),
    y: 700,
    size,
    font: bold,
  });
  pdfPage.drawText(' made easy', {
    x: x + regular.widthOfTextAtSize('paper', size) + bold.widthOfTextAtSize('work', size),
    y: 700,
    size,
    font: regular,
  });
  await openPdf(page, doc);
  await page.getByRole('button', { name: 'Find text or tools', exact: true }).click();
  const input = page.getByRole('searchbox', { name: 'Find in PDF', exact: true });
  await input.fill('paperwork');
  await expect(page.locator('.search-count')).toHaveText('1 of 1');
  await expect(page.locator('.page-caption')).toHaveText('Page 2 of 2');
  await expect(page.locator('.search-hit')).toHaveText(['paper', 'work']);
  await input.fill('paperwork made easy');
  await expect(page.locator('.search-hit')).toHaveText(['paper', 'work', ' ', 'made easy']);
  await input.fill('made easy');
  await expect(page.locator('.search-hit')).toHaveText(['made easy']);
  await input.fill('absent');
  await expect(page.locator('.search-count')).toHaveText('No matches');
  await expect(page.locator('.search-hit')).toHaveCount(0);
});

test('leaving a loading PDF allows another document to open without stale editor state', async ({
  page,
}) => {
  await mockPuter(page);
  let releaseWorker;
  const workerGate = new Promise((resolve) => {
    releaseWorker = resolve;
  });
  let requestedWorker;
  const workerRequested = new Promise((resolve) => {
    requestedWorker = resolve;
  });
  await page.route('**/pdf-worker*.js*', async (route) => {
    requestedWorker();
    await workerGate;
    await route.continue();
  });
  await page.goto('/#library');
  try {
    await page.getByRole('button', { name: 'Try a sample PDF' }).click();
    await workerRequested;
    await page.getByRole('button', { name: 'Back to your PDFs' }).click();
    await expect(page.getByRole('button', { name: 'New blank PDF' })).toBeVisible();
    await page.getByRole('button', { name: 'New blank PDF' }).click();
    await expect(page.getByRole('button', { name: 'Rename Untitled.pdf' })).toBeVisible();
    releaseWorker();
    await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
    await expect(page).toHaveTitle('Untitled.pdf · PDF Editor');
    await page.keyboard.press('ControlOrMeta+s');
    await expect(page.locator('.save-status')).toHaveText('Saved to Puter');
    expect(await page.evaluate(() => window.lastSave.path)).toBe('PDF Editor/Untitled.pdf');
  } finally {
    releaseWorker();
  }
});

test('renderer startup failures return to the library and remove editor shortcuts', async ({
  page,
}) => {
  await mockPuter(page);
  await page.route('**/pdf-worker*.js*', (route) => route.abort());
  await page.goto('/#library');
  await page.getByRole('button', { name: 'Try a sample PDF' }).click();
  await expect(page.locator('#toast')).toBeVisible();
  await expect(page.getByRole('button', { name: 'New blank PDF' })).toBeVisible();
  await expect(page.locator('.editor')).toHaveCount(0);
  await expect(page).toHaveTitle('PDF Editor');
  expect(
    await page.evaluate(() => {
      const event = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    }),
  ).toBe(false);
});

test('rejecting a damaged PDF keeps the existing document and its edits', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  await sample(page);
  await menu(page, 'Rotate clockwise');
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
  const chooser = page.waitForEvent('filechooser');
  await menu(page, 'Open…');
  await (
    await chooser
  ).setFiles({
    name: 'broken.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.7\nbroken'),
  });
  await expect(page.locator('#toast')).toContainText('damaged or unsupported');
  await expect(page.locator('.save-status')).toHaveText('Unsaved changes');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const exported = await PDFDocument.load(await readFile(await (await pending).path()));
  expect(exported.getPage(0).getRotation().angle).toBe(90);
});

test('a second touch cannot replace or finish an active drawing stroke', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  doc.addPage([400, 400]);
  await openPdf(page, doc);
  await page.getByRole('button', { name: 'Draw', exact: true }).click();
  const box = await page.locator('.drawing-overlay').boundingBox();
  const first = { id: 1, x: box.x + box.width * 0.2, y: box.y + box.height * 0.2 };
  const second = { id: 2, x: box.x + box.width * 0.8, y: box.y + box.height * 0.8 };
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [first] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [first, second] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [second] });
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ ...first, x: box.x + box.width * 0.3 }],
  });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const exported = await PDFDocument.load(await readFile(await (await pending).path()));
  const contents = exported
    .getPage(0)
    .node.Contents()
    .asArray()
    .map((ref) => Buffer.from(decodePDFRawStream(exported.context.lookup(ref)).decode()).toString())
    .join('\n');
  const lines = [...contents.matchAll(/([-\d.]+) ([-\d.]+) m\s+([-\d.]+) ([-\d.]+) l/g)];
  expect(lines).toHaveLength(1);
  for (const [index, expected] of [80, 320, 120, 320].entries())
    expect(Number(lines[0][index + 1])).toBeCloseTo(expected, 0);
});

test('home sign-in refreshes the account and library', async ({ page }) => {
  await mockPuter(page, { signedIn: false });
  await page.goto('/#library');
  await page.getByRole('button', { name: 'Sign in with Puter', exact: true }).click();
  await expect(page.locator('.account-label')).toHaveText('test-user');
  await expect(page.getByRole('heading', { name: 'Your library starts here' })).toBeVisible();
});

test('a second click on a library action while it runs does not repeat it', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: `window.puter = { env: 'web', auth: { isSignedIn: () => true, getUser: async () => ({username:'test-user'}), signIn: async () => {}, signOut: async () => {} }, fs: { readdir: async () => [{ name: 'report.pdf', path: 'PDF Editor/report.pdf', size: 2048, modified: 1700000000 }], read: async () => { await new Promise((r) => setTimeout(r, 400)); return new Blob(['%PDF-1.4'], { type: 'application/pdf' }); }, write: async (path) => { window.writes = (window.writes || 0) + 1; return { path, name: path.split('/').pop() }; } }, ui: { onLaunchedWithItems: () => {}, onItemsOpened: () => {} } };`,
    }),
  );
  await page.goto('/#library');
  await page.getByRole('button', { name: 'Options for report.pdf', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'report.pdf' });
  const duplicate = dialog.getByRole('button', { name: 'Duplicate', exact: true });
  await duplicate.click();
  await expect(duplicate).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Download', exact: true })).toBeDisabled();
  await duplicate.click({ force: true }).catch(() => {});
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => window.writes)).toBe(1);
});

test('closing the Puter sign-in dialog is not reported as an error', async ({ page }) => {
  await mockPuter(page, { signedIn: false });
  await page.goto('/#library');
  await page.evaluate(() => {
    window.puter.auth.signIn = () =>
      Promise.reject({ error: 'auth_window_closed', msg: 'Authentication window was closed' });
    window.puter.ui.showOpenFilePicker = async () => null;
  });
  await page.getByRole('button', { name: 'Sign in with Puter', exact: true }).click();
  await expect(page.locator('.account-label')).toHaveText('Local workspace');
  await expect(page.locator('#toast')).toBeHidden();
  await page.getByRole('button', { name: 'Open from Puter', exact: true }).click();
  await expect(page.locator('#toast')).toBeHidden();
  // The editor's Save button asks for the sign-in too; a closed dialog leaves things as they were.
  await sample(page);
  await page.getByRole('button', { name: 'Sign in to save', exact: true }).click();
  await expect(page.locator('.save-status')).toHaveText('Local file');
  await expect(page.locator('#toast')).toBeHidden();
  // A real failure still explains itself.
  await page.evaluate(() => {
    window.puter.auth.signIn = () =>
      Promise.reject({ error: 'server_error', msg: 'Puter is down' });
  });
  await page.getByRole('button', { name: 'Sign in to save', exact: true }).click();
  await expect(page.locator('#toast')).toHaveText('Puter is down');
});

test('finishing home sign-in preserves a PDF opened and edited while waiting', async ({ page }) => {
  await mockPuter(page, { signedIn: false });
  await page.goto('/#library');
  await page.evaluate(() => {
    window.puter.auth.signIn = () =>
      new Promise((resolve) => {
        window.finishSignIn = resolve;
      });
  });
  await page.getByRole('button', { name: 'Sign in with Puter', exact: true }).click();
  await sample(page);
  await menu(page, 'Rotate clockwise');
  await expect(page.locator('.save-status')).toHaveText('Unsaved changes');
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
  await page.evaluate(() => window.finishSignIn());
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Signed in as test-user');
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await expect(page.locator('.save-status')).toHaveText('Unsaved changes');
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const exported = await PDFDocument.load(await readFile(await (await pending).path()));
  expect(exported.getPage(0).getRotation().angle).toBe(90);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeEnabled();
});

test('images are upright and centered within a rotated crop box', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  const pdfPage = doc.addPage([600, 800]);
  pdfPage.setCropBox(100, 200, 300, 400);
  pdfPage.setRotation(degrees(90));
  await openPdf(page, doc);
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Image', exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: 'pixel.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=',
      'base64',
    ),
  });
  await expect(page.locator('#toast')).toHaveText('Image added. Drag to move or resize it.');
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const exported = await PDFDocument.load(await readFile(await (await pending).path()));
  const contents = exported
    .getPage(0)
    .node.Contents()
    .asArray()
    .map((ref) => Buffer.from(decodePDFRawStream(exported.context.lookup(ref)).decode()).toString())
    .join('\n');
  expect(contents).toContain('1 0 0 1 325 325 cm');
  expect(contents).toContain('150 0 0 150 0 0 cm');
  expect(contents).toMatch(/0\.0+\d+ 1 -1 0\.0+\d+ 0 0 cm/);
});

test('a delayed folder save cannot rename or mark a renamed working copy saved', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  await sample(page);
  await page.evaluate(() => {
    window.puter.ui.showSaveFilePicker = () =>
      new Promise((resolve) => {
        window.finishFolderSave = resolve;
      });
  });
  await menu(page, 'Save to another Puter folder…');
  await page.getByRole('button', { name: 'Rename Getting started.pdf', exact: true }).click();
  await page.getByLabel('File name', { exact: true }).fill('New working copy');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.locator('.save-status')).toHaveText('Unsaved changes');
  await page.evaluate(() =>
    window.finishFolderSave({ path: '/old/Getting started.pdf', name: 'Getting started.pdf' }),
  );
  await expect(
    page.getByRole('button', { name: 'Rename New working copy.pdf', exact: true }),
  ).toBeVisible();
  await expect(page.locator('.save-status')).toHaveText('Unsaved changes');
  await page.getByRole('button', { name: 'Save to Puter', exact: true }).click();
  await expect(page.locator('.save-status')).toHaveText('Saved to Puter');
  expect(await page.evaluate(() => window.lastSave)).toMatchObject({
    path: 'PDF Editor/New working copy.pdf',
    options: { overwrite: false, dedupeName: true },
  });
});

test('a delayed folder save cannot replace a newer cloud save destination', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  await sample(page);
  await page.evaluate(() => {
    window.puter.ui.showSaveFilePicker = () =>
      new Promise((resolve) => {
        window.finishFolderSave = resolve;
      });
  });
  await menu(page, 'Save to another Puter folder…');
  await page.getByRole('button', { name: 'Save to Puter', exact: true }).click();
  await expect(page.locator('.save-status')).toHaveText('Saved to Puter');
  await page.evaluate(() => window.finishFolderSave({ path: '/older/copy.pdf', name: 'copy.pdf' }));
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.save-status')).toHaveText('Saved to Puter');
  expect(await page.evaluate(() => window.lastSave)).toMatchObject({
    path: 'PDF Editor/Getting started.pdf',
    options: { overwrite: true, dedupeName: false },
  });
});

test('large pages keep every canvas within the rendering memory budget', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  doc.addPage([5000, 5000]);
  await openPdf(page, doc);
  await page.getByLabel('Zoom', { exact: true }).selectOption('1');
  await expect(page.locator('.paper')).toHaveCSS('width', '5000px');
  const sizes = await page
    .locator('.paper canvas')
    .evaluateAll((nodes) => nodes.map((node) => node.width * node.height));
  expect(sizes.every((pixels) => pixels <= 16000000)).toBe(true);
  // Zooming keeps the middle of the view in place; the drawing below starts at the corner.
  await page.locator('.workspace').evaluate((node) => node.scrollTo(0, 0));
  await page.getByRole('button', { name: 'Shape', exact: true }).click();
  const box = await page.locator('.drawing-overlay').boundingBox();
  await page.mouse.move(box.x + 40, box.y + 40);
  await page.mouse.down();
  await page.mouse.move(box.x + 140, box.y + 90);
  await page.mouse.up();
  await expect(page.locator('.save-status')).toHaveText('Unsaved changes');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const exported = await PDFDocument.load(await readFile(await (await pending).path()));
  const contents = exported
    .getPage(0)
    .node.Contents()
    .asArray()
    .map((ref) => Buffer.from(decodePDFRawStream(exported.context.lookup(ref)).decode()).toString())
    .join('\n');
  expect(contents).toContain('1 0 0 1 40 4910 cm');
  expect(contents).toContain('100 50 l');
});

test('extremely tall page previews have bounded dimensions', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  doc.addPage([10, 20000]);
  await openPdf(page, doc);
  if (!(await page.locator('#page-sidebar').isVisible()))
    await page.getByRole('button', { name: 'Toggle pages panel' }).click();
  await expect
    .poll(() =>
      page
        .locator('.thumbnail canvas')
        .evaluate((c) => c.height / Math.min(window.devicePixelRatio || 1, 2)),
    )
    .toBeLessThanOrEqual(158);
  const sizes = await page
    .locator('.paper canvas')
    .evaluateAll((nodes) => nodes.map((node) => ({ width: node.width, height: node.height })));
  for (const size of sizes) {
    expect(size.width).toBeLessThanOrEqual(8192);
    expect(size.height).toBeLessThanOrEqual(8192);
  }
});

test('the page limit keeps the current page and undo history intact', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  for (let i = 0; i < 1000; i++) doc.addPage();
  await openPdf(page, doc);
  await menu(page, 'Insert blank page after');
  await expect(page.locator('#toast')).toContainText('1,000 pages');
  await expect(page.getByLabel('Page number')).toHaveValue('1');
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1000');
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await expect(page.locator('.save-status')).toHaveText('Local file');
});

test('saving a form preserves multiple and custom dropdown selections', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  const field = doc.getForm().createDropdown('Languages');
  field.setOptions(['English', 'French', 'Greek']);
  field.enableMultiselect();
  field.select(['English', 'French']);
  const pdfPage = doc.addPage();
  field.addToPage(pdfPage);
  const custom = doc.getForm().createDropdown('City');
  custom.setOptions(['Paris', 'London']);
  custom.select('Vancouver');
  custom.addToPage(pdfPage, { y: 150 });
  await openPdf(page, doc);
  await page.getByRole('button', { name: 'Fill forms', exact: true }).click();
  await expect(page.getByLabel('Languages', { exact: true })).toHaveValues(['English', 'French']);
  await expect(page.getByLabel('City', { exact: true })).toHaveValue('Vancouver');
  await page.getByRole('button', { name: 'Save form', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const exported = await PDFDocument.load(await readFile(await (await pending).path()));
  expect(exported.getForm().getDropdown('Languages').getSelected()).toEqual(['English', 'French']);
  expect(exported.getForm().getDropdown('City').getSelected()).toEqual(['Vancouver']);
});

test('empty choice options stay distinct from clearing a form selection', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  const pdfPage = doc.addPage();
  const form = doc.getForm();
  const choice = form.createDropdown('Choice');
  choice.setOptions(['', 'Other']);
  choice.select('');
  choice.addToPage(pdfPage);
  const radio = form.createRadioGroup('Radio');
  radio.addOptionToPage('First', pdfPage, { y: 100 });
  radio.addOptionToPage('Second', pdfPage, { y: 150 });
  radio.select('First');
  await openPdf(page, doc);
  await page.getByRole('button', { name: 'Fill forms', exact: true }).click();
  await page.getByRole('button', { name: 'Save form', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const exported = await PDFDocument.load(await readFile(await (await pending).path()));
  expect(exported.getForm().getDropdown('Choice').getSelected()).toEqual(['']);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();

  await page.getByRole('button', { name: 'Fill forms', exact: true }).click();
  await page.getByLabel('Choice', { exact: true }).selectOption({ label: 'Choose an option' });
  await page.getByLabel('Radio', { exact: true }).selectOption('Second');
  await page.getByRole('button', { name: 'Save form', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const clearedDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const cleared = await PDFDocument.load(await readFile(await (await clearedDownload).path()));
  expect(cleared.getForm().getDropdown('Choice').getSelected()).toEqual([]);
  expect(cleared.getForm().getRadioGroup('Radio').getSelected()).toBe('Second');

  await page.getByRole('button', { name: 'Fill forms', exact: true }).click();
  await page.getByLabel('Choice', { exact: true }).selectOption({ label: '(Empty option)' });
  await page.getByRole('button', { name: 'Save form', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const reselectedDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const reselected = await PDFDocument.load(
    await readFile(await (await reselectedDownload).path()),
  );
  expect(reselected.getForm().getDropdown('Choice').getSelected()).toEqual(['']);
});

test('deleting a form page removes its fields and undo restores them', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  await sample(page);
  await menu(page, 'Insert blank page after');
  await expect(page.locator('.page-caption')).toHaveText('Page 2 of 2');
  await page.getByRole('button', { name: 'Previous page', exact: true }).click();
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 2');
  await menu(page, 'Delete page');
  await page.getByRole('button', { name: 'Delete page', exact: true }).click();
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await page.getByRole('button', { name: 'Fill forms', exact: true }).click();
  await expect(page.locator('#toast')).toContainText('no fillable fields');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 2');
  await page.getByRole('button', { name: 'Fill forms', exact: true }).click();
  await expect(page.getByLabel('Your name', { exact: true })).toBeVisible();
});

test('page navigation cancels an unfinished annotation', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  doc.addPage([300, 400]);
  doc.addPage([500, 600]);
  await openPdf(page, doc);
  await page.getByRole('button', { name: 'Shape', exact: true }).click();
  const box = await page.locator('.drawing-overlay').boundingBox();
  await page.mouse.move(box.x + 20, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + 100, box.y + 70);
  await page.keyboard.press('Alt+ArrowRight');
  await expect(page.locator('.page-caption')).toHaveText('Page 2 of 2');
  await page.mouse.up();
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await expect(page.locator('.save-status')).toHaveText('Local file');
  await page.getByRole('button', { name: 'Place at page center' }).click();
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
});

test('form errors are announced inside the dialog and can be corrected', async ({
  page,
}, testInfo) => {
  await mockPuter(page);
  await page.goto('/#library');
  await sample(page);
  await page.getByRole('button', { name: 'Fill forms', exact: true }).click();
  await page.getByLabel('Your name', { exact: true }).fill('你好');
  await page.getByRole('button', { name: 'Save form', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('alert')).toContainText('does not support');
  await expect(dialog.getByRole('alert')).toBeVisible();
  expect(await page.locator('#toast').isVisible()).toBe(false);
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('form-error.png'), fullPage: true });
  await expect(page.locator('.save-status')).toHaveText('Local file');
  await page.getByLabel('Your name', { exact: true }).fill('Alex');
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await page.getByRole('button', { name: 'Save form', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('#toast')).toHaveText('Form saved.');
  await expect(page.locator('.save-status')).toHaveText('Unsaved changes');
});

test('nested leave confirmations have the correct accessible name', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  await sample(page);
  await menu(page, 'Rotate clockwise');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: 'Leave this PDF?', exact: true });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeFocused();
});

test('local workspace works without Puter and supports themes', async ({ page }) => {
  await page.route('https://js.puter.com/**', (r) => r.abort());
  await page.goto('/#library');
  await expect(page.getByRole('button', { name: 'New blank PDF' })).toBeVisible();
  await expect(page.locator('.account-label')).toHaveText('Local workspace');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByLabel('Appearance')).toHaveValue('system');
  await page.getByLabel('Appearance').selectOption('dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await sample(page);
  await expect(page.locator('.textLayer')).toContainText('Make it your own.');
});

test('adds text, exports a readable PDF, and undoes page operations', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  await sample(page);
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  await page.getByRole('button', { name: 'Place at page center' }).click();
  await page.getByLabel('Text to add').fill('Reviewed by Alex');
  await clickAway(page);
  await expect(page.locator('.textLayer')).toContainText('Reviewed by Alex');
  await menu(page, 'Insert blank page after');
  await expect(page.locator('.page-caption')).toHaveText('Page 2 of 2');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const download = await downloadEvent;
  const exported = await PDFDocument.load(await readFile(await download.path()));
  expect(exported.getPageCount()).toBe(1);
  expect(exported.getPage(0).node.Contents().size()).toBeGreaterThan(0);
});

test('repeated form references cannot multiply the fields dialog or exported fields', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await PDFDocument.load(await repeatedFieldTree(6)));
  await page.getByRole('button', { name: 'Fill forms', exact: true }).click();
  await expect(page.locator('#toast')).toContainText('form in this PDF is damaged');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await menu(page, 'Rotate clockwise');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('button', { name: 'Fill forms', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Fill forms', exact: true });
  await expect(dialog.getByRole('textbox')).toHaveCount(1);
  await expect(dialog.getByRole('textbox')).toHaveValue('Saved value');
  await dialog.getByRole('textbox').fill('Updated once');
  await dialog.getByRole('button', { name: 'Save form', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const saved = await PDFDocument.load(await readFile(await (await pending).path()));
  const fields = saved.getForm().getFields();
  expect(fields).toHaveLength(1);
  expect(fields[0].getText()).toBe('Updated once');
  expect(fields[0].acroField.getWidgets()).toHaveLength(1);
});

for (const kind of ['root self', 'multiple cycles'])
  test(`cyclic form parents are reported and repaired by page edits: ${kind}`, async ({ page }) => {
    await mockPuter(page);
    await page.goto('/#library');
    await openPdf(page, await PDFDocument.load(await parentCyclePdf(kind)));
    await page.getByRole('button', { name: 'Fill forms', exact: true }).click();
    await expect(page.locator('#toast')).toHaveText(
      'The form in this PDF is damaged, so its fields cannot be read.',
    );
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Next page', exact: true }).click();
    await expect(page.locator('.page-caption')).toHaveText('Page 2 of 2');
    await menu(page, 'Delete page');
    await page.getByRole('button', { name: 'Delete page', exact: true }).click();
    await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
    await page.getByRole('button', { name: 'Fill forms', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Fill forms', exact: true });
    await expect(dialog.getByLabel('group.Name (read only)', { exact: true })).toHaveValue(
      'Inherited value',
    );
    await expect(dialog.getByLabel('group.Name (read only)', { exact: true })).toBeDisabled();
    await dialog.getByLabel('Safe', { exact: true }).fill('Updated');
    await dialog.getByRole('button', { name: 'Save form', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download', exact: true }).click();
    const saved = await PDFDocument.load(await readFile(await (await pending).path()));
    expect(saved.getForm().getTextField('group.Name').getText()).toBe('Inherited value');
    expect(saved.getForm().getTextField('group.Name').isReadOnly()).toBe(true);
    expect(saved.getForm().getTextField('Safe').getText()).toBe('Updated');
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(page.locator('.page-caption')).toHaveText('Page 1 of 2');
    await page.getByRole('button', { name: 'Fill forms', exact: true }).click();
    await expect(page.locator('#toast')).toContainText('form in this PDF is damaged');
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
    await page.getByRole('button', { name: 'Fill forms', exact: true }).click();
    await expect(dialog.getByLabel('Safe', { exact: true })).toHaveValue('Unchanged');
  });

test('fills real PDF form fields and keeps changes on download', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  await sample(page);
  await page.getByRole('button', { name: 'Fill forms', exact: true }).click();
  await page.getByRole('button', { name: 'Save form', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.save-status')).toHaveText('Local file');
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Fill forms', exact: true }).click();
  await page.getByLabel('Your name', { exact: true }).fill('Alex Morgan');
  await page.getByRole('button', { name: 'Save form', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.save-status')).toHaveText('Unsaved changes');
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const d = await pending;
  const pdf = await PDFDocument.load(await readFile(await d.path()));
  expect(pdf.getForm().getTextField('Your name').getText()).toBe('Alex Morgan');
});

test('save errors retain dirty state and Puter app has no logout', async ({ page }) => {
  await mockPuter(page, { app: true, failSave: true });
  await page.goto('/#library');
  await sample(page);
  await menu(page, 'Rotate clockwise');
  await expect(page.locator('.save-status')).toHaveText('Unsaved changes');
  await page.getByRole('button', { name: 'Save to Puter', exact: true }).click();
  await expect(page.locator('#toast')).toHaveText('Storage unavailable');
  await expect(page.locator('.save-status')).toHaveText('Unsaved changes');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.getByRole('button', { name: 'Back to your PDFs' }).click();
  await expect(page.getByRole('dialog')).toContainText('unsaved changes');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('.editor')).toBeVisible();
});

test('cloud save writes a PDF and search navigates to matching pages', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  await sample(page);
  await page.getByRole('button', { name: 'Save to Puter', exact: true }).click();
  await expect(page.locator('.save-status')).toHaveText('Saved to Puter');
  expect(await page.evaluate(() => window.lastSave)).toMatchObject({
    path: 'PDF Editor/Getting started.pdf',
    options: { dedupeName: true, overwrite: false },
  });
  await page.getByRole('button', { name: 'Find text or tools', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Find in PDF', exact: true }).fill('paperwork');
  await expect(page.locator('.search-count')).toHaveText('1 of 1');
  await page.getByRole('button', { name: 'Close search', exact: true }).click();
  await page.getByRole('button', { name: 'Find text or tools', exact: true }).click();
  await expect(page.getByRole('searchbox', { name: 'Find in PDF', exact: true })).toHaveValue('');
  await expect(page.locator('.search-count')).toHaveText('');
  await expect(page.locator('.search-hit')).toHaveCount(0);
});

test('home and editor meet automated accessibility checks without viewport overflow', async ({
  page,
}, testInfo) => {
  await mockPuter(page);
  await page.goto('/#library');
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('home.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await sample(page);
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('editor.png'), fullPage: true });
});

test('rotated pages keep text selection aligned and annotations persist through undo', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  await sample(page);
  await menu(page, 'Rotate clockwise');
  await expect(page.locator('.textLayer')).toHaveAttribute('data-main-rotation', '90');
  const paper = await page.locator('.paper').boundingBox();
  const text = await page
    .locator('.textLayer span')
    .filter({ hasText: 'Make it your own.' })
    .boundingBox();
  expect(text.x).toBeGreaterThanOrEqual(paper.x);
  expect(text.x + text.width).toBeLessThanOrEqual(paper.x + paper.width + 1);
  expect(text.height).toBeGreaterThan(text.width);
  await page.getByRole('button', { name: 'Highlight', exact: true }).click();
  await page.getByRole('button', { name: 'Place at page center' }).click();
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const d = await pending;
  const pdf = await PDFDocument.load(await readFile(await d.path()));
  expect(pdf.getPage(0).getRotation().angle).toBe(90);
});

test('downloading edited cloud content does not claim the cloud copy is saved', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  await sample(page);
  await page.getByRole('button', { name: 'Save to Puter', exact: true }).click();
  await expect(page.locator('.save-status')).toHaveText('Saved to Puter');
  await menu(page, 'Rotate clockwise');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  await pending;
  await expect(page.locator('.save-status')).toHaveText('Downloaded');
});

test('tablet dark mode stays accessible and mobile tools remain discoverable', async ({
  page,
}, testInfo) => {
  await mockPuter(page);
  await page.setViewportSize({ width: 820, height: 1180 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/#library');
  await sample(page);
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('tablet-dark.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  const forms = await page.getByRole('button', { name: 'Fill forms', exact: true }).boundingBox();
  expect(forms.x + forms.width).toBeLessThanOrEqual(390);
});

test('edits and deletes existing text in place, preserving graphics and undo after export', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  await sample(page);
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  await page.getByRole('button', { name: 'Edit text: Make it your own.', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Edit text', exact: true })).toHaveValue(
    'Make it your own.',
  );
  await page
    .getByRole('textbox', { name: 'Edit text', exact: true })
    .fill('Make editing feel natural.');
  await clickAway(page);
  await expect(page.locator('.textLayer')).toContainText('Make editing feel natural.');
  await expect(page.locator('.textLayer')).not.toContainText('Make it your own.');
  await expect(page.locator('.textLayer')).toContainText('A little less paperwork.');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('.textLayer')).toContainText('Make it your own.');
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(page.locator('.textLayer')).toContainText('Make editing feel natural.');
  await page
    .getByRole('button', { name: 'Edit text: Make editing feel natural.', exact: true })
    .click();
  await page.getByRole('button', { name: 'Delete text', exact: true }).click();
  await expect(page.locator('.textLayer')).not.toContainText('Make editing feel natural.');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('.textLayer')).toContainText('Make editing feel natural.');
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const bytes = await readFile(await (await pending).path());
  await page.getByRole('button', { name: 'Back to your PDFs', exact: true }).click();
  await openPdf(page, await PDFDocument.load(bytes), 'edited.pdf');
  await expect(page.locator('.textLayer')).toContainText('Make editing feel natural.');
  await expect(page.locator('.textLayer')).not.toContainText('Make it your own.');
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Edit text: Make editing feel natural.', exact: true }),
  ).toBeVisible();
});

test('inline text supports cancellation, formatting and switching targets without losing drafts', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  await sample(page);
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  const heading = page.getByRole('button', { name: 'Edit text: Make it your own.', exact: true });
  await heading.click();
  await expect(page.getByLabel('Text size', { exact: true })).toHaveValue('34');
  await clickAway(page);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await heading.click();
  await page.getByRole('textbox', { name: 'Edit text', exact: true }).fill('Discard me');
  await expect(page.locator('.save-status')).toHaveText('Unsaved changes');
  await page.getByRole('textbox', { name: 'Edit text', exact: true }).press('Escape');
  await expect(page.locator('.save-status')).toHaveText('Local file');
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await heading.click();
  await page.getByLabel('Text size', { exact: true }).selectOption('20');
  await page.getByLabel('Annotation color', { exact: true }).fill('#cc2200');
  await clickAway(page);
  await heading.click();
  await expect(page.getByLabel('Text size', { exact: true })).toHaveValue('20');
  await expect(page.getByLabel('Annotation color', { exact: true })).toHaveValue('#cc2200');
  await page.getByRole('textbox', { name: 'Edit text', exact: true }).fill('Changed heading');
  await page
    .getByRole('button', { name: 'Edit text: PDF EDITOR / GETTING STARTED', exact: true })
    .click();
  await expect(page.getByRole('textbox', { name: 'Edit text', exact: true })).toHaveValue(
    'PDF EDITOR / GETTING STARTED',
  );
  await expect(page.locator('.textLayer')).toContainText('Changed heading');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('.textLayer')).toContainText('Make it your own.');
});

test('download commits an active text draft and font errors preserve it for correction', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  await sample(page);
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  await page.getByRole('button', { name: 'Edit text: Make it your own.', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Edit text', exact: true });
  await input.fill('你好');
  await clickAway(page);
  await expect(page.locator('.text-edit-error')).toContainText('does not support');
  await expect(input).toHaveValue('你好');
  await expect(page.locator('.textLayer')).toContainText('Make it your own.');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Edit text: Make it your own.', exact: true }).click();
  await input.fill('Ready for download');
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const doc = await PDFDocument.load(await readFile(await (await pending).path()));
  await expect(input).toHaveCount(0);
  await expect(page.locator('.save-status')).toHaveText('Downloaded');
  await page.getByRole('button', { name: 'Back to your PDFs', exact: true }).click();
  await openPdf(page, doc);
  await expect(page.locator('.textLayer')).toContainText('Ready for download');
  await expect(page.locator('.textLayer')).not.toContainText('Make it your own.');
});

test('rotated text remains editable at different zoom levels and newly added text can be revised', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  const pdfPage = doc.addPage([400, 500]);
  pdfPage.setCropBox(20, 30, 360, 440);
  pdfPage.setRotation(degrees(90));
  pdfPage.drawText('Rotated label', { x: 100, y: 200, size: 20, rotate: degrees(25) });
  await openPdf(page, doc);
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  await page.getByRole('button', { name: 'Edit text: Rotated label', exact: true }).click();
  await page.getByRole('textbox', { name: 'Edit text', exact: true }).fill('Revised label');
  await page.getByLabel('Zoom', { exact: true }).selectOption('1.25');
  await expect(
    page.getByRole('button', { name: 'Edit text: Revised label', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Edit text: Revised label', exact: true }).click();
  await page.getByRole('textbox', { name: 'Edit text', exact: true }).press('Escape');
  await page.getByRole('button', { name: 'Place at page center', exact: true }).click();
  await page.getByLabel('Text to add', { exact: true }).fill('New note');
  await page.getByLabel('Text to add', { exact: true }).press('ControlOrMeta+Enter');
  await page.getByRole('button', { name: 'Edit text: New note', exact: true }).click();
  await page.getByRole('textbox', { name: 'Edit text', exact: true }).fill('Revised note');
  await clickAway(page);
  await expect(page.locator('.textLayer')).toContainText('Revised note');
  await expect(page.locator('.textLayer')).not.toContainText('New note');
});

test('fills a form directly on the page and preserves it through download, undo and reopen', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  await sample(page);
  const field = page.getByRole('textbox', { name: 'Your name (on page)', exact: true });
  await field.fill('Alex Morgan');
  await expect(page.locator('.save-status')).toHaveText('Unsaved changes');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(field).toHaveValue('');
  await expect(page.locator('.save-status')).toHaveText('Local file');
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(field).toHaveValue('Alex Morgan');
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const doc = await PDFDocument.load(await readFile(await (await pending).path()));
  expect(doc.getForm().getTextField('Your name').getText()).toBe('Alex Morgan');
  await expect(page.locator('.save-status')).toHaveText('Downloaded');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(field).toHaveValue('');
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(field).toHaveValue('Alex Morgan');
  await page.getByRole('button', { name: 'Back to your PDFs', exact: true }).click();
  await openPdf(page, doc);
  await expect(field).toHaveValue('Alex Morgan');
});

test('inline form fields synchronize shared widgets and commit when navigating or opening the form dialog', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  const first = doc.addPage([600, 700]),
    second = doc.addPage([600, 700]);
  const field = doc.getForm().createTextField('Shared');
  field.addToPage(first, { x: 40, y: 600, width: 200, height: 30 });
  field.addToPage(first, { x: 300, y: 600, width: 200, height: 30 });
  field.addToPage(second, { x: 40, y: 600, width: 200, height: 30 });
  await openPdf(page, doc);
  const controls = page.getByRole('textbox', { name: 'Shared (on page)', exact: true });
  await controls.first().fill('Both widgets');
  await expect(controls.nth(1)).toHaveValue('Both widgets');
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(controls).toHaveCount(1);
  await expect(controls).toHaveValue('Both widgets');
  await controls.fill('From page two');
  await page.getByRole('button', { name: 'Fill forms', exact: true }).click();
  await expect(page.getByLabel('Shared', { exact: true })).toHaveValue('From page two');
  await page.getByLabel('Shared', { exact: true }).fill('From dialog');
  await page.getByRole('button', { name: 'Save form', exact: true }).click();
  await expect(controls).toHaveValue('From dialog');
  await page.getByRole('button', { name: 'Previous page', exact: true }).click();
  await expect(controls).toHaveCount(2);
  await expect(controls.first()).toHaveValue('From dialog');
  await expect(controls.nth(1)).toHaveValue('From dialog');
});

test('inline checkbox, radio, choices, multiline and read-only fields retain their PDF values', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  const { PDFHexString } = await import('pdf-lib');
  const doc = await PDFDocument.create(),
    pdfPage = doc.addPage([600, 700]),
    form = doc.getForm();
  const notes = form.createTextField('Notes');
  notes.enableMultiline();
  notes.setMaxLength(40);
  notes.addToPage(pdfPage, { x: 40, y: 520, width: 480, height: 100 });
  const locked = form.createTextField('Locked');
  locked.setText('Original');
  locked.enableReadOnly();
  locked.addToPage(pdfPage, { x: 40, y: 450, width: 200, height: 30 });
  form.createCheckBox('Confirm').addToPage(pdfPage, { x: 40, y: 380, width: 20, height: 20 });
  const radio = form.createRadioGroup('Consent');
  radio.addOptionToPage('同意', pdfPage, { x: 40, y: 320, width: 20, height: 20 });
  radio.addOptionToPage('不同意', pdfPage, { x: 100, y: 320, width: 20, height: 20 });
  const country = form.createDropdown('Country');
  country.acroField.setOptions([
    { value: PDFHexString.fromText('ca'), display: PDFHexString.fromText('Canada') },
    { value: PDFHexString.fromText('fr'), display: PDFHexString.fromText('France') },
  ]);
  country.addToPage(pdfPage, { x: 40, y: 250, width: 200, height: 30 });
  const list = form.createOptionList('Languages');
  list.setOptions(['English', 'French', 'Greek']);
  list.enableMultiselect();
  list.addToPage(pdfPage, { x: 300, y: 210, width: 200, height: 80 });
  await openPdf(page, doc);
  const input = page.getByRole('textbox', { name: 'Notes (on page)', exact: true });
  await expect(input).toHaveAttribute('maxlength', '40');
  await input.fill('First line\nSecond line');
  await expect(
    page.getByRole('textbox', { name: 'Locked (on page) (read only)', exact: true }),
  ).toBeDisabled();
  await page.getByRole('checkbox', { name: 'Confirm (on page)', exact: true }).check();
  const agree = page.getByRole('radio', { name: 'Consent: 同意 (on page)', exact: true });
  await agree.check();
  await agree.press('ArrowRight');
  await expect(
    page.getByRole('radio', { name: 'Consent: 不同意 (on page)', exact: true }),
  ).toBeChecked();
  await expect(agree).not.toBeChecked();
  await page
    .getByRole('combobox', { name: 'Country (on page)', exact: true })
    .selectOption({ label: 'France' });
  await page
    .getByRole('listbox', { name: 'Languages (on page)', exact: true })
    .selectOption(['French', 'Greek']);
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const saved = (await PDFDocument.load(await readFile(await (await pending).path()))).getForm();
  expect(saved.getTextField('Notes').getText()).toBe('First line\nSecond line');
  expect(saved.getTextField('Locked').getText()).toBe('Original');
  expect(saved.getCheckBox('Confirm').isChecked()).toBe(true);
  expect(saved.getRadioGroup('Consent').getSelected()).toBe('不同意');
  expect(saved.getDropdown('Country').getSelected()).toEqual(['fr']);
  expect(saved.getDropdown('Country').isEditable()).toBe(false);
  expect(saved.getOptionList('Languages').getSelected()).toEqual(['French', 'Greek']);
});

test('inline form errors retain drafts, Escape restores values, and annotation tools do not intercept fields', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  await sample(page);
  const field = page.getByRole('textbox', { name: 'Your name (on page)', exact: true });
  await field.fill('你好');
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  await expect(page.locator('.form-edit-error')).toContainText('does not support');
  await expect(field).toHaveValue('你好');
  await expect(field).toBeFocused();
  await expect(page.getByRole('button', { name: 'Select', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await field.press('Escape');
  await expect(field).toHaveValue('');
  await expect(page.locator('.save-status')).toHaveText('Local file');
  await field.fill('Alex');
  await field.press('Enter');
  await expect(page.locator('.form-edit-error')).toBeHidden();
  await expect(field).toHaveValue('Alex');
  await expect(field).toBeFocused();
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  await expect(page.locator('.form-layer')).toBeHidden();
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await expect(field).toBeVisible();
  await expect(field).toHaveValue('Alex');
});

for (const rotation of [0, 90, 180, 270]) {
  test(`inline form fields follow widget rotation ${rotation}, page rotation, crop and zoom`, async ({
    page,
  }) => {
    await mockPuter(page);
    await page.goto('/#library');
    const doc = await PDFDocument.create(),
      pdfPage = doc.addPage([500, 600]);
    pdfPage.setCropBox(20, 30, 450, 550);
    pdfPage.setRotation(degrees(90));
    pdfPage.node.set(PDFName.of('UserUnit'), PDFNumber.of(2));
    const field = doc.getForm().createTextField('Rotated');
    field.addToPage(pdfPage, { x: 200, y: 250, width: 160, height: 30, rotate: degrees(rotation) });
    await openPdf(page, doc);
    const input = page.getByRole('textbox', { name: 'Rotated (on page)', exact: true });
    await input.fill(`Rotation ${rotation}`);
    await page.getByLabel('Zoom', { exact: true }).selectOption('0.5');
    await expect(input).toHaveValue(`Rotation ${rotation}`);
    await expect(page.locator('.paper')).toHaveCSS('width', '550px');
    await expect(page.locator('.paper')).toHaveAttribute('aria-busy', 'false');
    const widget = field.acroField.getWidgets()[0].getRectangle();
    const actual = await input.boundingBox(),
      paper = await page.locator('.paper').boundingBox();
    expect(actual.x - paper.x).toBeCloseTo(widget.y - 30, 0);
    expect(actual.y - paper.y).toBeCloseTo(widget.x - 20, 0);
    expect(actual.width).toBeCloseTo(widget.height, 0);
    expect(actual.height).toBeCloseTo(widget.width, 0);
    expect(
      await input.evaluate((node) => {
        const m = new DOMMatrix(getComputedStyle(node.parentElement).transform);
        return [m.a, m.b, m.c, m.d];
      }),
    ).toEqual(
      { 0: [0, 1, -1, 0], 90: [1, 0, 0, 1], 180: [0, -1, 1, 0], 270: [-1, 0, 0, -1] }[rotation],
    );
    await input.fill('After zoom');
    await input.press('Enter');
    await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
    await expect(input).toBeFocused();
    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download', exact: true }).click();
    const reopened = await PDFDocument.load(await readFile(await (await pending).path()));
    expect(reopened.getForm().getTextField('Rotated').getText()).toBe('After zoom');
    expect(reopened.getPage(0).getRotation().angle).toBe(90);
    expect(
      reopened
        .getForm()
        .getTextField('Rotated')
        .acroField.getWidgets()[0]
        .getAppearanceCharacteristics()
        .getRotation(),
    ).toBe(rotation);
  });
}

test('inline choices distinguish an empty option from clearing and allow custom editable values', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  const { PDFHexString } = await import('pdf-lib');
  const doc = await PDFDocument.create(),
    pdfPage = doc.addPage([500, 500]),
    form = doc.getForm();
  const choice = form.createDropdown('Choice');
  choice.setOptions(['', 'Other']);
  choice.select('');
  choice.addToPage(pdfPage, { x: 40, y: 350, width: 200, height: 30 });
  const city = form.createDropdown('City');
  city.acroField.setOptions([
    { value: PDFHexString.fromText('paris-code'), display: PDFHexString.fromText('Paris') },
  ]);
  city.enableEditing();
  city.addToPage(pdfPage, { x: 40, y: 280, width: 200, height: 30 });
  await openPdf(page, doc);
  const dropdown = page.getByRole('combobox', { name: 'Choice (on page)', exact: true });
  await expect(dropdown.locator('option:checked')).toHaveText('(Empty option)');
  await dropdown.selectOption({ label: 'Choose an option' });
  const editable = page.getByRole('combobox', { name: 'City (on page)', exact: true });
  await editable.fill('Paris');
  let pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  let saved = (await PDFDocument.load(await readFile(await (await pending).path()))).getForm();
  expect(saved.getDropdown('Choice').getSelected()).toEqual([]);
  expect(saved.getDropdown('City').getSelected()).toEqual(['paris-code']);
  await expect(editable).toHaveValue('Paris');
  await dropdown.selectOption({ label: '(Empty option)' });
  await editable.fill('Montréal');
  pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  saved = (await PDFDocument.load(await readFile(await (await pending).path()))).getForm();
  expect(saved.getDropdown('Choice').getSelected()).toEqual(['']);
  expect(saved.getDropdown('City').getSelected()).toEqual(['Montréal']);
});

test('resizing the page preserves active form drafts and keyboard focus', async ({ page }) => {
  await mockPuter(page);
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.goto('/#library');
  await sample(page);
  const field = page.getByRole('textbox', { name: 'Your name (on page)', exact: true });
  await field.fill('Still typing');
  await field.press('ArrowLeft');
  const previousWidth = (await page.locator('.paper').boundingBox()).width;
  await page.setViewportSize({ width: 850, height: 800 });
  await expect(field).toHaveValue('Still typing');
  await expect(field).toBeFocused();
  // Wait for the width-dependent render, then verify the restored caret remains usable.
  await expect
    .poll(async () => (await page.locator('.paper').boundingBox()).width)
    .toBeLessThan(previousWidth);
  await expect(page.locator('.paper')).toHaveAttribute('aria-busy', 'false');
  await field.press('!');
  await expect(field).toHaveValue('Still typin!g');
  await expect(page.locator('.save-status')).toHaveText('Unsaved changes');
});

test('inline fields respect hidden widgets and do not execute document actions', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  const { PDFHexString } = await import('pdf-lib');
  const doc = await PDFDocument.create(),
    pdfPage = doc.addPage([400, 500]),
    form = doc.getForm();
  const hidden = form.createTextField('Hidden');
  hidden.addToPage(pdfPage, { x: 40, y: 400, width: 200, height: 30 });
  hidden.acroField.getWidgets()[0].dict.set(PDFName.of('F'), PDFNumber.of(2));
  const field = form.createTextField('Visible');
  field.addToPage(pdfPage, { x: 40, y: 300, width: 200, height: 30 });
  field.acroField.dict.set(
    PDFName.of('AA'),
    doc.context.obj({
      K: { S: 'JavaScript', JS: PDFHexString.fromText('window.pdfActionExecuted = true') },
    }),
  );
  const button = form.createButton('Submit');
  button.addToPage('Submit', pdfPage, { x: 40, y: 200, width: 100, height: 30 });
  await openPdf(page, doc);
  await expect(page.getByRole('textbox', { name: 'Hidden (on page)', exact: true })).toHaveCount(0);
  await expect(page.locator('.form-layer input')).toHaveCount(1);
  await page
    .getByRole('textbox', { name: 'Visible (on page)', exact: true })
    .fill('Safe local text');
  expect(await page.evaluate(() => window.pdfActionExecuted)).toBeUndefined();
});

test('cloud saves commit inline fields and keep later drafts unsaved while the write is pending', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  await sample(page);
  const field = page.getByRole('textbox', { name: 'Your name (on page)', exact: true });
  await field.fill('First value');
  await page.evaluate(() => {
    window.puter.fs.write = async (path, blob) => {
      window.savedFormBytes = [...new Uint8Array(await blob.arrayBuffer())];
      return new Promise((resolve) => {
        window.finishFormSave = () => resolve({ path, name: path.split('/').pop() });
      });
    };
  });
  await page.getByRole('button', { name: 'Save to Puter', exact: true }).click();
  await expect(page.locator('.save-status')).toHaveText('Saving…');
  await expect.poll(() => page.evaluate(() => !!window.finishFormSave)).toBe(true);
  await field.fill('Later value');
  await page.evaluate(() => window.finishFormSave());
  await expect(page.locator('.save-status')).toHaveText('Unsaved changes');
  const saved = await PDFDocument.load(
    new Uint8Array(await page.evaluate(() => window.savedFormBytes)),
  );
  expect(saved.getForm().getTextField('Your name').getText()).toBe('First value');
  await expect(field).toHaveValue('Later value');
  await page.getByRole('button', { name: 'Back to your PDFs', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(field).toHaveValue('Later value');
});

async function fragmentedTextPdf(rotation = 0) {
  const doc = await PDFDocument.create(),
    p = doc.addPage([400, 400]);
  p.setRotation(degrees(rotation));
  const font = await doc.embedFont(StandardFonts.Helvetica),
    bold = await doc.embedFont(StandardFonts.HelveticaBold);
  p.node.set(PDFName.of('Resources'), doc.context.obj({ Font: { F: font.ref, B: bold.ref } }));
  p.node.set(
    PDFName.of('Contents'),
    doc.context.register(
      doc.context.flateStream(
        '0.2 0.6 0.7 rg 0 0 400 400 re f 0 0 0 rg BT /F 18 Tf 40 300 Td (Hello ) Tj /B 18 Tf 0.8 0.1 0.2 rg (bold) Tj /F 18 Tf 0 0 0 rg ( world) Tj 0 -70 Td (Neighbor) Tj ET',
      ),
    ),
  );
  return doc;
}
async function exportedTextRuns(page) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const bytes = new Uint8Array(await readFile(await (await pending).path()));
  const { inspectText } = await import('../../src/core/text-edit.js');
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    standardFontDataUrl: new URL('../../node_modules/pdfjs-dist/standard_fonts/', import.meta.url)
      .pathname,
  });
  try {
    return {
      bytes,
      runs: (
        await inspectText(
          await PDFDocument.load(bytes),
          0,
          await (await task.promise).getPage(1),
          pdfjs.OPS,
        )
      ).filter((r) => r.text),
    };
  } finally {
    await task.destroy();
  }
}

test('grouped text preserves mixed fonts and colors through typing, export, reopen and undo', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await fragmentedTextPdf());
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  const target = page.getByRole('button', { name: 'Edit text: Hello bold world', exact: true });
  await target.click();
  const input = page.getByRole('textbox', { name: 'Edit text', exact: true });
  await expect(input).toHaveText('Hello bold world');
  await expect(input.locator('[data-part="1"]')).toHaveCSS('color', 'rgb(204, 26, 51)');
  await expect(input.locator('[data-part="1"]')).toHaveCSS('font-weight', '700');
  await expect(page.locator('.text-draft-background')).toBeVisible();
  await clickAway(page);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await target.click();
  // Replace just the first word, leaving the source style spans intact.
  await input.press('ControlOrMeta+a');
  await input.press('ArrowLeft');
  for (let i = 0; i < 5; i++) await input.press('Shift+ArrowRight');
  await page.keyboard.insertText('Greetings');
  await expect(input).toHaveText('Greetings bold world');
  await input.press('ControlOrMeta+z');
  await expect(input).toHaveText('Hello bold world');
  await expect(page.getByRole('group', { name: 'Text properties', exact: true })).toBeVisible();
  await input.press('ControlOrMeta+Shift+z');
  await expect(input).toHaveText('Greetings bold world');
  await clickAway(page);
  const output = await exportedTextRuns(page);
  expect(output.runs.map((r) => r.text)).toEqual(['Greetings ', 'bold', ' world', 'Neighbor']);
  expect(output.runs[1].fontName).toContain('Bold');
  expect(output.runs[1].fillColor).toBe('#cc1a33');
  for (let i = 1; i < 3; i++)
    expect(output.runs[i].transform[4]).toBeCloseTo(
      output.runs[i - 1].transform[4] + output.runs[i - 1].advance,
      5,
    );
  expect(output.runs[3].transform.slice(4)).toEqual([40, 230]);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(target).toBeVisible();
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  // Redo returns to the downloaded revision, so leaving needs no confirmation once it settles.
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
  await expect(page.locator('.save-status')).toHaveText('Downloaded');
  await page.getByRole('button', { name: 'Back to your PDFs', exact: true }).click();
  await openPdf(page, await PDFDocument.load(output.bytes), 'grouped.pdf');
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  await page.getByRole('button', { name: 'Edit text: Greetings bold world', exact: true }).click();
  await page.getByRole('button', { name: 'Delete text', exact: true }).click();
  await expect(page.locator('.textLayer')).not.toContainText('Greetings');
  await expect(page.locator('.textLayer')).not.toContainText('bold');
  await expect(page.locator('.textLayer')).toContainText('Neighbor');
});

test('dragging mixed-font text preserves its source style in the exported PDF', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await fragmentedTextPdf());
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  const target = page.getByRole('button', { name: 'Edit text: Hello bold world', exact: true });
  await target.click();
  const input = page.getByRole('textbox', { name: 'Edit text', exact: true });
  const points = await input.evaluate((el) => {
    el.focus();
    const range = document.createRange();
    range.setStart(el.querySelector('[data-part="1"]').firstChild, 0);
    range.setEnd(el.querySelector('[data-part="2"]').firstChild, 1);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    const start = range.getBoundingClientRect();
    const caret = document.createRange();
    caret.setStart(el.querySelector('[data-part="0"]').firstChild, 0);
    caret.collapse(true);
    const end = caret.getBoundingClientRect();
    return {
      start: { x: start.x + start.width / 2, y: start.y + start.height / 2 },
      end: { x: end.x + 0.1, y: end.y + end.height / 2 },
    };
  });
  await page.waitForTimeout(250);
  await page.mouse.move(points.start.x, points.start.y);
  await page.mouse.down();
  await page.waitForTimeout(250);
  await page.mouse.move(points.end.x, points.end.y, { steps: 20 });
  await page.mouse.up();
  await expect.poll(() => input.evaluate((el) => el.value)).toBe('bold Hello world');
  const output = await exportedTextRuns(page);
  expect(output.runs.map((r) => r.text).join('')).toBe('bold Hello worldNeighbor');
  expect(output.runs[0].fontName).toContain('Bold');
  expect(output.runs[0].fillColor).toBe('#cc1a33');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(target).toBeVisible();
  await target.click();
  expect(await input.evaluate((el) => el.value)).toBe('Hello bold world');
  await expect(input.locator('[data-part="1"]')).toHaveCSS('color', 'rgb(204, 26, 51)');
});

test('grouped text supports multiline typing, plain paste, error recovery and draft cancellation', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await fragmentedTextPdf());
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  const target = page.getByRole('button', { name: 'Edit text: Hello bold world', exact: true });
  await target.click();
  const input = page.getByRole('textbox', { name: 'Edit text', exact: true });
  await input.fill('First');
  await input.press('End');
  await input.press('Enter');
  await page.keyboard.insertText('Second');
  const lines = await exportedTextRuns(page);
  expect(lines.runs.map((r) => r.text)).toEqual(['First', 'Second', 'Neighbor']);
  expect(lines.runs[1].transform[5]).toBeCloseTo(300 - 18 * 1.35, 5);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await target.click();
  await input.press('ControlOrMeta+a');
  await pasteText(input, 'Plain\nPaste', '<b>Wrong markup</b>');
  const pasted = await exportedTextRuns(page);
  expect(pasted.runs.map((r) => r.text)).toEqual(['Plain', 'Paste', 'Neighbor']);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await target.click();
  await input.fill('你好');
  await clickAway(page);
  await expect(page.locator('.text-edit-error')).toContainText('does not support');
  await expect(input).toHaveText('你好');
  await input.press('Escape');
  await expect(input).toHaveCount(0);
  await expect(target).toBeVisible();
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
});

for (const rotation of [0, 90, 180, 270])
  test(`grouped text moves and formats on rotated page ${rotation}`, async ({ page }) => {
    await mockPuter(page);
    await page.goto('/#library');
    await openPdf(page, await fragmentedTextPdf(rotation));
    await page.getByRole('button', { name: 'Text', exact: true }).click();
    await page.getByRole('button', { name: 'Edit text: Hello bold world', exact: true }).click();
    await expect(page.locator('.text-draft-background')).toBeVisible();
    await page.getByLabel('Text X in points', { exact: true }).fill('60');
    await page.getByLabel('Text Y in points', { exact: true }).fill('270');
    await page.getByLabel('Text size', { exact: true }).selectOption('24');
    await page.getByLabel('Annotation color', { exact: true }).fill('#1122cc');
    const output = await exportedTextRuns(page);
    for (const run of output.runs.slice(0, 3)) {
      expect(run.state.size).toBe(24);
      expect(run.fillColor).toBe('#1122cc');
    }
    expect(output.runs[0].transform.slice(4)).toEqual([60, 270]);
    expect(output.runs[3].transform.slice(4)).toEqual([40, 230]);
  });

test('grouped text retains the edited bold fragment and handles selection across style boundaries', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await fragmentedTextPdf());
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  await page.getByRole('button', { name: 'Edit text: Hello bold world', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Edit text', exact: true });
  await input.evaluate((el) => {
    const r = document.createRange();
    r.selectNodeContents(el.querySelector('[data-part="1"]'));
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  });
  await page.keyboard.insertText('brave');
  await expect(input).toHaveText('Hello brave world');
  const output = await exportedTextRuns(page);
  expect(output.runs.map((r) => r.text)).toEqual(['Hello ', 'brave', ' world', 'Neighbor']);
  expect(output.runs[1].fontName).toContain('Bold');
  expect(output.runs[1].fillColor).toBe('#cc1a33');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.getByRole('button', { name: 'Edit text: Hello bold world', exact: true }).click();
  await input.evaluate((el) => {
    const r = document.createRange();
    r.setStart(el.querySelector('[data-part="0"]').firstChild, 3);
    r.setEnd(el.querySelector('[data-part="1"]').firstChild, 2);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  });
  await input.press('Backspace');
  const joined = await exportedTextRuns(page);
  expect(joined.runs.map((r) => r.text)).toEqual(['Hel', 'ld', ' world', 'Neighbor']);
  expect(joined.runs[1].fontName).toContain('Bold');
  expect(joined.runs[1].fillColor).toBe('#cc1a33');
});

/** Snap a capture area to whole pixels: a fractional origin resamples thin glyphs into lighter
 * gray that the color thresholds no longer count, so the same text measures differently. */
function pixelClip({ x, y, width, height }) {
  const left = Math.floor(x),
    top = Math.floor(y);
  return {
    x: left,
    y: top,
    width: Math.ceil(x + width) - left,
    height: Math.ceil(y + height) - top,
  };
}

for (const rotation of [0, 90])
  test(`single-run text preview preserves character and word spacing at rotation ${rotation}`, async ({
    page,
  }) => {
    await mockPuter(page);
    await page.goto('/#library');
    const doc = await PDFDocument.create(),
      p = doc.addPage([400, 400]);
    p.setRotation(degrees(rotation));
    const font = await doc.embedFont(StandardFonts.Helvetica);
    p.node.set(PDFName.of('Resources'), doc.context.obj({ Font: { F: font.ref } }));
    p.node.set(
      PDFName.of('Contents'),
      doc.context.register(
        doc.context.flateStream('BT /F 18 Tf 2 Tc 8 Tw 1 0 0 1 40 300 Tm (Spaced words) Tj ET'),
      ),
    );
    await openPdf(page, doc);
    await page.getByRole('button', { name: 'Text', exact: true }).click();
    await page.getByLabel('Zoom', { exact: true }).selectOption('1');
    await expect(page.locator('.paper')).toHaveCSS('width', '400px');
    const target = page.getByRole('button', { name: 'Edit text: Spaced words', exact: true });
    await target.click();
    const input = page.getByRole('textbox', { name: 'Edit text', exact: true });
    await expect(page.locator('.text-draft-background')).toBeVisible();
    // Select a size that differs from the source: PDF character/word spacing stays in text
    // space when Tf changes, rather than scaling proportionally with the new font size.
    await page.getByLabel('Text size', { exact: true }).selectOption('24');
    await input.press('ArrowRight');
    await input.scrollIntoViewIfNeeded();
    const region = await input.boundingBox(),
      paper = await page.locator('.paper').boundingBox();
    const preview = await page.screenshot({
      clip: pixelClip(region),
      scale: 'css',
      style: '.text-edit-handles { visibility: hidden; }',
    });
    await clickAway(page);
    await expect(input).toHaveCount(0);
    await expect(target).toBeEnabled();
    const current = await page.locator('.paper').boundingBox();
    const saved = await page.screenshot({
      clip: pixelClip({
        ...region,
        x: region.x + current.x - paper.x,
        y: region.y + current.y - paper.y,
      }),
      scale: 'css',
      style: '.text-edit-handles { visibility: hidden; }',
    });
    const a = await coloredGlyphBounds(preview, 'black'),
      b = await coloredGlyphBounds(saved, 'black');
    for (const key of ['left', 'right', 'top', 'bottom'])
      expect(Math.abs(a[key] - b[key]), key).toBeLessThanOrEqual(1);
    const output = await exportedTextRuns(page);
    expect(output.runs[0].text).toBe('Spaced words');
    expect(output.runs[0].state.charSpacing).toBe(2);
    expect(output.runs[0].state.wordSpacing).toBe(8);
  });

async function coloredGlyphBounds(png, kind) {
  const image = await loadImage(png),
    canvas = createCanvas(image.width, image.height),
    ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  const data = ctx.getImageData(0, 0, image.width, image.height).data;
  let left = Infinity,
    top = Infinity,
    right = -Infinity,
    bottom = -Infinity;
  for (let y = 0; y < image.height; y++)
    for (let x = 0; x < image.width; x++) {
      const i = (y * image.width + x) * 4,
        r = data[i],
        g = data[i + 1],
        b = data[i + 2];
      const match = kind === 'black' ? r < 60 && g < 60 && b < 60 : r > 140 && g < 80 && b < 100;
      if (match) {
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x);
        bottom = Math.max(bottom, y);
      }
    }
  expect(Number.isFinite(left)).toBe(true);
  return { left, top, right, bottom };
}

for (const rotation of [0, 90, 180, 270])
  test(`mixed-size text preview matches PDF glyphs on rotated crop ${rotation}`, async ({
    page,
  }) => {
    await mockPuter(page);
    await page.goto('/#library');
    const doc = await PDFDocument.create(),
      p = doc.addPage([400, 400]);
    p.setRotation(degrees(rotation));
    p.setCropBox(20, 20, 360, 360);
    p.node.set(PDFName.of('UserUnit'), PDFNumber.of(2));
    const regular = await doc.embedFont(StandardFonts.Helvetica),
      bold = await doc.embedFont(StandardFonts.HelveticaBold);
    p.node.set(PDFName.of('Resources'), doc.context.obj({ Font: { F: regular.ref, B: bold.ref } }));
    p.node.set(
      PDFName.of('Contents'),
      doc.context.register(
        doc.context.flateStream(
          '0.2 0.6 0.7 rg 0 0 400 400 re f 0 0 0 rg BT /F 18 Tf 1 0 0 1 40 300 Tm (Hello) Tj /B 30 Tf 0.8 0.1 0.2 rg 1 0 0 1 91 300 Tm (WORLD) Tj ET',
        ),
      ),
    );
    await openPdf(page, doc);
    await page.getByRole('button', { name: 'Text', exact: true }).click();
    const paper = page.locator('.paper'),
      target = page.getByRole('button', { name: 'Edit text: Hello WORLD', exact: true });
    await target.scrollIntoViewIfNeeded();
    // Keep the complete line visible so workspace clipping cannot affect the pixel comparison.
    await page.getByLabel('Zoom', { exact: true }).selectOption('0.5');
    await expect(paper).toHaveCSS('width', '360px');
    await expect(target).toBeEnabled();
    await target.scrollIntoViewIfNeeded();
    const region = await target.boundingBox();
    const original = await page.screenshot({
      clip: pixelClip(region),
      scale: 'css',
      style: '.text-edit-handles { visibility: hidden; }',
    });
    await target.click();
    await expect(page.locator('.text-draft-background')).toBeVisible();
    const input = page.getByRole('textbox', { name: 'Edit text', exact: true });
    await input.press('ArrowRight');
    await input.scrollIntoViewIfNeeded();
    const preview = await page.screenshot({
      clip: pixelClip(await target.boundingBox()),
      scale: 'css',
      style: '.text-edit-handles { visibility: hidden; }',
    });
    for (const color of ['black', 'red']) {
      const a = await coloredGlyphBounds(original, color),
        b = await coloredGlyphBounds(preview, color);
      for (const key of ['left', 'top', 'right', 'bottom'])
        expect(Math.abs(a[key] - b[key]), `${color} ${key}`).toBeLessThanOrEqual(1);
    }
    await clickAway(page);
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
    await target.click();
    await page.getByLabel('Text size', { exact: true }).selectOption('48');
    await expect(page.locator('.text-draft-background')).toBeVisible();
    await input.press('ArrowRight');
    await input.scrollIntoViewIfNeeded();
    const draftBox = await input.boundingBox(),
      paperBox = await paper.boundingBox();
    const draft = await page.screenshot({
      clip: pixelClip(draftBox),
      scale: 'css',
      style: '.text-edit-handles { visibility: hidden; }',
    });
    await clickAway(page);
    await expect(target).toBeEnabled();
    const nextPaperBox = await paper.boundingBox();
    const committed = await page.screenshot({
      clip: pixelClip({
        ...draftBox,
        x: draftBox.x + nextPaperBox.x - paperBox.x,
        y: draftBox.y + nextPaperBox.y - paperBox.y,
      }),
      scale: 'css',
      style: '.text-edit-handles { visibility: hidden; }',
    });
    for (const color of ['black', 'red']) {
      const a = await coloredGlyphBounds(draft, color),
        b = await coloredGlyphBounds(committed, color);
      for (const key of ['left', 'top', 'right', 'bottom'])
        expect(Math.abs(a[key] - b[key]), `resized ${color} ${key}`).toBeLessThanOrEqual(1);
    }
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  });

for (const rotation of [0, 90])
  test(`paragraph editing wraps naturally and preserves exported layout at ${rotation} degrees`, async ({
    page,
  }) => {
    await mockPuter(page);
    await page.goto('/#library');
    const doc = await PDFDocument.create(),
      p = doc.addPage([400, 400]);
    p.setRotation(degrees(rotation));
    const regular = await doc.embedFont(StandardFonts.Helvetica),
      bold = await doc.embedFont(StandardFonts.HelveticaBold);
    p.node.set(PDFName.of('Resources'), doc.context.obj({ Font: { F: regular.ref, B: bold.ref } }));
    p.node.set(
      PDFName.of('Contents'),
      doc.context.register(
        doc.context.flateStream(
          '0.2 0.6 0.7 rg 0 0 400 400 re f 0 0 0 rg BT /F 18 Tf 22 TL 40 320 Td (This is a longer first line) Tj T* (and a ) Tj /B 18 Tf 0.8 0.1 0.2 rg (shorter) Tj /F 18 Tf 0 0 0 rg ( second line.) Tj T* (End.) Tj 0 -90 Td (Neighbor) Tj ET',
        ),
      ),
    );
    await openPdf(page, doc);
    await page.getByRole('button', { name: 'Text', exact: true }).click();
    await page.getByLabel('Zoom', { exact: true }).selectOption('0.75');
    await expect(page.locator('.paper')).toHaveCSS('width', '300px');
    const original = await exportedTextRuns(page);
    const label = 'This is a longer first line and a shorter second line. End.';
    const target = page.getByRole('button', { name: `Edit text: ${label}`, exact: true });
    await target.click();
    const input = page.getByRole('textbox', { name: 'Edit text', exact: true });
    await expect(input).toHaveText(label);
    await expect(input).toHaveCSS('white-space', 'pre-wrap');
    await clickAway(page);
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
    const unchanged = await exportedTextRuns(page);
    expect(unchanged.runs.map((r) => [r.text, r.transform])).toEqual(
      original.runs.map((r) => [r.text, r.transform]),
    );
    await target.click();
    await input.press('ControlOrMeta+a');
    await input.press('ArrowLeft');
    await page.keyboard.insertText('Some additional words. ');
    await expect(input).toHaveText(`Some additional words. ${label}`);
    await input.press('ControlOrMeta+z');
    await expect(input).toHaveText(label);
    await input.press('ControlOrMeta+Shift+z');
    await expect(input).toHaveText(`Some additional words. ${label}`);
    const flow = await input.evaluate((el) => el.exportLayout());
    expect(flow.text.split('\n').length).toBeGreaterThan(3);
    await expect(page.locator('.text-draft-background')).toBeVisible();
    const paper = page.locator('.paper'),
      box = await input.boundingBox(),
      paperBox = await paper.boundingBox();
    const draft = await page.screenshot({
      clip: pixelClip(box),
      scale: 'css',
      style: '.text-edit-handles { visibility: hidden; }',
    });
    await clickAway(page);
    await expect(input).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Edit text: Neighbor', exact: true }),
    ).toBeEnabled();
    const current = await paper.boundingBox();
    const saved = await page.screenshot({
      clip: pixelClip({
        ...box,
        x: box.x + current.x - paperBox.x,
        y: box.y + current.y - paperBox.y,
      }),
      scale: 'css',
      style: '.text-edit-handles { visibility: hidden; }',
    });
    for (const color of ['black', 'red']) {
      const a = await coloredGlyphBounds(draft, color),
        b = await coloredGlyphBounds(saved, color);
      for (const key of ['left', 'right', 'top', 'bottom'])
        expect(Math.abs(a[key] - b[key]), `${rotation} ${color} ${key}`).toBeLessThanOrEqual(1);
    }
    const output = await exportedTextRuns(page);
    expect(output.runs.at(-1).transform).toEqual(original.runs.at(-1).transform);
    expect(
      output.runs
        .filter((r) => r.fillColor === '#cc1a33')
        .map((r) => r.text)
        .join(''),
    ).toBe('shorter');
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(target).toBeEnabled();
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
    await expect(page.locator('.save-status')).toHaveText('Downloaded');
    await page.getByRole('button', { name: 'Back to your PDFs', exact: true }).click();
    await openPdf(page, await PDFDocument.load(output.bytes));
    const reopened = await exportedTextRuns(page);
    expect(reopened.runs.map((r) => [r.text, r.transform, r.fillColor])).toEqual(
      output.runs.map((r) => [r.text, r.transform, r.fillColor]),
    );
  });

for (const rotation of [0, 90, 180, 270])
  test(`paragraph width supports numeric, keyboard and drag edits on rotated crop ${rotation}`, async ({
    page,
  }) => {
    await mockPuter(page);
    await page.goto('/#library');
    const doc = await PDFDocument.create(),
      p = doc.addPage([400, 400]),
      font = await doc.embedFont(StandardFonts.Helvetica);
    p.setRotation(degrees(rotation));
    p.setCropBox(20, 20, 360, 360);
    p.node.set(PDFName.of('UserUnit'), PDFNumber.of(2));
    p.node.set(PDFName.of('Resources'), doc.context.obj({ Font: { F: font.ref } }));
    p.node.set(
      PDFName.of('Contents'),
      doc.context.register(
        doc.context.flateStream(
          '1.25 0 0 1 0 0 cm BT /F 18 Tf 22 TL 40 320 Td (One two three) Tj T* (four five.) Tj 0 -100 Td (Neighbor) Tj ET',
        ),
      ),
    );
    await openPdf(page, doc);
    await page.getByRole('button', { name: 'Text', exact: true }).click();
    await page.getByLabel('Zoom', { exact: true }).selectOption('0.5');
    await expect(page.locator('.paper')).toHaveCSS('width', '360px');
    const label = 'One two three four five.';
    const target = page.getByRole('button', { name: `Edit text: ${label}`, exact: true });
    await target.click();
    const input = page.getByRole('textbox', { name: 'Edit text', exact: true });
    const width = page.getByLabel('Paragraph width in points', { exact: true });
    const resize = page.getByRole('button', { name: 'Resize paragraph width', exact: true });
    const initial = Number(await width.inputValue());
    await resize.press('Shift+ArrowRight');
    await expect.poll(async () => Number(await width.inputValue())).toBeCloseTo(initial + 10, 2);
    await resize.press('ArrowLeft');
    await expect.poll(async () => Number(await width.inputValue())).toBeCloseTo(initial + 9, 2);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(input).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
    await target.click();
    await width.fill('0');
    await clickAway(page);
    await expect(input).toBeVisible();
    expect(await width.evaluate((el) => el.validity.valid)).toBe(false);
    await width.fill('180');
    await width.press('Tab');
    await expect(input).toHaveCSS('width', '72px');
    const direction = await input.evaluate((el) => {
      const m = new DOMMatrix(el.style.transform),
        length = Math.hypot(m.a, m.b);
      return [m.a / length, m.b / length];
    });
    await resize.scrollIntoViewIfNeeded();
    let box = await resize.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      box.x + box.width / 2 + direction[0] * 15,
      box.y + box.height / 2 + direction[1] * 15,
      { steps: 4 },
    );
    await expect.poll(async () => Number(await width.inputValue())).toBeCloseTo(210, 2);
    await resize.press('Escape');
    await page.mouse.up();
    await expect(width).toHaveValue('180');
    await expect(input).toBeVisible();
    await resize.scrollIntoViewIfNeeded();
    box = await resize.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      box.x + box.width / 2 + direction[0] * 10,
      box.y + box.height / 2 + direction[1] * 10,
      { steps: 4 },
    );
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: box.x + box.width / 2 + direction[0] * 15,
      y: box.y + box.height / 2 + direction[1] * 15,
      button: 'left',
      clickCount: 1,
    });
    await expect(width).toHaveValue('210');
    const flow = await input.evaluate((el) => el.exportLayout());
    expect(flow.text.split('\n').length).toBeGreaterThan(2);
    const output = await exportedTextRuns(page);
    await expect(input).toHaveCount(0);
    const edited = output.runs.filter((r) => r.text !== 'Neighbor');
    expect(
      edited
        .map((r) => r.text)
        .join('')
        .replaceAll(' ', ''),
    ).toBe(label.replaceAll(' ', ''));
    edited.forEach((r) => expect(r.advance * 2.5).toBeLessThanOrEqual(211));
    expect(output.runs.at(-1).transform.slice(4)).toEqual([50, 198]);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(target).toBeVisible();
    await target.click();
    await width.fill('560');
    await width.press('Tab');
    expect((await input.evaluate((el) => el.exportLayout())).text).toBe(label);
    await clickAway(page);
    const single = await exportedTextRuns(page);
    expect(
      single.runs.filter((r) => r.text !== 'Neighbor').every((r) => r.transform[5] === 320),
    ).toBe(true);
    await target.click();
    await expect(width).toHaveValue('560');
    await expect(input).toHaveText(label);
    await clickAway(page);
    await page.getByRole('button', { name: 'Back to your PDFs', exact: true }).click();
    await openPdf(page, await PDFDocument.load(output.bytes));
    const reopened = await exportedTextRuns(page);
    expect(reopened.runs.map((r) => [r.text, r.transform])).toEqual(
      output.runs.map((r) => [r.text, r.transform]),
    );
    await page.getByRole('button', { name: 'Text', exact: true }).click();
    await target.click();
    await expect(width).toHaveValue('210');
    await expect(input).toHaveText(label);
    await clickAway(page);
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  });

test('paragraph width touch dragging ignores a second finger and restores a cancelled draft', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create(),
    p = doc.addPage([400, 400]);
  p.drawText('One two three\nfour five.', { x: 40, y: 300, size: 18, lineHeight: 22 });
  await openPdf(page, doc);
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  await page.getByLabel('Zoom', { exact: true }).selectOption('0.75');
  await page
    .getByRole('button', { name: 'Edit text: One two three four five.', exact: true })
    .click();
  const resize = page.getByRole('button', { name: 'Resize paragraph width', exact: true }),
    width = page.getByLabel('Paragraph width in points', { exact: true });
  const initial = Number(await width.inputValue()),
    box = await resize.boundingBox(),
    cdp = await page.context().newCDPSession(page);
  const first = { id: 1, x: box.x + box.width / 2, y: box.y + box.height / 2 },
    second = { id: 2, x: box.x + box.width + 10, y: box.y + box.height + 10 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [first] });
  first.x += 15;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [first] });
  await expect.poll(async () => Number(await width.inputValue())).toBeCloseTo(initial + 20, 2);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [first, second] });
  second.x += 20;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [first, second] });
  await expect.poll(async () => Number(await width.inputValue())).toBeCloseTo(initial + 20, 2);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
  await expect.poll(async () => Number(await width.inputValue())).toBeCloseTo(initial, 2);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await clickAway(page);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
});

test('cancelling paragraph width restores source text beyond a crop edge without creating history', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create(),
    p = doc.addPage([400, 400]);
  p.setCropBox(20, 20, 160, 360);
  p.drawText('One two three four five six\nand a shorter second line.', {
    x: 40,
    y: 320,
    size: 18,
    lineHeight: 22,
  });
  await openPdf(page, doc);
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  await page.getByLabel('Zoom', { exact: true }).selectOption('1');
  await page
    .getByRole('button', {
      name: 'Edit text: One two three four five six and a shorter second line.',
      exact: true,
    })
    .click();
  const input = page.getByRole('textbox', { name: 'Edit text', exact: true }),
    width = page.getByLabel('Paragraph width in points', { exact: true }),
    resize = page.getByRole('button', { name: 'Resize paragraph width', exact: true });
  const initial = await width.inputValue();
  expect(Number(initial)).toBeGreaterThan(160);
  await resize.click();
  await expect(width).toHaveValue(initial);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  expect(await width.evaluate((el) => el.validity.valid)).toBe(true);
  const box = await resize.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 20, box.y + box.height / 2, { steps: 3 });
  await expect(width).not.toHaveValue(initial);
  await resize.press('Escape');
  await page.mouse.up();
  await expect(width).toHaveValue(initial);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await clickAway(page);
  await expect(input).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  const output = await exportedTextRuns(page);
  expect(output.runs.map((r) => [r.text, r.transform[5]])).toEqual([
    ['One two three four five six', 320],
    ['and a shorter second line.', 298],
  ]);
});

test('saved paragraphs preserve typed breaks, long words, width and draft alignment through reopening', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create(),
    p = doc.addPage([700, 700]);
  p.drawText('One two three\nfour five.', { x: 40, y: 600, size: 18, lineHeight: 22 });
  await openPdf(page, doc);
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  await page.getByLabel('Zoom', { exact: true }).selectOption('0.5');
  await page
    .getByRole('button', { name: 'Edit text: One two three four five.', exact: true })
    .click();
  const input = page.getByRole('textbox', { name: 'Edit text', exact: true });
  const text = '\nStart\n\nABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUVWXYZ\n\nTail.\n';
  await input.press('ControlOrMeta+a');
  await pasteText(input, text);
  await page.getByLabel('Paragraph width in points', { exact: true }).fill('180');
  await page.getByLabel('Paragraph width in points', { exact: true }).press('Tab');
  await expect.poll(() => input.evaluate((el) => el.value)).toBe(text);
  await expect(page.locator('.text-draft-background')).toBeVisible();
  const paper = page.locator('.paper'),
    paperBox = await paper.boundingBox(),
    box = await input.boundingBox();
  const draft = await page.screenshot({
    clip: pixelClip(box),
    scale: 'css',
    style: '.text-edit-handles { visibility: hidden; }',
  });
  await clickAway(page);
  await expect(input).toHaveCount(0);
  await expect(page.locator('.text-target')).toHaveCount(1);
  await expect(page.locator('.text-target').first()).toBeEnabled();
  const current = await paper.boundingBox();
  const saved = await page.screenshot({
    clip: pixelClip({
      ...box,
      x: box.x + current.x - paperBox.x,
      y: box.y + current.y - paperBox.y,
    }),
    scale: 'css',
    style: '.text-edit-handles { visibility: hidden; }',
  });
  const expected = await coloredGlyphBounds(saved, 'black'),
    original = await coloredGlyphBounds(draft, 'black');
  for (const key of ['left', 'right', 'top', 'bottom'])
    expect(Math.abs(original[key] - expected[key]), `saved ${key}`).toBeLessThanOrEqual(1);
  const output = await exportedTextRuns(page);
  await page.getByRole('button', { name: 'Back to your PDFs', exact: true }).click();
  await openPdf(page, await PDFDocument.load(output.bytes));
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  await page.getByLabel('Zoom', { exact: true }).selectOption('0.5');
  await page.locator('.text-target').click();
  await expect(page.getByLabel('Paragraph width in points', { exact: true })).toHaveValue('180');
  await expect.poll(() => input.evaluate((el) => el.value)).toBe(text);
  await input.press('ArrowRight');
  await input.press('Tab');
  await expect(page.locator('.text-draft-background')).toBeVisible();
  const reopenedPaper = await paper.boundingBox();
  const reopened = await page.screenshot({
    clip: pixelClip({
      ...box,
      x: box.x + reopenedPaper.x - paperBox.x,
      y: box.y + reopenedPaper.y - paperBox.y,
    }),
    scale: 'css',
    style: '.text-edit-handles { visibility: hidden; }',
  });
  const actual = await coloredGlyphBounds(reopened, 'black');
  for (const key of ['left', 'right', 'top', 'bottom'])
    expect(Math.abs(actual[key] - expected[key]), `reopened ${key}`).toBeLessThanOrEqual(1);
  await clickAway(page);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await page.locator('.text-target').click();
  await input.press('ControlOrMeta+a');
  await input.press('ArrowRight');
  await page.keyboard.insertText('Again.');
  await expect.poll(() => input.evaluate((el) => el.value)).toBe(text + 'Again.');
  await clickAway(page);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.locator('.text-target').click();
  await expect.poll(() => input.evaluate((el) => el.value)).toBe(text);
});

test('Enter at the end of grouped text records one break and preserves native undo', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await fragmentedTextPdf());
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  const target = page.getByRole('button', { name: 'Edit text: Hello bold world', exact: true });
  await target.click();
  const input = page.getByRole('textbox', { name: 'Edit text', exact: true });
  await input.press('ControlOrMeta+a');
  await input.press('ArrowRight');
  await input.press('Enter');
  await expect.poll(() => input.evaluate((el) => el.value)).toBe('Hello bold world\n');
  // Check one edit's undo without depending on how the browser coalesces later typing.
  await input.press('ControlOrMeta+z');
  await expect.poll(() => input.evaluate((el) => el.value)).toBe('Hello bold world');
  await input.press('ControlOrMeta+Shift+z');
  await expect.poll(() => input.evaluate((el) => el.value)).toBe('Hello bold world\n');
  await input.press('Enter');
  await expect.poll(() => input.evaluate((el) => el.value)).toBe('Hello bold world\n\n');
  await input.press('Backspace');
  await input.press('Backspace');
  await expect.poll(() => input.evaluate((el) => el.value)).toBe('Hello bold world');
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await input.press('Shift+Enter');
  await page.keyboard.insertText('Next');
  await expect.poll(() => input.evaluate((el) => el.value)).toBe('Hello bold world\nNext');
  await clickAway(page);
  await expect(input).toHaveCount(0);
  const output = await exportedTextRuns(page);
  expect(output.runs.map((r) => r.text)).toEqual(['Hello ', 'bold', ' world', 'Next', 'Neighbor']);
  expect(output.runs[0].transform[5] - output.runs[3].transform[5]).toBeCloseTo(18 * 1.35, 1);
  expect(output.runs[1].fontName).toContain('Bold');
  expect(output.runs.at(-1).transform.slice(4)).toEqual([40, 230]);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(target).toBeEnabled();
});

test('Enter at the end of a paragraph adds one break, not two', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create(),
    p = doc.addPage([700, 700]);
  p.drawText('One two three\nfour five.', { x: 40, y: 600, size: 18, lineHeight: 22 });
  await openPdf(page, doc);
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  await page
    .getByRole('button', { name: 'Edit text: One two three four five.', exact: true })
    .click();
  const input = page.getByRole('textbox', { name: 'Edit text', exact: true });
  const original = 'One two three four five.';
  await expect.poll(() => input.evaluate((el) => el.value)).toBe(original);
  // Select explicitly: clicking an object places the caret at the pointer.
  await input.press('ControlOrMeta+a');
  await input.press('ArrowRight');
  // The browser keeps a spare newline for the caret's empty row; it is not a second break.
  await input.press('Enter');
  await expect.poll(() => input.evaluate((el) => el.value)).toBe(`${original}\n`);
  await input.press('Enter');
  await expect.poll(() => input.evaluate((el) => el.value)).toBe(`${original}\n\n`);
  await input.press('Backspace');
  await input.press('Backspace');
  await expect.poll(() => input.evaluate((el) => el.value)).toBe(original);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await input.press('Enter');
  await clickAway(page);
  await expect(input).toHaveCount(0);
  const output = await exportedTextRuns(page);
  await page.getByRole('button', { name: 'Back to your PDFs', exact: true }).click();
  await openPdf(page, await PDFDocument.load(output.bytes));
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  await page.locator('.text-target').click();
  await expect.poll(() => input.evaluate((el) => el.value)).toBe(`${original}\n`);
});

for (const content of ['kept', 'removed'])
  test(`saved paragraph blank lines keep their formatting when large text is ${content}`, async ({
    page,
  }) => {
    await mockPuter(page);
    await page.goto('/#library');
    const doc = await PDFDocument.create(),
      p = doc.addPage([700, 700]),
      regular = await doc.embedFont(StandardFonts.Helvetica),
      bold = await doc.embedFont(StandardFonts.HelveticaBold);
    p.node.set(PDFName.of('Resources'), doc.context.obj({ Font: { F: regular.ref, B: bold.ref } }));
    p.node.set(
      PDFName.of('Contents'),
      doc.context.register(
        doc.context.flateStream(
          'BT /F 18 Tf 22 TL 40 600 Td (One two ) Tj /B 30 Tf 0.8 0.1 0.2 rg (BIG) Tj /F 18 Tf 0 0 0 rg ( three) Tj T* (four five.) Tj ET',
        ),
      ),
    );
    await openPdf(page, doc);
    await page.getByRole('button', { name: 'Text', exact: true }).click();
    await page.getByLabel('Zoom', { exact: true }).selectOption('0.5');
    await page
      .getByRole('button', { name: 'Edit text: One two BIG three four five.', exact: true })
      .click();
    const input = page.getByRole('textbox', { name: 'Edit text', exact: true });
    await page.getByLabel('Paragraph width in points', { exact: true }).fill('340');
    await page.getByLabel('Paragraph width in points', { exact: true }).press('Tab');
    await input.evaluate((el) => {
      const range = document.createRange();
      range.setStart(el.querySelector('[data-part="1"]').firstChild, 0);
      range.collapse(true);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
    });
    await input.press('Enter');
    await input.press('Enter');
    if (content === 'removed') {
      for (let i = 0; i < 3; i++) await input.press('Shift+ArrowRight');
      await input.press('Backspace');
    }
    const text = await input.evaluate((el) => el.value);
    await input.press('Tab');
    await expect(page.locator('.text-draft-background')).toBeVisible();
    const paper = page.locator('.paper'),
      originalPaper = await paper.boundingBox(),
      box = await input.boundingBox();
    const original = await page.screenshot({
      clip: pixelClip(box),
      scale: 'css',
      style: '.text-edit-handles { visibility: hidden; }',
    });
    const output = await exportedTextRuns(page);
    await page.getByRole('button', { name: 'Back to your PDFs', exact: true }).click();
    await openPdf(page, await PDFDocument.load(output.bytes));
    await page.getByRole('button', { name: 'Text', exact: true }).click();
    await page.getByLabel('Zoom', { exact: true }).selectOption('0.5');
    await page.locator('.text-target').click();
    await expect.poll(() => input.evaluate((el) => el.value)).toBe(text);
    await input.press('ArrowRight');
    await input.press('Tab');
    await expect(page.locator('.text-draft-background')).toBeVisible();
    const current = await paper.boundingBox();
    const reopened = await page.screenshot({
      clip: pixelClip({
        ...box,
        x: box.x + current.x - originalPaper.x,
        y: box.y + current.y - originalPaper.y,
      }),
      scale: 'css',
      style: '.text-edit-handles { visibility: hidden; }',
    });
    for (const color of content === 'kept' ? ['black', 'red'] : ['black']) {
      const a = await coloredGlyphBounds(original, color),
        b = await coloredGlyphBounds(reopened, color);
      for (const key of ['left', 'right', 'top', 'bottom'])
        expect(Math.abs(a[key] - b[key]), `${content} ${color} ${key}`).toBeLessThanOrEqual(1);
    }
  });

test('paragraph wrapping retains pasted blank lines and breaks long words within its column', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create(),
    p = doc.addPage([400, 400]),
    font = await doc.embedFont(StandardFonts.Helvetica);
  p.drawText('This is a longer first line\nand a shorter second line.\nEnd.', {
    x: 40,
    y: 320,
    font,
    size: 18,
    lineHeight: 22,
  });
  await openPdf(page, doc);
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  await page.getByLabel('Zoom', { exact: true }).selectOption('0.75');
  await page
    .getByRole('button', {
      name: 'Edit text: This is a longer first line and a shorter second line. End.',
      exact: true,
    })
    .click();
  const input = page.getByRole('textbox', { name: 'Edit text', exact: true });
  const text =
    '\nFirst paragraph.\n\nABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUVWXYZ\n\nTail.\n';
  await input.press('ControlOrMeta+a');
  await pasteText(input, text);
  await expect.poll(() => input.evaluate((el) => el.value)).toBe(text);
  const flow = await input.evaluate((el) => el.exportLayout());
  expect(flow.text).toContain('First paragraph.\n\n');
  expect(flow.text).toContain('\n\nTail.\n');
  expect(flow.text.split('\n').length).toBeGreaterThan(text.split('\n').length);
  const columnWidth = await input.evaluate((el) => parseFloat(el.style.width) / 0.75);
  await clickAway(page);
  await expect(input).toHaveCount(0);
  const output = await exportedTextRuns(page);
  expect(output.runs.map((r) => r.text).join('')).toBe(text.replaceAll('\n', ''));
  for (const run of output.runs) expect(run.advance).toBeLessThanOrEqual(columnWidth + 1);
  const lines = flow.text.split('\n');
  const expected = lines
    .map((text, i) => (text ? [text, 320 - 18 * flow.lineOffsets[i]] : null))
    .filter(Boolean);
  expect(output.runs).toHaveLength(expected.length);
  output.runs.forEach((r, i) => {
    expect(r.text).toBe(expected[i][0]);
    expect(r.transform[5]).toBeCloseTo(expected[i][1], 5);
  });
});

for (const content of ['enter', 'paste', 'styles'])
  test(`mixed-format multiline ${content} keeps preview and saved glyphs aligned`, async ({
    page,
    browserName,
  }) => {
    await mockPuter(page);
    await page.goto('/#library');
    const doc = await PDFDocument.create(),
      p = doc.addPage([400, 400]);
    if (content === 'styles') p.setRotation(degrees(90));
    const label = content === 'styles' ? 'Hello BIG tail' : 'Hello BIG';
    const regular = await doc.embedFont(StandardFonts.Helvetica),
      bold = await doc.embedFont(StandardFonts.HelveticaBold);
    p.node.set(PDFName.of('Resources'), doc.context.obj({ Font: { F: regular.ref, B: bold.ref } }));
    p.node.set(
      PDFName.of('Contents'),
      doc.context.register(
        doc.context.flateStream(
          `0.2 0.6 0.7 rg 0 0 400 400 re f 0 0 0 rg BT /F 18 Tf 40 300 Td (Hello ) Tj /B 30 Tf 0.8 0.1 0.2 rg (BIG) Tj ${content === 'styles' ? '/F 18 Tf 0 0 0 rg ( tail) Tj' : ''} ET`,
        ),
      ),
    );
    await openPdf(page, doc);
    await page.getByRole('button', { name: 'Text', exact: true }).click();
    await page.getByLabel('Zoom', { exact: true }).selectOption('0.75');
    await expect(page.locator('.paper')).toHaveCSS('width', '300px');
    await page.getByRole('button', { name: `Edit text: ${label}`, exact: true }).click();
    const input = page.getByRole('textbox', { name: 'Edit text', exact: true });
    await input.evaluate((el) => {
      const r = document.createRange();
      r.setStart(el.querySelector('[data-part="1"]').firstChild, 0);
      r.collapse(true);
      getSelection().removeAllRanges();
      getSelection().addRange(r);
    });
    if (content === 'enter') {
      await input.press('Enter');
      await input.press('Enter');
    } else if (content === 'styles') {
      await input.press('Enter');
      await input.evaluate((el) => {
        const r = document.createRange();
        r.setStart(el.querySelector('[data-part="2"]').firstChild, 0);
        r.collapse(true);
        getSelection().removeAllRanges();
        getSelection().addRange(r);
      });
      await input.press('Enter');
    } else await pasteText(input, '\n\n');
    // WebKit preserves the space before a pasted block break as a nonbreaking space.
    const space = content === 'paste' && browserName === 'webkit' ? '\u00a0' : ' ';
    const expected = content === 'styles' ? 'Hello \nBIG\n tail' : `Hello${space}\n\nBIG`;
    await expect.poll(() => input.evaluate((el) => el.value)).toBe(expected);
    await input.press('ControlOrMeta+z');
    await expect.poll(() => input.evaluate((el) => el.value)).not.toBe(expected);
    await input.press('ControlOrMeta+Shift+z');
    await expect.poll(() => input.evaluate((el) => el.value)).toBe(expected);
    const layout = await input.evaluate((el) => el.measureLayout());
    await expect(page.locator('.text-draft-background')).toBeVisible();
    // Keep an interface outline visible so the pixel check must exclude editor controls.
    await page.getByRole('button', { name: `Edit text: ${label}`, exact: true }).focus();
    const paper = page.locator('.paper'),
      box = await input.boundingBox(),
      paperBox = await paper.boundingBox();
    const draft = await page.screenshot({
      clip: pixelClip(box),
      scale: 'css',
      style: '.text-edit-handles, .text-targets { visibility: hidden; }',
    });
    await clickAway(page);
    await expect(input).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Edit text: BIG', exact: true })).toBeEnabled();
    const current = await paper.boundingBox();
    const saved = await page.screenshot({
      clip: pixelClip({
        ...box,
        x: box.x + current.x - paperBox.x,
        y: box.y + current.y - paperBox.y,
      }),
      scale: 'css',
      style: '.text-edit-handles, .text-targets { visibility: hidden; }',
    });
    for (const color of ['black', 'red']) {
      const a = await coloredGlyphBounds(draft, color),
        b = await coloredGlyphBounds(saved, color);
      for (const key of ['left', 'right', 'top', 'bottom'])
        // Firefox paints rotated HTML and canvas glyphs up to two pixels apart even
        // at identical baselines. Check those PDF coordinates independently below.
        expect(Math.abs(a[key] - b[key]), `${content} ${color} ${key}`).toBeLessThanOrEqual(
          browserName === 'firefox' && content === 'styles' ? 2 : 1,
        );
    }
    const output = await exportedTextRuns(page);
    const rows = expected.split('\n').flatMap((text, row) => (text ? [row] : []));
    expect(output.runs).toHaveLength(rows.length);
    output.runs.forEach((run, index) => {
      expect(run.transform[4]).toBeCloseTo(40, 5);
      expect(run.transform[5]).toBeCloseTo(300 - 18 * layout.lineOffsets[rows[index]], 5);
    });
    const originalPositions = output.runs.map((r) => [r.text, r.transform, r.fillColor]);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(
      page.getByRole('button', { name: `Edit text: ${label}`, exact: true }),
    ).toBeEnabled();
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
    await expect(page.locator('.save-status')).toHaveText('Downloaded');
    await page.getByRole('button', { name: 'Back to your PDFs', exact: true }).click();
    await openPdf(page, await PDFDocument.load(output.bytes));
    const reopened = await exportedTextRuns(page);
    expect(reopened.runs.map((r) => [r.text, r.transform, r.fillColor])).toEqual(originalPositions);
  });

for (const rotation of [0, 90])
  test(`shape opacity survives transparent export, reopening, and history at ${rotation} degrees`, async ({
    page,
  }) => {
    await mockPuter(page);
    await page.goto('/#library');
    const doc = await PDFDocument.create(),
      p = doc.addPage([400, 400]);
    p.setRotation(degrees(rotation));
    p.setCropBox(20, 20, 360, 360);
    p.node.set(PDFName.of('UserUnit'), PDFNumber.of(2));
    p.node.set(
      PDFName.of('Contents'),
      doc.context.register(
        doc.context.flateStream('1 0 0 rg 0 0 1 RG 2 w 40 220 80 60 re B 240 220 80 60 re B'),
      ),
    );
    await openPdf(page, doc);
    await page.getByLabel('Zoom', { exact: true }).selectOption('0.5');
    const target = page.getByRole('button', { name: 'Select shape 1', exact: true }),
      fill = page.getByLabel('Shape fill opacity in percent', { exact: true }),
      stroke = page.getByLabel('Shape stroke opacity in percent', { exact: true });
    await target.focus();
    await target.press('Enter');
    const setOpacity = async (field, value) => {
      await field.fill(value);
      await field.press('Tab');
      await expect(field).toBeEnabled();
      await expect(field).toHaveValue(value);
    };
    await setOpacity(fill, '25.5');
    await expect(stroke).toHaveValue('100');
    await setOpacity(stroke, '0');
    await expect(fill).toHaveValue('25.5');
    await setOpacity(fill, '0');
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download', exact: true }).click();
    const saved = await PDFDocument.load(await readFile(await (await download).path())),
      paths = inspectPaths(saved, 0);
    expect(paths[0].state.alpha).toBe(0);
    expect(paths[0].state.strokeAlpha).toBe(0);
    expect(paths[0].editable).toBe(true);
    expect(paths[1].state.alpha).toBe(1);
    expect(paths[1].state.strokeAlpha).toBe(1);
    await page.getByRole('button', { name: 'Back to your PDFs', exact: true }).click();
    await openPdf(page, saved);
    await page.getByLabel('Zoom', { exact: true }).selectOption('0.5');
    await target.click();
    await expect(fill).toHaveValue('0');
    await expect(stroke).toHaveValue('0');
    await setOpacity(fill, '100');
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeEnabled();
    await target.focus();
    await target.press('Enter');
    await expect(fill).toHaveValue('0');
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await expect(target).toBeEnabled();
    await target.focus();
    await target.press('Enter');
    await expect(fill).toHaveValue('100');
    await expect(stroke).toHaveValue('0');
  });

for (const rotation of [0, 90, 180, 270])
  test(`object rotation follows screen angles on page rotation ${rotation} and preserves image center, export, and history`, async ({
    page,
  }) => {
    await mockPuter(page);
    await page.goto('/#library');
    const doc = await imagePdf({ rotation, userUnit: 2 });
    doc.getPage(0).setCropBox(20, 20, 360, 360);
    await openPdf(page, doc);
    await page.getByLabel('Zoom', { exact: true }).selectOption('0.5');
    const target = page.getByRole('button', { name: 'Select image 1', exact: true });
    await target.click();
    const angle = page.getByLabel('Image rotation in degrees', { exact: true }),
      right = page.getByRole('button', { name: 'Rotate image clockwise 90 degrees', exact: true }),
      move = page.getByRole('button', { name: 'Move selected image', exact: true });
    await expect(angle).toHaveValue(String(rotation));
    const before = await move.boundingBox();
    await right.click();
    await expect(right).toBeEnabled();
    await expect(right).toBeFocused();
    await expect(angle).toHaveValue(String((rotation + 90) % 360));
    const after = await move.boundingBox();
    expect(after.x + after.width / 2).toBeCloseTo(before.x + before.width / 2, 1);
    expect(after.y + after.height / 2).toBeCloseTo(before.y + before.height / 2, 1);
    expect(after.width).toBeCloseTo(before.height, 1);
    expect(after.height).toBeCloseTo(before.width, 1);
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download', exact: true }).click();
    const saved = await PDFDocument.load(await readFile(await (await download).path())),
      images = inspectImages(saved, 0);
    images[0].transform.forEach((n, i) => expect(n).toBeCloseTo([0, -80, 60, 0, 50, 290][i], 8));
    expect(images[1].transform).toEqual(inspectImages(doc, 0)[1].transform);
    await page.getByRole('button', { name: 'Back to your PDFs', exact: true }).click();
    await openPdf(page, saved);
    await page.getByLabel('Zoom', { exact: true }).selectOption('0.5');
    await target.click();
    await expect(angle).toHaveValue(String((rotation + 90) % 360));
    await angle.fill('37.5');
    await angle.press('Enter');
    await expect(angle).toBeEnabled();
    await expect(angle).toHaveValue('37.5');
    await expect(page.getByLabel('Image width in points', { exact: true })).toHaveValue('160');
    await expect(page.getByLabel('Image height in points', { exact: true })).toHaveValue('120');
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeEnabled();
    await target.click();
    await expect(angle).toHaveValue(String((rotation + 90) % 360));
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await target.click();
    await expect(angle).toHaveValue('37.5');
    if (rotation === 90) {
      const width = page.getByLabel('Image width in points', { exact: true });
      await width.fill('200');
      await width.press('Enter');
      await expect(width).toBeEnabled();
      await expect(width).toHaveValue('200');
      await expect(page.getByLabel('Image height in points', { exact: true })).toHaveValue('150');
      await expect(angle).toHaveValue('37.5');
      const resized = await move.boundingBox();
      await move.press('Shift+ArrowRight');
      const pending = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Download', exact: true }).click();
      const edited = inspectImages(
        await PDFDocument.load(await readFile(await (await pending).path())),
        0,
      )[0];
      expect(Math.hypot(...edited.transform.slice(0, 2)) * 2).toBeCloseTo(200, 6);
      expect(Math.hypot(...edited.transform.slice(2, 4)) * 2).toBeCloseTo(150, 6);
      expect(
        90 - (Math.atan2(edited.transform[1], edited.transform[0]) * 180) / Math.PI,
      ).toBeCloseTo(37.5, 6);
      const moved = await move.boundingBox();
      expect(moved.x - resized.x).toBeCloseTo(5, 1);
      expect(moved.y - resized.y).toBeCloseTo(0, 1);
    }
  });

test('shape and drawing rotation preserve native paint, angle, and neighboring geometry', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create(),
    p = doc.addPage([400, 400]);
  p.node.set(
    PDFName.of('Resources'),
    doc.context.obj({ ExtGState: { Paint: { ca: 0.4, CA: 0.7 } } }),
  );
  p.node.set(
    PDFName.of('Contents'),
    doc.context.register(
      doc.context.flateStream(
        '/Paint gs 1 0 0 rg 0 0 1 RG 2 w 40 220 80 60 re 55 235 50 30 re B* 1 j 240 220 m 280 280 l 320 220 l S',
      ),
    ),
  );
  await openPdf(page, doc);
  for (const kind of ['shape', 'drawing']) {
    const target = page.getByRole('button', { name: `Select ${kind} 1`, exact: true });
    await expect(target).toBeEnabled();
    await target.focus();
    await target.press('Enter');
    await page
      .getByRole('button', { name: `Rotate ${kind} counterclockwise 90 degrees`, exact: true })
      .click();
    const title = kind[0].toUpperCase() + kind.slice(1);
    await expect(page.getByLabel(`${title} rotation in degrees`, { exact: true })).toHaveValue(
      '270',
    );
    await expect(
      page.getByLabel(`${title} stroke opacity in percent`, { exact: true }),
    ).toHaveValue('70');
    await page.getByRole('button', { name: `Close ${kind} editor`, exact: true }).click();
  }
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const saved = await PDFDocument.load(await readFile(await (await download).path())),
    before = inspectPaths(doc, 0),
    after = inspectPaths(saved, 0);
  after.forEach((entry, i) => {
    expect(entry.source).toBe(before[i].source);
    expect(entry.state.width).toBe(2);
    expect(entry.state.alpha).toBe(0.4);
    expect(entry.state.strokeAlpha).toBe(0.7);
    expect(entry.fillRule).toBe(before[i].fillRule);
    expect(entry.ctm.slice(0, 4)).toEqual([0, 1, -1, 0]);
  });
  await page.getByRole('button', { name: 'Back to your PDFs', exact: true }).click();
  await openPdf(page, saved);
  const target = page.getByRole('button', { name: 'Select shape 1', exact: true });
  await expect(target).toBeEnabled();
  await target.focus();
  await target.press('Enter');
  await expect(page.getByLabel('Shape rotation in degrees', { exact: true })).toHaveValue('270');
});

test('rotation rejects invalid angles and clipped turns without history, then allows a fitting turn', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.load(await (await imagePdf()).save()),
    image = inspectImages(doc, 0)[0].object;
  doc
    .getPage(0)
    .node.set(
      PDFName.of('Resources'),
      doc.context.obj({ XObject: { Picture: doc.context.getObjectRef(image) } }),
    );
  doc
    .getPage(0)
    .node.set(
      PDFName.of('Contents'),
      doc.context.register(
        doc.context.flateStream('q 40 220 80 60 re W n 80 0 0 60 40 220 cm /Picture Do Q'),
      ),
    );
  await openPdf(page, doc);
  await page.getByRole('button', { name: 'Select image 1', exact: true }).click();
  const angle = page.getByLabel('Image rotation in degrees', { exact: true }),
    right = page.getByRole('button', { name: 'Rotate image clockwise 90 degrees', exact: true }),
    undo = page.getByRole('button', { name: 'Undo', exact: true });
  for (const value of ['361', '', '0.0000']) {
    await angle.fill(value);
    await angle.press('Enter');
    if (value !== '0.0000') {
      // Invalid input is now a protected draft. Discarding it must leave the
      // original PDF and its undo history untouched.
      await expect(angle).toHaveValue(value);
      await expect(undo).toBeEnabled();
      await angle.press('Escape');
      await expect(angle).toHaveValue('0');
    }
    await expect(undo).toBeDisabled();
    await expect(page.locator('.save-status')).toHaveText('Local file');
  }
  await right.click();
  await expect(page.locator('.image-error')).toHaveText(
    'Keep the image inside its original frame.',
  );
  await expect(right).toBeEnabled();
  await expect(right).toBeFocused();
  await expect(angle).toHaveValue('0');
  await expect(undo).toBeDisabled();
  await angle.fill('180');
  await angle.press('Enter');
  await expect(angle).toBeEnabled();
  await expect(angle).toHaveValue('180');
  await expect(page.locator('.image-error')).toBeHidden();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const saved = await PDFDocument.load(await readFile(await (await download).path()));
  inspectImages(saved, 0)[0].transform.forEach((n, i) =>
    expect(n).toBeCloseTo([-80, 0, 0, -60, 120, 280][i], 8),
  );
});

test('docked object controls leave every resize handle usable on a small rotated page', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create(),
    p = doc.addPage([400, 400]);
  p.setCropBox(20, 20, 360, 360);
  p.node.set(
    PDFName.of('Contents'),
    doc.context.register(
      doc.context.flateStream('1 0 0 rg 0 0 1 RG 2 w 40 220 80 60 re 55 235 50 30 re B*'),
    ),
  );
  await openPdf(page, doc);
  await page.getByLabel('Zoom', { exact: true }).selectOption('1');
  const target = page.getByRole('button', { name: 'Select shape 1', exact: true });
  await expect(target).toBeEnabled();
  await target.focus();
  await target.press('Enter');
  const angle = page.getByLabel('Shape rotation in degrees', { exact: true });
  await angle.fill('37.5');
  await angle.press('Enter');
  await expect(angle).toBeEnabled();
  const panel = await page.getByRole('group', { name: 'Edit shape', exact: true }).boundingBox();
  for (let i = 1; i <= 4; i++) {
    const handle = await page
      .getByRole('button', { name: `Resize shape, corner ${i}`, exact: true })
      .boundingBox();
    expect(
      Math.max(
        0,
        Math.min(panel.x + panel.width, handle.x + handle.width) - Math.max(panel.x, handle.x),
      ) *
        Math.max(
          0,
          Math.min(panel.y + panel.height, handle.y + handle.height) - Math.max(panel.y, handle.y),
        ),
    ).toBe(0);
  }
  await expect(page.getByRole('complementary', { name: 'Selection properties' })).toContainText(
    'Shape',
  );
  await expect(page.locator('.paper')).toHaveCSS('margin-bottom', '0px');
  await page.getByRole('button', { name: 'Close shape editor', exact: true }).click();
  await expect(page.locator('.paper')).toHaveCSS('margin-bottom', '0px');
});

function replacementImageFile(wide = false, type = 'png') {
  const canvas = createCanvas(wide ? 80 : 30, wide ? 20 : 60),
    ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgba(0,170,68,0.45)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#ff8800';
  ctx.fillRect(0, 0, 8, 12);
  return canvas.toBuffer(`image/${type}`);
}
async function chooseReplacementFile(page, buffer, name = 'replacement.png') {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Replace image', exact: true }).click();
  await (
    await chooser
  ).setFiles({ name, mimeType: name.endsWith('.jpeg') ? 'image/jpeg' : 'image/png', buffer });
}

for (const rotation of [0, 90, 180, 270])
  test(`image replacement fits its rotated frame and survives export, reopening, and history on page rotation ${rotation}`, async ({
    page,
  }) => {
    await mockPuter(page);
    await page.goto('/#library');
    const doc = await imagePdf({ rotation, userUnit: 2 });
    doc.getPage(0).setCropBox(20, 20, 360, 360);
    await openPdf(page, doc);
    await page.getByLabel('Zoom', { exact: true }).selectOption('0.5');
    const target = page.getByRole('button', { name: 'Select image 1', exact: true }),
      angle = page.getByLabel('Image rotation in degrees', { exact: true }),
      width = page.getByLabel('Image width in points', { exact: true }),
      height = page.getByLabel('Image height in points', { exact: true }),
      replace = page.getByRole('button', { name: 'Replace image', exact: true });
    await target.click();
    await angle.fill('37.5');
    await angle.press('Enter');
    await expect(angle).toBeEnabled();
    const before = await page
      .getByRole('button', { name: 'Move selected image', exact: true })
      .boundingBox();
    const type = rotation % 180 ? 'jpeg' : 'png';
    await chooseReplacementFile(page, replacementImageFile(false, type), `replacement.${type}`);
    await expect(width).toHaveValue('60');
    await expect(height).toHaveValue('120');
    await expect(replace).toBeEnabled();
    await expect(replace).toBeFocused();
    await expect(angle).toHaveValue('37.5');
    const after = await page
      .getByRole('button', { name: 'Move selected image', exact: true })
      .boundingBox();
    expect(after.x + after.width / 2).toBeCloseTo(before.x + before.width / 2, 1);
    expect(after.y + after.height / 2).toBeCloseTo(before.y + before.height / 2, 1);
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download', exact: true }).click();
    const saved = await PDFDocument.load(await readFile(await (await download).path())),
      images = inspectImages(saved, 0);
    const theta = ((rotation - 37.5) * Math.PI) / 180,
      c = Math.cos(theta),
      s = Math.sin(theta);
    images[0].transform.forEach((n, i) =>
      expect(n).toBeCloseTo(
        [30 * c, 30 * s, -60 * s, 60 * c, 80 - 15 * c + 30 * s, 250 - 15 * s - 30 * c][i],
        6,
      ),
    );
    expect(images[0].object.dict.lookup(PDFName.of('Width')).asNumber()).toBe(30);
    expect(images[0].object.dict.lookup(PDFName.of('Height')).asNumber()).toBe(60);
    expect(images[1].object.getContents()).toEqual(inspectImages(doc, 0)[1].object.getContents());
    expect(images[1].transform).toEqual(inspectImages(doc, 0)[1].transform);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeEnabled();
    await target.click();
    await expect(width).toHaveValue('160');
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await target.click();
    await expect(width).toHaveValue('60');
    await page.getByRole('button', { name: 'Back to your PDFs', exact: true }).click();
    await openPdf(page, saved);
    await page.getByLabel('Zoom', { exact: true }).selectOption('0.5');
    await target.click();
    await expect(width).toHaveValue('60');
    await expect(height).toHaveValue('120');
    await expect(angle).toHaveValue('37.5');
  });

test('cancelled and invalid image replacements keep the original and allow correction', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await imagePdf());
  await page.getByRole('button', { name: 'Select image 1', exact: true }).click();
  const replace = page.getByRole('button', { name: 'Replace image', exact: true }),
    undo = page.getByRole('button', { name: 'Undo', exact: true });
  const chooser = page.waitForEvent('filechooser');
  await replace.click();
  await (await chooser).setFiles([]);
  await expect(undo).toBeDisabled();
  await chooseReplacementFile(page, Buffer.from('Not an image'));
  await expect(page.locator('.image-error')).toHaveText('Choose a valid PNG or JPEG image.');
  await expect(replace).toBeFocused();
  await expect(undo).toBeDisabled();
  await expect(page.locator('.save-status')).toHaveText('Local file');
  await expect(page.getByLabel('Image width in points', { exact: true })).toHaveValue('80');
  await chooseReplacementFile(page, replacementImageFile());
  await expect(page.getByLabel('Image width in points', { exact: true })).toHaveValue('30');
  await expect(page.locator('.image-error')).toBeHidden();
  await expect(undo).toBeEnabled();
});

async function holdReplacementReads(page) {
  await page.evaluate(() => {
    const read = File.prototype.arrayBuffer;
    window.replacementReads = {};
    File.prototype.arrayBuffer = async function () {
      const bytes = await read.call(this);
      if (!this.name.startsWith('held-')) return bytes;
      return new Promise((resolve) => {
        window.replacementReads[this.name] = () => resolve(bytes);
      });
    };
  });
}
async function releaseReplacementRead(page, name) {
  await page.evaluate(async (name) => {
    window.replacementReads[name]();
    await new Promise(requestAnimationFrame);
  }, name);
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
}
for (const action of ['select another image', 'close the editor', 'switch tools'])
  test(`pending replacement cannot apply after ${action}`, async ({ page }) => {
    await mockPuter(page);
    await page.goto('/#library');
    await openPdf(page, await imagePdf());
    await page.getByRole('button', { name: 'Select image 1', exact: true }).click();
    await holdReplacementReads(page);
    await chooseReplacementFile(page, replacementImageFile(), 'held-first.png');
    await expect
      .poll(() => page.evaluate(() => !!window.replacementReads['held-first.png']))
      .toBe(true);
    if (action === 'select another image')
      await page.getByRole('button', { name: 'Select image 2', exact: true }).click();
    else if (action === 'close the editor')
      await page.getByRole('button', { name: 'Close image editor', exact: true }).click();
    else await page.getByRole('button', { name: 'Text', exact: true }).click();
    await releaseReplacementRead(page, 'held-first.png');
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
    await expect(page.locator('.save-status')).toHaveText('Local file');
    if (action === 'select another image')
      await expect(
        page.getByRole('button', { name: 'Select image 2', exact: true }),
      ).toHaveAttribute('aria-pressed', 'true');
    else await expect(page.locator('.image-controls')).toBeHidden();
  });

test('a newer replacement request supersedes an older file that finishes reading first', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await imagePdf());
  const target = page.getByRole('button', { name: 'Select image 1', exact: true });
  await target.click();
  await holdReplacementReads(page);
  await chooseReplacementFile(page, replacementImageFile(true), 'held-first.png');
  await chooseReplacementFile(page, replacementImageFile(), 'held-second.png');
  await expect.poll(() => page.evaluate(() => Object.keys(window.replacementReads).length)).toBe(2);
  await releaseReplacementRead(page, 'held-first.png');
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await expect(page.locator('.save-status')).toHaveText('Local file');
  await releaseReplacementRead(page, 'held-second.png');
  await expect(page.getByLabel('Image width in points', { exact: true })).toHaveValue('30');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeEnabled();
  await target.click();
  await expect(page.getByLabel('Image width in points', { exact: true })).toHaveValue('80');
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
});

async function holdImageNudges(page) {
  await page.evaluate(() => {
    const schedule = window.setTimeout.bind(window),
      cancel = window.clearTimeout.bind(window),
      nudges = new Map();
    window.setTimeout = (callback, delay, ...args) => {
      const id = schedule(callback, delay === 180 ? 60000 : delay, ...args);
      if (delay === 180) nudges.set(id, () => callback(...args));
      return id;
    };
    window.clearTimeout = (id) => {
      nudges.delete(id);
      cancel(id);
    };
    window.finishNudgeDelay = () => {
      for (const [id, callback] of [...nudges]) {
        nudges.delete(id);
        cancel(id);
        callback();
      }
    };
  });
}

test('replacement preserves a pending keyboard move while its file is being chosen', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await imagePdf());
  const target = page.getByRole('button', { name: 'Select image 1', exact: true });
  await target.click();
  await holdReplacementReads(page);
  await holdImageNudges(page);
  await page.getByRole('button', { name: 'Move selected image', exact: true }).press('ArrowRight');
  await chooseReplacementFile(page, replacementImageFile(), 'held-first.png');
  await expect
    .poll(() => page.evaluate(() => !!window.replacementReads['held-first.png']))
    .toBe(true);
  await page.evaluate(() => window.finishNudgeDelay());
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await releaseReplacementRead(page, 'held-first.png');
  await expect(page.getByLabel('Image width in points', { exact: true })).toHaveValue('30');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const image = inspectImages(
    await PDFDocument.load(await readFile(await (await download).path())),
    0,
  )[0];
  image.transform.forEach((n, i) => expect(n).toBeCloseTo([30, 0, 0, 60, 66, 220][i], 6));
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeEnabled();
  await target.click();
  await expect(page.getByLabel('Image width in points', { exact: true })).toHaveValue('80');
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
});

test('cancelling the replacement picker resumes the pending keyboard move', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await imagePdf());
  await page.getByRole('button', { name: 'Select image 1', exact: true }).click();
  await holdImageNudges(page);
  await page.getByRole('button', { name: 'Move selected image', exact: true }).press('ArrowRight');
  const pending = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Replace image', exact: true }).click();
  await (await pending).element().dispatchEvent('cancel');
  await page.evaluate(() => window.finishNudgeDelay());
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const image = inspectImages(
    await PDFDocument.load(await readFile(await (await download).path())),
    0,
  )[0];
  image.transform.forEach((n, i) => expect(n).toBeCloseTo([80, 0, 0, 60, 41, 220][i], 8));
});

test('an invalid replacement preserves a pending image move for correction', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await imagePdf());
  await page.getByRole('button', { name: 'Select image 1', exact: true }).click();
  await holdImageNudges(page);
  await page.getByRole('button', { name: 'Move selected image', exact: true }).press('ArrowRight');
  await chooseReplacementFile(page, Buffer.from('Not an image'));
  await expect(page.locator('.image-error')).toHaveText('Choose a valid PNG or JPEG image.');
  await chooseReplacementFile(page, replacementImageFile());
  await expect(page.getByLabel('Image width in points', { exact: true })).toHaveValue('30');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const image = inspectImages(
    await PDFDocument.load(await readFile(await (await download).path())),
    0,
  )[0];
  image.transform.forEach((n, i) => expect(n).toBeCloseTo([30, 0, 0, 60, 66, 220][i], 6));
});

test('opens into a blank PDF without an account and asks for the sign-in only to save', async ({
  page,
}) => {
  await mockPuter(page, { signedIn: false });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Rename Untitled.pdf' })).toBeVisible();
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await expect(page).toHaveTitle('Untitled.pdf · PDF Editor');
  await expect(page.locator('.save-status')).toHaveText('Local file');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const saveButton = page.getByRole('button', { name: 'Sign in to save', exact: true });
  await expect(saveButton).toBeVisible();
  await menu(page, 'Rotate clockwise');
  await expect(page.locator('.save-status')).toHaveText('Unsaved changes');
  // Local work needs no account.
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const exported = await PDFDocument.load(await readFile(await (await pending).path()));
  expect(exported.getPage(0).getRotation().angle).toBe(90);
  expect(await page.evaluate(() => window.lastSave ?? null)).toBeNull();
  // Saving to the cloud asks for the sign-in first, then writes.
  await menu(page, 'Rotate clockwise');
  await saveButton.click();
  await expect(page.locator('.save-status')).toHaveText('Saved to Puter');
  expect(await page.evaluate(() => window.lastSave.path)).toBe('PDF Editor/Untitled.pdf');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Signed in as test-user');
});

test('keeps the library at its own URL and behind the back arrow, without listing files while signed out', async ({
  page,
}) => {
  await mockPuter(page, { signedIn: false });
  await page.goto('/');
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await page.getByRole('button', { name: 'Back to your PDFs', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your PDFs, in your own cloud' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'A little less paperwork.' })).toHaveCount(0);
  await expect(page.locator('.account-label')).toHaveText('Local workspace');
  expect(await page.evaluate(() => location.hash)).toBe('#library');
  expect(await page.evaluate(() => window.readdirCalls ?? 0)).toBe(0);
  await page.reload();
  await expect(page.getByRole('button', { name: 'New blank PDF' })).toBeVisible();
  await expect(page.locator('.editor')).toHaveCount(0);
  await page.getByRole('button', { name: 'New blank PDF' }).click();
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  expect(await page.evaluate(() => location.hash)).toBe('');
});

test('leaving unsaved edits without an account offers to sign in and save', async ({ page }) => {
  await mockPuter(page, { signedIn: false });
  await page.goto('/');
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await menu(page, 'Rotate clockwise');
  await page.getByRole('button', { name: 'Back to your PDFs', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Save before leaving?', exact: true });
  await expect(dialog).toBeVisible();
  for (const name of ['Keep editing', 'Leave without saving', 'Sign in and save'])
    await expect(dialog.getByRole('button', { name, exact: true })).toBeVisible();
  // Downloading is not one of its answers, so the question says where to find it.
  await expect(dialog).toContainText('To download it instead, keep editing and choose Download.');
  await dialog.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.save-status')).toHaveText('Unsaved changes');
  expect(await page.evaluate(() => window.lastSave ?? null)).toBeNull();
  await page.getByRole('button', { name: 'Back to your PDFs', exact: true }).click();
  await dialog.getByRole('button', { name: 'Sign in and save', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your library starts here' })).toBeVisible();
  await expect(page.locator('.account-label')).toHaveText('test-user');
  expect(await page.evaluate(() => window.lastSave.path)).toBe('PDF Editor/Untitled.pdf');
});

test('a file launched from the Puter desktop replaces the landing document', async ({ page }) => {
  const doc = await PDFDocument.create();
  doc.addPage([300, 300]);
  doc.addPage([300, 300]);
  await mockPuter(page, { app: true, launch: Buffer.from(await doc.save()).toString('base64') });
  await page.goto('/');
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 2');
  await expect(page.getByRole('button', { name: 'Rename launch.pdf' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
  await expect(page.locator('.editor')).toHaveCount(1);
});
