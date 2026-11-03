import { test, expect } from '@playwright/test';
import { onTab } from './helpers/editor-tools.js';

// Alt+Shift+Up/Down (Control+Shift+Up/Down on a Mac) in a table moves the caret's row past the row above
// or below, as in Word. In a cell the keys did nothing, since only body paragraphs moved.
const input = page => page.getByRole('textbox', { name: 'Document text' });
const rows = page => page.evaluate(() => {
  const m = window.__docs.current.view.engine.model, at = m.locate(m.selection.focus);
  return { rows: m.tables[0].rows.map(r => r.cells.map(c => m.paragraphs.filter(p => p.cellId === c.id).map(p => p.runs.map(x => x.text).join('')).join('/')).join(' ')),
    caret: [m.paragraphs[at.index].runs.map(x => x.text).join(''), at.offset] };
});
for (const [platform, chord] of [['Win32', 'Alt+Shift'], ['MacIntel', 'Control+Shift']]) test(`${chord}+Up and Down move a table row on ${platform}`, async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(value => Object.defineProperty(Navigator.prototype, 'platform', { get: () => value }), platform);
  await page.goto('/mock.html#/new');
  await expect((await onTab(page, 'home')).getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await input(page).focus();
  await (await onTab(page, 'insert')).getByRole('button', { name: 'Insert table', exact: true }).click();
  await page.getByRole('menuitem', { name: '2 columns, 3 rows' }).click();
  for (const [i, value] of ['a0', 'a1', 'b0', 'b1', 'c0', 'c1'].entries()) { if (i) await input(page).press('Tab'); await page.keyboard.type(value); }
  await input(page).press('ArrowUp');
  await expect.poll(() => rows(page)).toEqual({ rows: ['A0 A1', 'B0 B1', 'C0 C1'], caret: ['B1', 2] });
  await input(page).press(`${chord}+ArrowUp`);
  await expect.poll(() => rows(page)).toEqual({ rows: ['B0 B1', 'A0 A1', 'C0 C1'], caret: ['B1', 2] });
  await input(page).press(`${chord}+ArrowDown`); await input(page).press(`${chord}+ArrowDown`);
  await expect.poll(() => rows(page)).toEqual({ rows: ['A0 A1', 'C0 C1', 'B0 B1'], caret: ['B1', 2] });
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => rows(page)).toMatchObject({ rows: ['A0 A1', 'B0 B1', 'C0 C1'] });
  expect(errors).toEqual([]);
});
