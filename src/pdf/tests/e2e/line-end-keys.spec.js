import { test, expect } from '@playwright/test';
import { PDFDocument, degrees } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { addShapeAnnotation, listAnnotations } from '../../src/core/annotations.js';

const settled = (page) => expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');

async function open(page, rotation = 0) {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]).setRotation(degrees(rotation));
  addShapeAnnotation(doc, 0, {
    kind: 'arrow',
    points: [
      { x: 100, y: 500 },
      { x: 200, y: 500 },
    ],
    text: 'Look',
  });
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'arrow.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await settled(page);
  await page.getByRole('button', { name: 'Arrow: Look' }).focus();
  return page.getByRole('complementary', { name: 'Selection properties' });
}
async function saved(page) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  return listAnnotations(await PDFDocument.load(await readFile(await (await pending).path())), 0);
}

// A line's or arrow's ends could be moved only by dragging them, which a keyboard, or anyone
// who cannot drag, has no way to do. Its settings give its length and angle; the start stays.
test('an arrow’s end is moved from the keyboard by its length and angle', async ({ page }) => {
  const props = await open(page);
  const length = props.getByLabel('Arrow length in points');
  const angle = props.getByLabel('Arrow angle in degrees');
  await expect(length).toHaveValue('100');
  await expect(angle).toHaveValue('0');
  await length.fill('150');
  await length.press('Tab');
  await settled(page);
  await expect(angle).toBeFocused();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('90');
  await page.keyboard.press('Enter');
  await settled(page);
  await expect(length).toHaveValue('150');
  const [arrow] = await saved(page);
  expect(arrow.points[0].x).toBeCloseTo(100, 1);
  expect(arrow.points[0].y).toBeCloseTo(500, 1);
  // Straight up the page from its start, as the page is read.
  expect(arrow.points[1].x).toBeCloseTo(100, 1);
  expect(arrow.points[1].y).toBeCloseTo(650, 1);
  expect(arrow.lineEndings).toEqual(['None', 'OpenArrow']);
});

test('on a turned page the angle is as the page is shown', async ({ page }) => {
  const props = await open(page, 90);
  const angle = props.getByLabel('Arrow angle in degrees');
  // Turned a quarter clockwise, a line running right on the page runs down the screen.
  await expect(angle).toHaveValue('270');
  await angle.fill('0');
  await angle.press('Enter');
  await settled(page);
  const [arrow] = await saved(page);
  // Running right on the screen is running up the unturned page.
  expect(arrow.points[1].x).toBeCloseTo(100, 1);
  expect(arrow.points[1].y).toBeCloseTo(600, 1);
});
