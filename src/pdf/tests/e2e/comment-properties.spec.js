import { test, expect } from '@playwright/test';
import { PDFDocument, PDFName } from 'pdf-lib';
import { addShapeAnnotation } from '../../src/core/annotations.js';
import { drawAppearance } from '../../src/core/annotation-appearance.js';

const settled = (page) => expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');

// Comments from other editors that this one can move or delete but not restyle: a stamp keeps
// its own art and an insertion mark its own shape, and a read-only comment takes no change.
test('the properties panel offers only the changes a comment can take', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  const doc = await PDFDocument.create();
  const sheet = doc.addPage([400, 500]);
  const annots = [];
  for (const fields of [
    { Subtype: 'Stamp', Name: 'Approved', Rect: [100, 380, 250, 430] },
    { Subtype: 'Caret', Rect: [100, 100, 120, 115], C: [0, 0, 1] },
  ]) {
    const dict = doc.context.obj({ Type: 'Annot', F: 4, ...fields });
    drawAppearance(doc, sheet, dict);
    annots.push(doc.context.register(dict));
  }
  sheet.node.set(PDFName.of('Annots'), doc.context.obj(annots));
  const readOnly = addShapeAnnotation(doc, 0, {
    kind: 'square',
    rect: { x: 100, y: 200, width: 80, height: 60 },
    text: 'Fixed',
  });
  doc.context.lookup(sheet.node.Annots().get(2)).set(PDFName.of('F'), doc.context.obj(4 | 64));
  expect(sheet.node.Annots().get(2).toString()).toBe(readOnly);
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'comment-properties.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await settled(page);
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  const props = page.getByRole('complementary', { name: 'Selection properties' });

  await page.getByRole('button', { name: 'Stamp', exact: true }).click();
  await expect(props.getByLabel('Color', { exact: true })).toBeDisabled();
  await expect(props.getByLabel('Opacity', { exact: true })).toBeDisabled();
  await expect(props.getByLabel('Line width', { exact: true })).toHaveCount(0);
  await expect(props.getByRole('button', { name: 'Delete' })).toBeEnabled();

  await page.getByRole('button', { name: 'Insertion mark', exact: true }).click();
  await expect(props.getByLabel('Color', { exact: true })).toBeDisabled();
  await expect(props.getByLabel('Opacity', { exact: true })).toBeDisabled();
  await expect(props.getByLabel('Line width', { exact: true })).toHaveCount(0);

  await page.getByRole('button', { name: 'Rectangle: Fixed', exact: true }).click();
  await expect(props.getByLabel('Comment', { exact: true })).not.toBeEditable();
  for (const label of ['Color', 'Fill color', 'No fill', 'Line width', 'Opacity'])
    await expect(props.getByLabel(label, { exact: true })).toBeDisabled();
  await expect(props.getByRole('button', { name: 'Delete' })).toBeDisabled();
  // Nor does it follow a drag only to fail and stay drawn where it was dropped.
  const fixed = page.getByRole('button', { name: 'Rectangle: Fixed', exact: true });
  const box = await fixed.boundingBox();
  await page.mouse.move(box.x + 20, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + 80, box.y + 60, { steps: 5 });
  await page.mouse.up();
  await settled(page);
  await expect(page.locator('#toast')).not.toContainText('read-only');
  expect(await fixed.evaluate((node) => node.style.transform)).toBe('');
});
