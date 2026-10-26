import { test, expect } from '@playwright/test';
import { onTab } from './helpers/editor-tools.js';

// Editing a diagram regenerates its shapes from the outline; the frame around them is the user's.
const selected = page => page.evaluate(() => {
  const image = window.__docs.current.view.engine.model.selectedImage;
  return image && { anchor: image.anchor || null, alt: image.alt, title: /<wp:docPr\b[^>]*\stitle="([^"]*)"/.exec(image.shell || '')?.[1] || '' };
});
/** Save, then open the saved file with the engine: the diagram's frame as written and as read back. */
const saved = page => page.evaluate(async () => {
  const blob = await window.__docs.current.view.doc.exporter(), bytes = new Uint8Array(await blob.arrayBuffer());
  const { DocxPackage } = await import('/src/engine/docx.js');
  const pkg = await DocxPackage.open(bytes);
  const image = pkg.paragraphs.flatMap(p => p.runs).find(run => run.image)?.image;
  return { readOnly: !!pkg.readOnly, anchor: image?.anchor || null, alt: image?.alt, title: /<wp:docPr\b[^>]*\stitle="([^"]*)"/.exec(image?.shell || '')?.[1] || '' };
});

test('editing a diagram keeps its wrapping, title and position', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect((await onTab(page, 'home')).getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  const input = page.getByRole('textbox', { name: 'Document text' });
  await input.focus();
  await page.keyboard.type('Text that wraps around the diagram. '.repeat(20));
  await input.press('ControlOrMeta+Home');
  const insert = page.locator('#ribbon-panel-insert');
  await onTab(page, 'insert');
  await insert.getByRole('button', { name: 'Diagram', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Basic Process/ }).click();
  await page.getByRole('dialog', { name: 'Diagram' }).getByRole('button', { name: 'Insert' }).click();
  await expect.poll(async () => (await selected(page))?.alt).toMatch(/^Diagram: Basic Process/);
  // Tight wrapping, then a title in the Alt Text pane.
  await onTab(page, 'shapeFormat');
  const format = page.locator('#ribbon-panel-shapeFormat');
  await format.getByRole('button', { name: 'Wrap Text', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'Tight' }).click();
  await expect.poll(async () => (await selected(page))?.anchor?.contour).toBe('tight');
  await format.getByRole('button', { name: 'Alt Text', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Alt Text pane' });
  await pane.getByRole('textbox', { name: 'Title (optional)' }).fill('Release steps');
  await pane.getByRole('button', { name: 'Save' }).click();
  await expect.poll(async () => (await selected(page))?.title).toBe('Release steps');
  await pane.getByRole('button', { name: 'Close Alt Text pane' }).click();
  const before = await selected(page);
  // Edit Selected Diagram: new items.
  await onTab(page, 'insert');
  await insert.getByRole('button', { name: 'Diagram', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Edit Selected Diagram…' }).click();
  const edit = page.getByRole('dialog', { name: 'Edit Diagram' });
  await edit.getByRole('textbox', { name: 'Diagram text' }).fill('Draft\nReview\nPublish');
  await edit.getByRole('button', { name: 'Update' }).click();
  await expect.poll(async () => (await selected(page))?.alt).toBe('Diagram: Basic Process (Blue)\nDraft\nReview\nPublish');
  const after = await selected(page);
  expect(after.anchor).toEqual(before.anchor);
  expect(after.title).toBe('Release steps');
  // Saved and opened again: still tight, titled, and editable as a diagram (its outline intact).
  const file = await saved(page);
  expect(file.readOnly).toBe(false);
  expect(file.anchor).toMatchObject({ wrap: 'square', contour: 'tight' });
  expect(file.title).toBe('Release steps');
  expect(file.alt).toBe('Diagram: Basic Process (Blue)\nDraft\nReview\nPublish');
  // One undo step brings the old items back.
  await page.getByRole('button', { name: 'Undo', exact: true }).first().click();
  await expect.poll(async () => (await selected(page))?.alt).toBe(before.alt);
  expect(errors).toEqual([]);
});
