import { test, expect } from '@playwright/test';
import { PDFDocument, PDFName, PDFNumber } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { addShapeAnnotation, listAnnotations } from '../../src/core/annotations.js';

const settled = (page) => expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');

async function openWithRectangle(page, flags = null) {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  const doc = await PDFDocument.create();
  doc.addPage([400, 500]);
  addShapeAnnotation(doc, 0, { kind: 'square', rect: { x: 100, y: 300, width: 80, height: 60 } });
  if (flags !== null)
    doc.context
      .lookup(doc.getPage(0).node.Annots().get(0))
      .set(PDFName.of('F'), PDFNumber.of(flags));
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'comment-keyboard.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await settled(page);
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  return page.getByRole('button', { name: 'Rectangle', exact: true });
}
async function savedRectangles(page) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const saved = await PDFDocument.load(await readFile(await (await pending).path()));
  return listAnnotations(saved, 0).filter((entry) => entry.subtype === 'Square');
}

test('arrow keys keep moving a clicked comment, one step per press', async ({ page }) => {
  const target = await openWithRectangle(page);
  await target.click();
  await expect(target).toBeFocused();
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('ArrowRight');
    await settled(page);
    // The redrawn comment keeps the keyboard focus, so the next press moves it again.
    await expect(target).toBeFocused();
  }
  await page.keyboard.press('Shift+ArrowUp');
  await settled(page);
  await expect(target).toBeFocused();
  const [moved] = await savedRectangles(page);
  expect(moved.box.x).toBeGreaterThan(101);
  expect(moved.box.y).toBeGreaterThan(305);
  expect(moved.box.width).toBeCloseTo(80, 3);
  expect(moved.box.height).toBeCloseTo(60, 3);
});

test('Delete removes a clicked comment', async ({ page }) => {
  const target = await openWithRectangle(page);
  await target.click();
  await page.keyboard.press('Delete');
  await settled(page);
  await expect(target).toHaveCount(0);
  // The keyboard focus stays on the page, as it does when a markup is deleted.
  await expect(page.locator('.drawing-overlay')).toBeFocused();
  expect(await savedRectangles(page)).toEqual([]);
});

// A locked or read-only comment offers no Delete button, and the key does nothing either,
// rather than failing with an error.
for (const [label, flags] of [
  ['locked', 4 | 128],
  ['read-only', 4 | 64],
])
  test(`Delete leaves a ${label} comment without an error`, async ({ page }) => {
    const target = await openWithRectangle(page, flags);
    await target.click();
    await expect(
      page
        .getByRole('complementary', { name: 'Selection properties' })
        .getByRole('button', { name: 'Delete' }),
    ).toBeDisabled();
    await page.keyboard.press('Delete');
    await page.keyboard.press('Backspace');
    await settled(page);
    await expect(page.locator('#toast')).toBeHidden();
    await expect(target).toHaveCount(1);
    await expect(target).toBeFocused();
  });
