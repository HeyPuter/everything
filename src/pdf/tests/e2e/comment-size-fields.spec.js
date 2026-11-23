import { test, expect } from '@playwright/test';
import { PDFDocument, degrees } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { addCallout, addShapeAnnotation, listAnnotations } from '../../src/core/annotations.js';

const settled = (page) => expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');

async function open(page, doc) {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'comment-size.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await settled(page);
}
async function saved(page) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  return listAnnotations(await PDFDocument.load(await readFile(await (await pending).path())), 0);
}
const near = (actual, expected) =>
  Object.entries(expected).forEach(([key, value]) => expect(actual[key]).toBeCloseTo(value, 1));

// Comments could be resized only by dragging a corner: a keyboard, or anyone who cannot drag,
// had no way to. The chosen comment's settings give its width and height in points.
test('a comment is resized from the keyboard by its width and height', async ({ page }) => {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  addShapeAnnotation(doc, 0, {
    kind: 'square',
    rect: { x: 100, y: 500, width: 120, height: 60 },
    text: 'Box',
  });
  await open(page, doc);
  await page.getByRole('button', { name: 'Rectangle: Box' }).focus();
  const props = page.getByRole('complementary', { name: 'Selection properties' });
  const width = props.getByLabel('Rectangle width in points');
  const height = props.getByLabel('Rectangle height in points');
  await expect(width).toHaveValue('120');
  await expect(height).toHaveValue('60');
  await width.fill('200');
  await width.press('Tab');
  await settled(page);
  // The keyboard goes on to the height, redrawn with the comment.
  await expect(height).toBeFocused();
  await expect(width).toHaveValue('200');
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('90');
  await page.keyboard.press('Enter');
  await settled(page);
  const [box] = await saved(page);
  // The top left corner stays where it was.
  near(box.rect, { x: 100, width: 200, height: 90 });
  expect(box.rect.y + box.rect.height).toBeCloseTo(560, 1);
});

test('on a turned page the width is as the page is shown, and a callout keeps its point', async ({
  page,
}) => {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]).setRotation(degrees(90));
  await addCallout(doc, 0, {
    rect: { x: 300, y: 300, width: 150, height: 40 },
    anchor: { x: 150, y: 200 },
    text: 'Pointed',
  });
  const [before] = listAnnotations(doc, 0);
  await open(page, doc);
  await page.getByRole('button', { name: 'Callout: Pointed' }).focus();
  const props = page.getByRole('complementary', { name: 'Selection properties' });
  // Turned a quarter, the box's height on the page is its width on the screen.
  const width = props.getByLabel('Callout width in points');
  await expect(width).toHaveValue(String(before.box.height));
  await expect(props.getByLabel('Callout height in points')).toHaveValue(String(before.box.width));
  await width.fill('80');
  await width.press('Enter');
  await settled(page);
  const [after] = await saved(page);
  near(after.box, { height: 80, width: before.box.width });
  near(after.points[0], before.points[0]);
});

// A typed size could take a comment far off the page, where it could not be seen or reached.
// As a dragged corner stops at the page's edge, the size stops there too, as the page is shown.
for (const rotation of [0, 90])
  test(`a typed size keeps a comment on the page (turned ${rotation})`, async ({ page }) => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]).setRotation(degrees(rotation));
    addShapeAnnotation(doc, 0, {
      kind: 'square',
      rect: { x: 100, y: 500, width: 120, height: 60 },
      text: 'Box',
    });
    await open(page, doc);
    await page.getByRole('button', { name: 'Rectangle: Box' }).focus();
    const props = page.getByRole('complementary', { name: 'Selection properties' });
    const width = props.getByLabel('Rectangle width in points');
    await width.fill('5000');
    await width.press('Enter');
    await settled(page);
    // Upright, the box runs right to the page's edge; turned a quarter, the width on the
    // screen runs up the page, to its top.
    const room = rotation ? 792 - 500 : 612 - 100;
    await expect(width).toHaveValue(String(room));
    const [box] = await saved(page);
    if (rotation) near(box.rect, { x: 100, width: 120, y: 500, height: room });
    else near(box.rect, { x: 100, width: room, height: 60 });
  });
