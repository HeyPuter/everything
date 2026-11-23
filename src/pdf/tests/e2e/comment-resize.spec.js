import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { addCallout, addShapeAnnotation, listAnnotations } from '../../src/core/annotations.js';

const settled = (page) => expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');

/** A press on (x, y) moved by (dx, dy) and let go, by mouse or, on a phone, by a finger. */
async function drag(page, isMobile, { x, y }, dx, dy) {
  if (!isMobile) {
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx, y + dy, { steps: 6 });
    await page.mouse.up();
    return;
  }
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let i = 1; i <= 6; i++)
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: x + (dx * i) / 6, y: y + (dy * i) / 6 }],
    });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}
const center = (box) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
async function saved(page) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  return listAnnotations(await PDFDocument.load(await readFile(await (await pending).path())), 0);
}

// A shape or text box drawn the wrong size could only be deleted and drawn again. The chosen
// comment has corner handles: dragging one resizes it, the opposite corner staying put, and a
// callout's text box is resized with its point left where it points.
test('a chosen comment is resized by dragging a corner', async ({ page, isMobile }) => {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  addShapeAnnotation(doc, 0, {
    kind: 'square',
    rect: { x: 100, y: 500, width: 120, height: 60 },
    text: 'Box',
  });
  await addCallout(doc, 0, {
    rect: { x: 300, y: 300, width: 150, height: 40 },
    anchor: { x: 150, y: 200 },
    text: 'Pointed',
  });
  const [square, callout] = listAnnotations(doc, 0);
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'comment-resize.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await settled(page);
  const sheet = await page.locator('.drawing-overlay').boundingBox();
  const unit = sheet.width / 612;

  const box = page.getByRole('button', { name: 'Rectangle: Box', exact: true });
  if (isMobile) await box.tap();
  else await box.click();
  const handles = box.locator('.annotation-handle');
  await expect(handles).toHaveCount(4);
  // Escape while a corner is dragged puts the comment back as it was.
  const corner = center(await handles.nth(2).boundingBox());
  if (!isMobile) {
    await page.mouse.move(corner.x, corner.y);
    await page.mouse.down();
    await page.mouse.move(corner.x + 40, corner.y + 40, { steps: 4 });
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await settled(page);
    expect((await box.boundingBox()).width).toBeCloseTo(120 * unit, 0);
  }
  await drag(page, isMobile, corner, 60 * unit, 30 * unit);
  await settled(page);
  let [resized] = await saved(page);
  // The top left corner stays; the bottom right one went right and down.
  expect(resized.box.x).toBeCloseTo(square.box.x, 0);
  expect(resized.box.y + resized.box.height).toBeCloseTo(square.box.y + square.box.height, 0);
  expect(resized.box.width).toBeCloseTo(square.box.width + 60, -1);
  expect(resized.box.height).toBeCloseTo(square.box.height + 30, -1);
  await expect(handles).toHaveCount(4);
  // One Undo puts it back.
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await settled(page);
  [resized] = await saved(page);
  expect(resized.box.width).toBeCloseTo(square.box.width, 1);

  const pointer = page.getByRole('button', { name: 'Callout: Pointed', exact: true });
  await pointer.focus();
  const calloutHandles = pointer.locator('.annotation-handle:not(.is-point)');
  await expect(calloutHandles).toHaveCount(4);
  await drag(page, isMobile, center(await calloutHandles.nth(1).boundingBox()), 50 * unit, 0);
  await settled(page);
  const [, widened] = await saved(page);
  expect(widened.box.x).toBeCloseTo(callout.box.x, 0);
  expect(widened.box.width).toBeCloseTo(callout.box.width + 50, -1);
  expect(widened.points[0].x).toBeCloseTo(callout.points[0].x, 3);
  expect(widened.points[0].y).toBeCloseTo(callout.points[0].y, 3);
});

// A line or arrow drawn to the wrong place, or a callout pointing at the wrong words, could
// only be moved whole. The ends of a line and the point of a callout can be dragged alone.
test('the end of an arrow and the point of a callout are dragged alone', async ({
  page,
  isMobile,
}) => {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  addShapeAnnotation(doc, 0, {
    kind: 'arrow',
    points: [
      { x: 100, y: 500 },
      { x: 250, y: 550 },
    ],
    text: 'Aim',
  });
  await addCallout(doc, 0, {
    rect: { x: 300, y: 300, width: 150, height: 40 },
    anchor: { x: 150, y: 200 },
    text: 'Pointed',
  });
  const [, callout] = listAnnotations(doc, 0);
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'comment-points.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await settled(page);
  const sheet = await page.locator('.drawing-overlay').boundingBox();
  const unit = sheet.width / 612;

  const arrow = page.getByRole('button', { name: 'Arrow: Aim', exact: true });
  await arrow.focus();
  const ends = arrow.locator('.annotation-handle.is-point');
  await expect(ends).toHaveCount(2);
  // The arrow's tip goes 50 points right and 100 down; its tail stays.
  await drag(page, isMobile, center(await ends.nth(1).boundingBox()), 50 * unit, 100 * unit);
  await settled(page);
  let [aimed, pointed] = await saved(page);
  expect(aimed.points[0].x).toBeCloseTo(100, 3);
  expect(aimed.points[0].y).toBeCloseTo(500, 3);
  expect(aimed.points[1].x).toBeCloseTo(300, -1);
  expect(aimed.points[1].y).toBeCloseTo(450, -1);
  expect(aimed.lineEndings).toEqual(['None', 'OpenArrow']);

  const label = page.getByRole('button', { name: 'Callout: Pointed', exact: true });
  await label.focus();
  const point = label.locator('.annotation-handle.is-point');
  await expect(point).toHaveCount(1);
  await drag(page, isMobile, center(await point.boundingBox()), -50 * unit, 0);
  await settled(page);
  [aimed, pointed] = await saved(page);
  // Its point moved; its text box stayed where it was.
  expect(pointed.points[0].x).toBeCloseTo(100, -1);
  expect(pointed.points[0].y).toBeCloseTo(200, -1);
  expect(pointed.box.x).toBeCloseTo(callout.box.x, 3);
  expect(pointed.box.y).toBeCloseTo(callout.box.y, 3);
});
