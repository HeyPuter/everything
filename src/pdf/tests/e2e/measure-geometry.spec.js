import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import {
  addShapeAnnotation,
  addTextBox,
  groupAnnotation,
  listAnnotations,
} from '../../src/core/annotations.js';

/** A page with a 2 in distance and a 4 sq in area, each labelled as the Measure tool does. */
async function measured() {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  const measure = async (kind, points, label, at) => {
    const shape = addShapeAnnotation(doc, 0, { kind, points, text: label, width: 1 });
    const caption = await addTextBox(doc, 0, {
      rect: { x: at.x, y: at.y, width: 60, height: 14 },
      text: label,
      fontSize: 9,
      borderWidth: 0,
      align: 'center',
    });
    groupAnnotation(doc, 0, caption, shape);
  };
  await measure(
    'line',
    [
      { x: 100, y: 600 },
      { x: 244, y: 600 },
    ],
    '2.00 in',
    { x: 140, y: 604 },
  );
  await measure(
    'polygon',
    [
      { x: 100, y: 200 },
      { x: 244, y: 200 },
      { x: 244, y: 344 },
      { x: 100, y: 344 },
    ],
    '4.00 sq in',
    { x: 140, y: 270 },
  );
  return doc;
}

// A measurement's ends and corners could be dragged, and its size typed, while its label kept
// the old value: a 2 in line dragged to 5 in still read "2.00 in". A measurement moves as a
// whole, keeping its value, and offers no handles or sizes that would change it.
test('a measurement cannot be stretched away from its label', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  const doc = await measured();
  expect(listAnnotations(doc, 0).map((entry) => entry.group.length)).toEqual([1, 1]);
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'measured.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  const props = page.getByRole('complementary', { name: 'Selection properties' });
  for (const [name, kind] of [
    ['Line: 2.00 in', 'Line'],
    ['Polygon: 4.00 sq in', 'Polygon'],
  ]) {
    const target = page.getByRole('button', { name, exact: true });
    await target.focus();
    await expect(target).toHaveAttribute('aria-pressed', 'true');
    await expect(props.getByLabel('Comment')).toHaveValue(name.split(': ')[1]);
    await expect(target.locator('.annotation-handle')).toHaveCount(0);
    await expect(
      props.getByLabel(new RegExp(`^${kind} ((width|height|length) in points|angle in degrees)$`)),
    ).toHaveCount(0);
  }
});
