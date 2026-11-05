import { test, expect } from '@playwright/test';
import { PDFDocument, degrees } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { addShapeAnnotation, listAnnotations } from '../../src/core/annotations.js';

const settled = (page) => expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');

test.skip(({ isMobile }) => isMobile, 'desktop workspace');

async function open(page, doc) {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'drag-bounds.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await settled(page);
  await page.getByRole('button', { name: 'Select', exact: true }).click();
}
async function saved(page) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  return listAnnotations(await PDFDocument.load(await readFile(await (await pending).path())), 0);
}

// A comment dragged or nudged past the page's edge was saved there, off the page, where it
// could no longer be seen or picked up again; notes and form fields already stopped at the edge.
test('a comment dragged past the page edge stops at the edge', async ({ page }) => {
  const doc = await PDFDocument.create();
  doc.addPage([400, 400]);
  addShapeAnnotation(doc, 0, { kind: 'square', rect: { x: 100, y: 100, width: 80, height: 60 } });
  await open(page, doc);
  const target = page.getByRole('button', { name: 'Rectangle', exact: true });
  const box = await target.boundingBox();
  await page.mouse.move(box.x + 10, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + 2000, box.y + 2000, { steps: 8 });
  await page.mouse.up();
  await settled(page);
  const [moved] = await saved(page);
  // Against the bottom right corner of the page, whole.
  expect(moved.rect.x).toBeCloseTo(320, 0);
  expect(moved.rect.y).toBeCloseTo(0, 0);
  expect(moved.rect.width).toBeCloseTo(80, 3);
});

test('arrow keys stop a comment at the edge of a turned page', async ({ page }) => {
  const doc = await PDFDocument.create();
  doc.addPage([400, 300]).setRotation(degrees(90));
  addShapeAnnotation(doc, 0, { kind: 'square', rect: { x: 100, y: 100, width: 80, height: 60 } });
  await open(page, doc);
  const target = page.getByRole('button', { name: 'Rectangle', exact: true });
  await target.click();
  await expect(target).toBeFocused();
  // Far more than the page is wide, to the right as the page is shown.
  for (let i = 0; i < 40; i++) await page.keyboard.press('Shift+ArrowRight');
  await expect.poll(async () => (await saved(page))[0].rect.y, { timeout: 10000 }).not.toBe(100);
  await settled(page);
  const [moved] = await saved(page);
  // Turned a quarter clockwise, the page's right is the top of its user space.
  expect(moved.rect.y + moved.rect.height).toBeCloseTo(300, 0);
  expect(moved.rect.x).toBeCloseTo(100, 3);
});

// Escape mid-drag let the drag go on: releasing the pointer still moved the comment.
test('Escape during a drag puts the comment back and keeps it selected', async ({ page }) => {
  const doc = await PDFDocument.create();
  doc.addPage([400, 400]);
  addShapeAnnotation(doc, 0, { kind: 'square', rect: { x: 100, y: 100, width: 80, height: 60 } });
  await open(page, doc);
  const target = page.getByRole('button', { name: 'Rectangle', exact: true });
  const box = await target.boundingBox();
  await page.mouse.move(box.x + 10, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + 60, box.y + 40, { steps: 5 });
  await page.keyboard.press('Escape');
  await expect(target).toHaveAttribute('style', expect.not.stringContaining('translate'));
  await page.mouse.move(box.x + 90, box.y + 60, { steps: 3 });
  await page.mouse.up();
  await settled(page);
  await expect(target).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Undo', exact: true }).first()).toBeDisabled();
  const [kept] = await saved(page);
  expect(kept.rect).toEqual({ x: 100, y: 100, width: 80, height: 60 });
});

// A zoom in the middle of a drag redrew the comments, and the drag left behind went on with
// whichever comment the pointer passed next: it slid away under the pointer.
test('a drag cut short by a zoom leaves the comments where they are', async ({ page }) => {
  const doc = await PDFDocument.create();
  doc.addPage([400, 400]);
  addShapeAnnotation(doc, 0, { kind: 'square', rect: { x: 100, y: 100, width: 80, height: 60 } });
  addShapeAnnotation(doc, 0, { kind: 'circle', rect: { x: 250, y: 250, width: 80, height: 60 } });
  await open(page, doc);
  const square = page.getByRole('button', { name: 'Rectangle', exact: true });
  let box = await square.boundingBox();
  await page.mouse.move(box.x + 10, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + 40, box.y + 30, { steps: 4 });
  const before = box.width;
  await page.keyboard.press('Control+Equal');
  await settled(page);
  // The comment is drawn afresh at the new zoom, so it has no box for a moment.
  await expect
    .poll(async () => (await square.boundingBox())?.width ?? 0)
    .toBeGreaterThan(before + 1);
  await page.mouse.up();
  await settled(page);
  const oval = page.getByRole('button', { name: 'Ellipse', exact: true });
  box = await oval.boundingBox();
  await page.mouse.move(box.x + 10, box.y + 10, { steps: 3 });
  await page.mouse.move(box.x + 30, box.y + 20, { steps: 3 });
  await expect(oval).toHaveAttribute('style', expect.not.stringContaining('translate'));
  await expect(page.getByRole('button', { name: 'Undo', exact: true }).first()).toBeDisabled();
  const kept = await saved(page);
  expect(kept.map(({ rect }) => rect)).toEqual([
    { x: 100, y: 100, width: 80, height: 60 },
    { x: 250, y: 250, width: 80, height: 60 },
  ]);
});
