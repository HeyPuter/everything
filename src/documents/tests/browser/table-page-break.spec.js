import { test, expect } from '@playwright/test';
import { onTab } from './helpers/editor-tools.js';

// Ctrl+Enter (Cmd+Return on a Mac) in a table starts the caret's row on a new page, as in Word: the table
// splits above the row and a page break goes between the parts (from the first row: before the table).
// It used to write a page break into the cell, where it is kept but does not advance, so nothing happened.
const input = page => page.getByRole('textbox', { name: 'Document text' });
const shape = page => page.evaluate(() => {
  const e = window.__docs.current.view.engine, m = e.model;
  const caret = m.paragraphs[m.locate ? m.locate(m.selection.focus).index : 0];
  return { tables: m.tables.map(t => t.rows.map(r => r.cells.map(c => m.paragraphs.filter(p => p.cellId === c.id).map(p => p.runs.map(x => x.text).join('')).join('/')))),
    body: m.paragraphs.filter(p => !p.cellId).map(p => p.runs.map(x => x.text).join('')),
    pages: m.tables.map(t => e.layout.cells.find(c => c.id === t.rows[0].cells[0].id)?.page),
    caret: caret?.runs.map(x => x.text).join('') ?? null };
});
async function table(page) {
  await page.goto('/mock.html#/new');
  await expect((await onTab(page, 'home')).getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await input(page).focus();
  await (await onTab(page, 'insert')).getByRole('button', { name: 'Insert table', exact: true }).click();
  await page.getByRole('menuitem', { name: '2 columns, 3 rows' }).click();
  for (const [i, value] of ['a0', 'a1', 'b0', 'b1', 'c0', 'c1'].entries()) { if (i) await input(page).press('Tab'); await page.keyboard.type(value); }
}
const goToCell = (page, r, c) => page.evaluate(([r, c]) => {
  const e = window.__docs.current.view.engine;
  e.model.selectCell(e.model.tables[0].rows[r].cells[c].id); e.syncInput(); e.paint(); e.onSelection(); e.focus();
}, [r, c]);

test('Ctrl+Enter in a table moves the caret row to a new page, and undoes in one step', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await table(page);
  await goToCell(page, 1, 1);
  await input(page).press('ControlOrMeta+Enter');
  await expect.poll(() => shape(page)).toEqual({ tables: [[['A0', 'A1']], [['B0', 'B1'], ['C0', 'C1']]], body: ['\f', ''], pages: [0, 1], caret: 'B1' });
  // The caret stays in its cell, now at the top of the next page.
  await page.keyboard.type('!');
  expect((await shape(page)).tables[1][0]).toEqual(['B0', '!B1']);
  await page.keyboard.press('ControlOrMeta+z'); await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => shape(page)).toMatchObject({ tables: [[['A0', 'A1'], ['B0', 'B1'], ['C0', 'C1']]], body: [''], pages: [0] });

  // From the first row the whole table moves: the break goes before it.
  await goToCell(page, 0, 0);
  await input(page).press('ControlOrMeta+Enter');
  await expect.poll(() => shape(page)).toEqual({ tables: [[['A0', 'A1'], ['B0', 'B1'], ['C0', 'C1']]], body: ['\f', ''], pages: [1], caret: 'A0' });
  expect(errors).toEqual([]);
});

// Split Table moves the lower rows into a new table after an untracked paragraph, so with Track Changes on
// it refuses, as Move Table and the other structural table edits do; each refusal is said once.
test('Ctrl+Enter and Ctrl+Shift+Enter in a table with Track Changes on say why instead of splitting it', async ({ page }) => {
  await table(page);
  await page.evaluate(() => { window.__docs.current.view.engine.model.trackChanges = true; });
  const unchanged = { tables: [[['A0', 'A1'], ['B0', 'B1'], ['C0', 'C1']]], body: [''] };
  for (const [keys, message] of [['ControlOrMeta+Enter', 'Breaking a table across pages cannot be tracked yet.'], ['ControlOrMeta+Shift+Enter', 'Splitting a table cannot be tracked yet.']]) {
    for (const row of [1, 0]) {
      await goToCell(page, row, 0);
      await input(page).press(keys);
      await expect(page.locator('.toast-root').getByText(message)).toHaveCount(1);
      await expect(page.locator('.toast-root').getByText('cannot be tracked yet')).toHaveCount(1);
      expect(await shape(page), `${keys} in row ${row}`).toMatchObject(unchanged);
      await page.locator('.toast-root').evaluate(root => root.replaceChildren());
    }
  }
});
