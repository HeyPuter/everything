import { test, expect } from '@playwright/test';
import { PDFDocument, PDFName } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { addShapeAnnotation, listAnnotations } from '../../src/core/annotations.js';
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

// A line width the list does not offer, as other editors write, is shown as it is.
test('the Line width field shows a comment’s own width', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  const doc = await PDFDocument.create();
  doc.addPage([400, 500]);
  addShapeAnnotation(doc, 0, {
    kind: 'square',
    rect: { x: 100, y: 200, width: 80, height: 60 },
    width: 5,
    text: 'Wide',
  });
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'comment-width.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await settled(page);
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: 'Rectangle: Wide', exact: true }).click();
  const props = page.getByRole('complementary', { name: 'Selection properties' });
  const width = props.getByLabel('Line width', { exact: true });
  await expect(width).toHaveValue('5');
  await expect(width.locator('option')).toHaveText([
    '0.5 pt',
    '1 pt',
    '2 pt',
    '3 pt',
    '4 pt',
    '5 pt',
    '6 pt',
    '8 pt',
  ]);
  // A width from the list takes its place.
  await width.selectOption('2');
  await settled(page);
  await expect(props.getByLabel('Line width', { exact: true })).toHaveValue('2');
  // The fill switch says what it does in words, not as a bare tick beside "Fill".
  const noFill = props.getByRole('checkbox', { name: 'No fill', exact: true });
  await expect(noFill).toBeChecked();
  await expect(props.getByText('No fill', { exact: true })).toBeVisible();
  await noFill.press('Space');
  await settled(page);
  await expect(noFill).not.toBeChecked();
  await expect(noFill).toBeFocused();
});

// Ctrl+Shift+S downloads without moving the focus, so the field never reports its change.
test('a download includes the words typed into a comment’s field', async ({ page }) => {
  test.skip(test.info().project.name === 'mobile', 'keyboard shortcut');
  await page.route('https://js.puter.com/**', (route) => route.abort());
  const doc = await PDFDocument.create();
  doc.addPage([400, 500]);
  addShapeAnnotation(doc, 0, {
    kind: 'square',
    rect: { x: 100, y: 200, width: 80, height: 60 },
    text: 'Draft',
  });
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'comment-text.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await settled(page);
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: 'Rectangle: Draft', exact: true }).click();
  const props = page.getByRole('complementary', { name: 'Selection properties' });
  await props.getByLabel('Comment', { exact: true }).fill('Final wording');
  const pending = page.waitForEvent('download');
  await page.keyboard.press('Control+Shift+S');
  const saved = await PDFDocument.load(await readFile(await (await pending).path()));
  expect(listAnnotations(saved, 0).map((comment) => comment.contents)).toEqual(['Final wording']);
  await settled(page);
  // Saved once: leaving the field afterwards adds no second edit to undo.
  await page.getByRole('button', { name: 'Rectangle: Final wording', exact: true }).focus();
  await settled(page);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await settled(page);
  await expect(page.getByRole('button', { name: 'Rectangle: Draft', exact: true })).toBeVisible();
});

// Leaving the Comment field saves it; the click that leaves it must not be lost to that save.
test('a click that leaves a comment’s field still does what it says', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  const doc = await PDFDocument.create();
  doc.addPage([400, 500]);
  for (const [y, text] of [
    [300, 'First'],
    [100, 'Second'],
  ])
    addShapeAnnotation(doc, 0, {
      kind: 'square',
      rect: { x: 100, y, width: 80, height: 60 },
      text,
    });
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'comment-clicks.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await settled(page);
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  const props = page.getByRole('complementary', { name: 'Selection properties' });
  const comment = props.getByLabel('Comment', { exact: true });

  await page.getByRole('button', { name: 'Rectangle: First', exact: true }).click();
  await props.getByLabel('Reply text').fill('Agreed');
  await comment.fill('First, reworded');
  await props.getByRole('button', { name: 'Reply', exact: true }).click();
  await settled(page);
  await expect(props.getByRole('list', { name: 'Replies' })).toContainText('Agreed');
  await comment.fill('First, reworded again');
  await props.getByLabel('Line width', { exact: true }).selectOption('4');
  await settled(page);

  await page.getByRole('button', { name: 'Rectangle: Second', exact: true }).click();
  await comment.fill('Going away');
  await props.getByRole('button', { name: 'Delete' }).click();
  await settled(page);
  await expect(page.locator('.annotation-target')).toHaveCount(1);

  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const saved = await PDFDocument.load(await readFile(await (await pending).path()));
  const kept = listAnnotations(saved, 0);
  expect(kept.map((entry) => [entry.contents, entry.width, entry.replies.length])).toEqual([
    ['First, reworded again', 4, 1],
  ]);
});
