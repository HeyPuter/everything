import { test, expect } from '@playwright/test';
import { onTab } from './helpers/editor-tools.js';

// Text boxes, WordArt and signature lines go into a table cell as drawings in front of the text there.
const drawings = page => page.evaluate(() => window.__docs.current.view.engine.model.paragraphs.flatMap(p => p.runs.filter(r => r.image).map(r => ({ cell: !!p.cellId, wrap: r.image.anchor?.wrap ?? 'inline' }))));
const toCell = page => page.evaluate(() => {
  const engine = window.__docs.current.view.engine, table = engine.model.tables[0];
  engine.model.selectCell(table.rows[0].cells[0].id); engine.syncInput(); engine.paint(); engine.onSelection(); engine.focus();
});
const saved = page => page.evaluate(async () => {
  const blob = await window.__docs.current.view.doc.exporter();
  const { DocxPackage } = await import('/src/engine/docx.js');
  const pkg = await DocxPackage.open(new Uint8Array(await blob.arrayBuffer()));
  return { readOnly: !!pkg.readOnly, drawings: pkg.paragraphs.filter(p => p.cellId).flatMap(p => p.runs.filter(r => r.image)).length };
});

test('text boxes, WordArt and signature lines can be inserted in a table cell', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect((await onTab(page, 'home')).getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await page.getByRole('textbox', { name: 'Document text' }).focus();
  const insert = page.locator('#ribbon-panel-insert');
  await onTab(page, 'insert');
  await insert.getByRole('button', { name: 'Insert table', exact: true }).click();
  await page.getByRole('menuitem', { name: '2 columns, 2 rows' }).click();
  const closeTextEditor = async () => {
    const editor = page.getByRole('dialog', { name: 'Edit drawing text' });
    await expect(editor).toBeVisible();
    await editor.getByRole('button', { name: 'Cancel' }).click();
  };

  await toCell(page);
  await onTab(page, 'insert');
  await insert.getByRole('button', { name: 'Text Box', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Simple Text Box/ }).click();
  await closeTextEditor();
  await expect.poll(() => drawings(page)).toEqual([{ cell: true, wrap: 'none' }]);

  await toCell(page);
  await onTab(page, 'insert');
  await insert.getByRole('button', { name: 'WordArt', exact: true }).click();
  await page.locator('.menu').getByRole('menuitem').first().click();
  await closeTextEditor();
  await expect.poll(async () => (await drawings(page)).length).toBe(2);

  await toCell(page);
  await onTab(page, 'insert');
  await insert.getByRole('button', { name: 'Signature Line', exact: true }).click();
  const signature = page.getByRole('dialog', { name: 'Signature Line' });
  await signature.getByRole('textbox', { name: 'Suggested signer', exact: true }).fill('Ada Lovelace');
  await signature.getByRole('button', { name: 'OK' }).or(signature.getByRole('button', { name: 'Insert' })).click();
  await expect.poll(async () => (await drawings(page)).length).toBe(3);
  expect(await drawings(page)).toEqual(Array(3).fill({ cell: true, wrap: 'none' }));
  await expect(page.locator('.toast')).toHaveCount(0);

  expect(await saved(page)).toEqual({ readOnly: false, drawings: 3 });
  expect(errors).toEqual([]);
});
