import { test, expect } from '@playwright/test';
import {
  PDFDocument,
  rgb,
  pushGraphicsState,
  popGraphicsState,
  concatTransformationMatrix,
  drawObject,
} from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { inspectImages } from '../../src/core/image-edit.js';
import { inspectPaths } from '../../src/core/path-edit.js';

const PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=';

async function open(page, doc, name = 'objects.pdf') {
  await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('ControlOrMeta+o');
  await (
    await chooser
  ).setFiles({ name, mimeType: 'application/pdf', buffer: Buffer.from(await doc.save()) });
  await expect(page.locator('.page-caption')).toHaveText(`Page 1 of ${doc.getPageCount()}`);
}

async function download(page) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  return PDFDocument.load(await readFile(await (await pending).path()));
}

for (const kind of ['image', 'shape'])
  test(`arrow keys stop a ${kind} at the page edge instead of pushing it out of sight`, async ({
    page,
  }) => {
    const doc = await PDFDocument.create();
    const sheet = doc.addPage([400, 400]);
    if (kind === 'image')
      sheet.drawImage(await doc.embedPng(Buffer.from(PIXEL, 'base64')), {
        x: 40,
        y: 200,
        width: 80,
        height: 60,
      });
    else sheet.drawRectangle({ x: 40, y: 200, width: 80, height: 60, color: rgb(0, 0.5, 0) });
    await open(page, doc);
    await page.getByRole('button', { name: `Select ${kind} 1`, exact: true }).click();
    const move = page.getByRole('button', { name: `Move selected ${kind}`, exact: true });
    await expect(move).toBeFocused();
    for (let i = 0; i < 20; i++) await move.press('Shift+ArrowLeft');
    await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
    const paper = await page.locator('.paper').boundingBox(),
      frame = await move.boundingBox();
    // As with a drag, a strip of the object stays on the page to select it by.
    expect(frame.x + frame.width).toBeGreaterThan(paper.x + 15);
    const saved = await download(page);
    const [object] = kind === 'image' ? inspectImages(saved, 0) : inspectPaths(saved, 0);
    const right = object.transform[4] + object.transform[0];
    expect(right).toBeGreaterThan(5);
    expect(right).toBeLessThan(20);
    // An object already at the edge stays put rather than jumping when pushed further.
    await move.press('Shift+ArrowLeft');
    await page.waitForTimeout(400);
    expect((await move.boundingBox()).x).toBeCloseTo(frame.x, 0);
  });

test('undoing a picture move from the keyboard keeps the focus on the page', async ({ page }) => {
  const doc = await PDFDocument.create();
  doc.addPage([400, 400]).drawImage(await doc.embedPng(Buffer.from(PIXEL, 'base64')), {
    x: 40,
    y: 200,
    width: 80,
    height: 60,
  });
  await open(page, doc);
  await page.getByRole('button', { name: 'Select image 1', exact: true }).click();
  const move = page.getByRole('button', { name: 'Move selected image', exact: true });
  await move.press('Shift+ArrowRight');
  const undo = page.getByRole('button', { name: 'Undo', exact: true });
  // Let the nudge be saved as an edit; undone before then, it is only discarded.
  await page.waitForTimeout(400);
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await expect(move).toBeFocused();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(undo).toBeDisabled();
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await expect.poll(() => page.evaluate(() => document.activeElement !== document.body)).toBe(true);
  expect(await page.evaluate(() => !!document.activeElement.closest('.paper'))).toBe(true);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(undo).toBeEnabled();
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  expect(await page.evaluate(() => !!document.activeElement.closest('.paper'))).toBe(true);
});

test('a finger scrolls and zooms a scanned page, and moves a picture only once it is tapped', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'Needs a touch screen.');
  const doc = await PDFDocument.create(),
    scan = await doc.embedPng(Buffer.from(PIXEL, 'base64'));
  // A scan is one picture from edge to edge of every page.
  for (let i = 0; i < 3; i++)
    doc.addPage([612, 792]).drawImage(scan, { x: 0, y: 0, width: 612, height: 792 });
  await open(page, doc);
  const workspace = page.locator('.workspace'),
    undo = page.getByRole('button', { name: 'Undo', exact: true }),
    cdp = await page.context().newCDPSession(page);
  const touch = (type, touchPoints) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints });
  const area = await workspace.boundingBox(),
    x = area.x + area.width / 2,
    y = area.y + area.height * 0.7;
  const before = await workspace.evaluate((node) => node.scrollTop);
  await touch('touchStart', [{ id: 1, x, y }]);
  for (let i = 1; i <= 8; i++) await touch('touchMove', [{ id: 1, x, y: y - i * 25 }]);
  await touch('touchEnd', []);
  await expect.poll(() => workspace.evaluate((node) => node.scrollTop)).toBeGreaterThan(before);
  await expect(page.getByRole('button', { name: 'Move selected image', exact: true })).toHaveCount(
    0,
  );
  await expect(undo).toBeDisabled();
  // Two fingers zoom the page, also where they rest on the picture.
  const zoom = page.getByLabel('Zoom', { exact: true });
  const zoomBefore = await zoom.inputValue();
  await touch('touchStart', [
    { id: 1, x: x - 30, y },
    { id: 2, x: x + 30, y },
  ]);
  for (let i = 1; i <= 5; i++)
    await touch('touchMove', [
      { id: 1, x: x - 30 - i * 12, y },
      { id: 2, x: x + 30 + i * 12, y },
    ]);
  await touch('touchEnd', []);
  await expect.poll(() => zoom.inputValue()).not.toBe(zoomBefore);
  await expect(undo).toBeDisabled();
  // A tap selects the picture, and a finger then moves it.
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  const view = await workspace.boundingBox(),
    at = { id: 1, x: view.x + view.width / 2, y: view.y + view.height / 3 };
  await touch('touchStart', [at]);
  await touch('touchEnd', []);
  const move = page.getByRole('button', { name: 'Move selected image', exact: true });
  await expect(move).toBeVisible();
  const frame = await move.boundingBox();
  await touch('touchStart', [at]);
  for (let i = 1; i <= 4; i++) await touch('touchMove', [{ ...at, x: at.x + i * 5 }]);
  await touch('touchEnd', []);
  await expect(undo).toBeEnabled();
  await expect.poll(async () => (await move.boundingBox())?.x ?? 0).toBeGreaterThan(frame.x + 10);
});

