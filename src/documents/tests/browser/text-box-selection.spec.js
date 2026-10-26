import { test, expect } from '@playwright/test';
import { onTab } from './helpers/editor-tools.js';

// A new text box or WordArt takes selected text into itself; what it cannot hold stays in the document.
const state = page => page.evaluate(() => {
  const model = window.__docs.current.view.engine.model;
  return { text: model.text, objects: model.paragraphs.flatMap(p => p.runs.filter(r => r.math || r.image).map(r => r.math ? 'equation' : 'drawing')), tables: model.tables.length,
    cells: model.paragraphs.filter(p => p.cellId).map(p => p.runs.map(r => r.text).join('')) };
});
const select = (page, from, to) => page.evaluate(([from, to]) => {
  const engine = window.__docs.current.view.engine, text = engine.model.text;
  engine.model.select(text.indexOf(from), text.indexOf(to) + to.length); engine.syncInput(); engine.paint(); engine.onSelection();
}, [from, to]);
const closeTextEditor = async page => {
  const editor = page.getByRole('dialog', { name: 'Edit drawing text' });
  await expect(editor).toBeVisible();
  await editor.getByRole('button', { name: 'Cancel' }).click();
};

test('a text box or WordArt made from a selection keeps the equations and table cells it cannot hold', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect((await onTab(page, 'home')).getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  const input = page.getByRole('textbox', { name: 'Document text' });
  await input.focus();
  await page.keyboard.type('Alpha ');
  await page.keyboard.press(process.platform === 'darwin' ? 'Control+Equal' : 'Alt+Equal');
  const equation = page.getByRole('dialog', { name: 'Equation' });
  await equation.getByRole('textbox', { name: 'Equation in linear format' }).fill('x^2');
  await equation.getByRole('button', { name: 'Insert' }).click();
  await page.keyboard.type(' beta');
  await input.press('Enter');
  await page.keyboard.type('Plain words');
  await input.press('Enter');
  const insert = page.locator('#ribbon-panel-insert');
  await onTab(page, 'insert');
  await insert.getByRole('button', { name: 'Insert table', exact: true }).click();
  await page.getByRole('menuitem', { name: '2 columns, 1 row' }).click();
  await page.keyboard.type('Left'); await input.press('Tab'); await page.keyboard.type('Right');

  // Text with an equation: the box goes after it, and the equation stays.
  await select(page, 'Alpha', 'beta');
  await onTab(page, 'insert');
  await insert.getByRole('button', { name: 'Text Box', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Simple Text Box/ }).click();
  await closeTextEditor(page);
  let now = await state(page);
  expect(now.text.startsWith('Alpha ￼ beta￼\nPlain words')).toBe(true);
  expect(now.objects).toEqual(['equation', 'drawing']);

  // Across table cells: the cells keep their text.
  await select(page, 'Left', 'Right');
  await onTab(page, 'insert');
  await insert.getByRole('button', { name: 'WordArt', exact: true }).click();
  await page.locator('.menu').getByRole('menuitem').first().click();
  await closeTextEditor(page);
  now = await state(page);
  expect(now.tables).toBe(1);
  expect(now.cells.join('|')).toMatch(/^Left\|Right/);

  // Plain text still moves into the box.
  await select(page, 'Plain', 'words');
  await onTab(page, 'insert');
  await insert.getByRole('button', { name: 'Text Box', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Simple Text Box/ }).click();
  await closeTextEditor(page);
  now = await state(page);
  expect(now.text).not.toContain('Plain words');
  expect(now.objects).toHaveLength(4);
  expect(errors).toEqual([]);
});