test('arrow keys on a corner handle resize the picture from that corner', async ({ page }) => {
  const doc = await PDFDocument.create();
  doc.addPage([400, 400]).drawImage(await doc.embedPng(Buffer.from(PIXEL, 'base64')), {
    x: 40,
    y: 200,
    width: 80,
    height: 60,
  });
  await open(page, doc);
  await page.getByRole('button', { name: 'Select image 1', exact: true }).click();
  await page.getByLabel('Keep image proportions').uncheck();
  const corner = page.getByRole('button', { name: 'Resize image, corner 2', exact: true });
  await corner.focus();
  await corner.press('Shift+ArrowRight');
  await corner.press('Shift+ArrowRight');
  const width = page.getByLabel('Image width in points', { exact: true });
  await expect(width).toHaveValue('100');
  // The resize is saved as one edit, and the handle keeps the focus for the next key.
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await expect(corner).toBeFocused();
  await corner.press('Shift+ArrowUp');
  await expect(page.getByLabel('Image height in points', { exact: true })).toHaveValue('70');
  await page.waitForTimeout(400);
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  const [image] = inspectImages(await download(page), 0);
  // The opposite corner stays where it was.
  expect(image.transform.map((n) => Number(n.toFixed(3)))).toEqual([100, 0, 0, 70, 40, 200]);
});

test('a stroke width shows rounded, and stays exact until it is edited', async ({ page }) => {
  const doc = await PDFDocument.create();
  const sheet = doc.addPage([400, 400]);
  sheet.drawRectangle({ x: 40, y: 200, width: 80, height: 60, borderWidth: 0.7089 });
  sheet.drawRectangle({ x: 200, y: 200, width: 80, height: 60, borderWidth: 0.004 });
  await open(page, doc);
  await page.getByRole('button', { name: 'Select shape 1', exact: true }).press('Enter');
  const width = page.getByLabel('Shape stroke width in points', { exact: true });
  await expect(width).toHaveValue('0.71');
  // Another change to the shape keeps its exact width.
  await page.getByRole('button', { name: 'Move selected shape', exact: true }).press('ArrowRight');
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await expect(width).toHaveValue('0.71');
  // A hairline-thin width does not read as zero, which would mean a hairline.
  await page.getByRole('button', { name: 'Select shape 2', exact: true }).press('Enter');
  await expect(width).toHaveValue('0.004');
  const [first] = inspectPaths(await download(page), 0);
  expect(first.state.width).toBeCloseTo(0.7089, 6);
});

test('a mirrored picture reads its angle as upright and turns to a typed angle', async ({
  page,
}) => {
  const doc = await PDFDocument.create();
  const sheet = doc.addPage([400, 400]);
  const image = await doc.embedPng(Buffer.from(PIXEL, 'base64'));
  // Flipped left to right, as some apps place a mirrored picture.
  const name = sheet.node.newXObject('Mirror', image.ref);
  sheet.pushOperators(
    pushGraphicsState(),
    concatTransformationMatrix(-80, 0, 0, 60, 120, 200),
    drawObject(name),
    popGraphicsState(),
  );
  await open(page, doc);
  await page.getByRole('button', { name: 'Select image 1', exact: true }).press('Enter');
  const angle = page.getByLabel('Image rotation in degrees', { exact: true });
  await expect(angle).toHaveValue('0');
  await angle.fill('90');
  await angle.press('Enter');
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await expect(angle).toHaveValue('90');
  const [turned] = inspectImages(await download(page), 0);
  // A quarter turn clockwise about its center, still mirrored.
  expect(turned.transform.map((n) => Number(n.toFixed(3)))).toEqual([0, 80, 60, 0, 50, 190]);
});

// With Keep proportions on, an arrow key on a corner handle moved the corner along the object's
// diagonal: on a long, low banner, Shift+Up added 0.06 pt to its height, and seemed to do nothing.
test('an arrow key on a corner handle sizes a long picture by the side it moves', async ({
  page,
}) => {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]).drawImage(await doc.embedPng(Buffer.from(PIXEL, 'base64')), {
    x: 100,
    y: 400,
    width: 400,
    height: 30,
  });
  await open(page, doc);
  await page.getByRole('button', { name: 'Select image 1', exact: true }).click();
  const width = page.getByLabel('Image width in points', { exact: true }),
    height = page.getByLabel('Image height in points', { exact: true });
  await expect(page.getByLabel('Keep image proportions', { exact: true })).toBeChecked();
  // The top right corner, up by 10 pt: the picture is 10 pt taller, and as much wider in
  // proportion.
  await page
    .getByRole('button', { name: 'Resize image, corner 2', exact: true })
    .press('Shift+ArrowUp');
  await expect(height).toHaveValue('40');
  await expect(width).toHaveValue('533.33');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  // To the right by 10 pt: 10 pt wider.
  await page
    .getByRole('button', { name: 'Resize image, corner 2', exact: true })
    .press('Shift+ArrowRight');
  await expect(width).toHaveValue('543.33');
});
