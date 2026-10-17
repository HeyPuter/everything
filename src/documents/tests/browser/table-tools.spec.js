import { test, expect } from '@playwright/test';
import { onTab, menuBarMenu } from './helpers/editor-tools.js';

const input = page => page.getByRole('textbox', { name: 'Document text' });
const model = page => page.evaluate(() => {
  const m = window.__docs.current.view.engine.model;
  return { tables: m.tables.map(t => ({ grid: t.grid, width: t.width, layout: t.layout, rows: t.rows.map(r => ({ height: r.minHeight, rule: r.heightRule, cells: r.cells.map(c => ({ text: m.paragraphs.filter(p => p.cellId === c.id).map(p => p.runs.map(x => x.text).join('')).join('/'), span: c.span ?? 1, vMerge: c.vMerge || null, shading: c.shading, vertical: c.vertical, direction: c.textDirection || 'lrTb', align: m.paragraphs.find(p => p.cellId === c.id)?.format?.alignment || 'left' })) })) })), block: m.activeCellBlock && { top: m.activeCellBlock.top, bottom: m.activeCellBlock.bottom, left: m.activeCellBlock.left, right: m.activeCellBlock.right } };
});
const texts = async page => (await model(page)).tables[0].rows.map(r => r.cells.map(c => c.text));
async function newTable(page, columns, rows, values) {
  await page.goto('/mock.html#/new');
  await expect((await onTab(page, 'home')).getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await input(page).focus();
  await (await onTab(page, 'insert')).getByRole('button', { name: 'Insert table', exact: true }).click();
  await page.getByRole('menuitem', { name: `${columns} columns, ${rows} rows` }).click();
  for (const [i, value] of values.entries()) { if (i) await input(page).press('Tab'); if (value) await page.keyboard.type(value); }
}
const goToCell = (page, r, c) => page.evaluate(([r, c]) => {
  const e = window.__docs.current.view.engine, table = e.model.tables[0];
  let column = 0; const cell = table.rows[r].cells.find(x => { const start = column; column += x.span ?? 1; return start <= c && c < column; });
  e.model.selectCell(cell.id); e.syncInput(); e.paint(); e.onSelection(); e.focus();
}, [r, c]);
const ribbon = page => page.locator('.ribbon-card');
test.use({ viewport: { width: 1440, height: 900 } });

test('Insert Table dialog, Draw/Convert entries and Quick Tables', async ({ page }) => {
  await page.goto('/mock.html#/new');
  await expect((await onTab(page, 'home')).getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await input(page).focus();
  await page.keyboard.type('Name\tQty'); await page.keyboard.press('Enter'); await page.keyboard.type('Pens\t2'); await page.keyboard.press('Enter'); await page.keyboard.type('After');
  // Convert the first two lines to a table.
  await input(page).evaluate(el => { el.setSelectionRange(0, el.value.indexOf('After') - 1); el.dispatchEvent(new Event('select', { bubbles: true })); });
  await (await onTab(page, 'insert')).getByRole('button', { name: 'Insert table', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'Draw Table' })).toBeVisible();
  await page.getByRole('menuitem', { name: 'Convert Text to Table…' }).click();
  const convert = page.getByRole('dialog', { name: 'Convert Text to Table' });
  await expect(convert.getByLabel('Number of columns')).toHaveValue('2');
  await convert.getByRole('button', { name: 'OK' }).click();
  expect(await texts(page)).toEqual([['Name', 'Qty'], ['Pens', '2']]);
  // Insert Table…: four columns that fit the window.
  await page.keyboard.press('ControlOrMeta+End');
  await (await onTab(page, 'insert')).getByRole('button', { name: 'Insert table', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Insert Table…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Insert Table' });
  await dialog.getByLabel('Number of columns').fill('4'); await dialog.getByLabel('Number of rows').fill('3');
  await dialog.getByLabel('AutoFit to window').check();
  await dialog.getByRole('button', { name: 'OK' }).click();
  const after = await model(page);
  expect(after.tables).toHaveLength(2);
  expect(after.tables[1]).toMatchObject({ layout: 'autofit', width: { type: 'pct', value: 5000 } });
  expect(after.tables[1].rows).toHaveLength(3);
  // Quick Tables: a ready table with content and a style.
  await page.keyboard.press('ControlOrMeta+End');
  await (await onTab(page, 'insert')).getByRole('button', { name: 'Insert table', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Quick Tables' }).click();
  await page.getByRole('menuitem', { name: /^Tabular List/ }).click();
  const quick = (await model(page)).tables.at(-1);
  expect(quick.rows[0].cells.map(c => c.text)).toEqual(['Item', 'Needed']);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await model(page)).tables).toHaveLength(2);
});

test('Table Layout commands: select, insert, delete, merge, split, sizes, alignment and direction', async ({ page }) => {
  await newTable(page, 3, 3, ['A0', 'A1', 'A2', 'B0', 'B1', 'B2', 'C0', 'C1', 'C2']);
  await goToCell(page, 1, 1);
  await onTab(page, 'tableLayout');
  // Select Column makes a block; shading from the palette reaches the whole column.
  await ribbon(page).getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Select Column' }).click();
  expect((await model(page)).block).toEqual({ top: 0, bottom: 2, left: 1, right: 2 });
  await onTab(page, 'tableDesign');
  await ribbon(page).getByRole('button', { name: 'Shading colors', exact: true }).click();
  await page.locator('.menu-custom-grid .swatch').first().click();
  expect((await model(page)).tables[0].rows.map(r => r.cells[1].shading)).toEqual(['000000', '000000', '000000']);
  await onTab(page, 'tableLayout');
  // Insert above and left.
  await goToCell(page, 0, 0);
  await ribbon(page).getByRole('button', { name: 'Insert Above', exact: true }).click();
  await ribbon(page).getByRole('button', { name: 'Insert Left', exact: true }).click();
  expect(await texts(page)).toEqual([['', '', '', ''], ['', 'A0', 'A1', 'A2'], ['', 'B0', 'B1', 'B2'], ['', 'C0', 'C1', 'C2']]);
  // Delete them again from the Delete menu.
  await ribbon(page).getByRole('button', { name: 'Delete', exact: true }).click(); await page.getByRole('menuitem', { name: 'Delete Columns' }).click();
  await goToCell(page, 0, 0);
  await ribbon(page).getByRole('button', { name: 'Delete', exact: true }).click(); await page.getByRole('menuitem', { name: 'Delete Rows' }).click();
  expect(await texts(page)).toEqual([['A0', 'A1', 'A2'], ['B0', 'B1', 'B2'], ['C0', 'C1', 'C2']]);
  // Merge a dragged-out block, then split it into two columns.
  await input(page).evaluate(el => { el.setSelectionRange(el.value.indexOf('A0'), el.value.indexOf('B1') + 1); el.dispatchEvent(new Event('select', { bubbles: true })); });
  await expect.poll(async () => (await model(page)).block).toEqual({ top: 0, bottom: 1, left: 0, right: 2 });
  await ribbon(page).getByRole('button', { name: 'Merge Cells', exact: true }).click();
  expect((await model(page)).tables[0].rows[0].cells[0]).toMatchObject({ text: 'A0/A1/B0/B1', span: 2, vMerge: 'restart' });
  await ribbon(page).getByRole('button', { name: 'Split Cells…', exact: true }).click();
  const split = page.getByRole('dialog', { name: 'Split Cells' });
  await split.getByLabel('Number of columns').fill('2'); await split.getByLabel('Number of rows').fill('2');
  await split.getByRole('button', { name: 'OK' }).click();
  expect(await texts(page)).toEqual([['A0/A1/B0/B1', '', 'A2'], ['', '', 'B2'], ['C0', 'C1', 'C2']]);
  // Height and width spinners, distribute, alignment grid and text direction.
  await goToCell(page, 2, 0);
  await ribbon(page).getByLabel('Height (in)', { exact: true }).fill('0.5'); await ribbon(page).getByLabel('Height (in)', { exact: true }).press('Enter');
  expect((await model(page)).tables[0].rows[2]).toMatchObject({ height: 720, rule: 'atLeast' });
  await ribbon(page).getByRole('button', { name: 'Distribute Columns', exact: true }).click();
  const grid = (await model(page)).tables[0].grid;
  expect(Math.max(...grid) - Math.min(...grid)).toBeLessThanOrEqual(1);
  await ribbon(page).getByRole('button', { name: 'Align Bottom Right', exact: true }).click();
  expect((await model(page)).tables[0].rows[2].cells[0]).toMatchObject({ vertical: 'bottom', align: 'right' });
  await expect(ribbon(page).getByRole('button', { name: 'Align Bottom Right', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await ribbon(page).getByRole('button', { name: 'Text Direction', exact: true }).click();
  expect((await model(page)).tables[0].rows[2].cells[0].direction).toBe('tbRl');
  // AutoFit to window, then Split Table.
  await ribbon(page).getByRole('button', { name: 'AutoFit', exact: true }).click(); await page.getByRole('menuitem', { name: 'AutoFit Window' }).click();
  expect((await model(page)).tables[0].width).toEqual({ type: 'pct', value: 5000 });
  await ribbon(page).getByRole('button', { name: 'Split Table', exact: true }).click();
  expect((await model(page)).tables).toHaveLength(2);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await model(page)).tables).toHaveLength(1);
});

test('Data: sort, formula with Update Fields, repeat header and convert to text', async ({ page }) => {
  await newTable(page, 2, 4, ['Item', 'Price', 'Pens', '30', 'Ink', '5', 'Total', '']);
  await onTab(page, 'tableLayout');
  // Formula in the last cell: SUM(ABOVE) is suggested and previewed.
  await goToCell(page, 3, 1);
  await ribbon(page).getByRole('button', { name: 'Formula', exact: true }).click();
  const formula = page.getByRole('dialog', { name: 'Formula' });
  await expect(formula.getByLabel('Formula')).toHaveValue('=SUM(ABOVE)');
  await formula.getByLabel('Number format').fill('0.00');
  await expect(formula.locator('output.table-formula-result')).toHaveText('Result: 35.00');
  await formula.getByRole('button', { name: 'OK' }).click();
  expect((await texts(page))[3][1]).toBe('35.00');
  // Sort the body by price, keeping the header row.
  await goToCell(page, 1, 0);
  await ribbon(page).getByRole('button', { name: 'Sort', exact: true }).click();
  const sort = page.getByRole('dialog', { name: 'Sort' });
  await sort.getByLabel('A header row').check();
  await sort.getByLabel('Sort by column').selectOption({ label: 'Price' });
  await sort.getByLabel('Sort by type').selectOption('number');
  await sort.getByRole('button', { name: 'OK' }).click();
  expect((await texts(page)).map(r => r[0])).toEqual(['Item', 'Ink', 'Pens', 'Total']);
  // Change an input and update fields (F9 in the document).
  await goToCell(page, 1, 1);
  await input(page).evaluate(el => { const at = el.value.indexOf('5\n'); el.setSelectionRange(at, at + 1); el.dispatchEvent(new Event('select', { bubbles: true })); });
  await page.keyboard.type('15');
  await page.keyboard.press('F9');
  await expect.poll(async () => (await texts(page))[3][1]).toBe('45.00');
  // Repeat Header Rows toggles the first row.
  await goToCell(page, 0, 0);
  const repeat = ribbon(page).getByRole('button', { name: 'Repeat Header Rows', exact: true });
  await repeat.click();
  await expect(repeat).toHaveAttribute('aria-pressed', 'true');
  // Convert to text with commas.
  await ribbon(page).getByRole('button', { name: 'Convert to Text', exact: true }).click();
  const convert = page.getByRole('dialog', { name: 'Convert Table to Text' });
  await convert.getByLabel('Commas').check();
  await convert.getByRole('button', { name: 'OK' }).click();
  expect((await model(page)).tables).toHaveLength(0);
  await expect(input(page)).toHaveValue(/Item,Price\nInk,15\nPens,30\nTotal,45\.00/);
});

test('Table Properties sets row, column, cell and alt text options in one step', async ({ page }) => {
  await newTable(page, 2, 2, ['a', 'b', 'c', 'd']);
  await goToCell(page, 0, 0);
  await onTab(page, 'tableLayout');
  await ribbon(page).getByRole('button', { name: 'Table properties', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Table properties' });
  await dialog.getByRole('button', { name: 'Row', exact: true }).click();
  await dialog.getByLabel('Row height rule').selectOption('exact');
  await dialog.getByLabel('Row height (pt)').fill('30');
  await dialog.getByLabel('Repeat as header row at the top of each page').check();
  await dialog.getByLabel('Vertical alignment').selectOption('center');
  await dialog.getByLabel('Table title').fill('Letters');
  await dialog.getByLabel('Table description').fill('Four letters in a grid');
  await dialog.getByRole('button', { name: 'Apply' }).click();
  await expect(dialog).toBeHidden();
  const state = await page.evaluate(() => { const t = window.__docs.current.view.engine.model.tables[0]; return { caption: t.caption, description: t.description, height: t.rows[0].minHeight, rule: t.rows[0].heightRule, header: !!t.rows[0].header, vertical: t.rows[0].cells[0].vertical }; });
  expect(state).toEqual({ caption: 'Letters', description: 'Four letters in a grid', height: 600, rule: 'exact', header: true, vertical: 'center' });
  // One undo step takes all of it back.
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await page.evaluate(() => window.__docs.current.view.engine.model.tables[0].caption || '')).toBe('');
});

test('Table properties applies with a row height that is not a whole or half point', async ({ page }) => {
  await newTable(page, 2, 2, ['a', 'b', 'c', 'd']);
  await goToCell(page, 0, 0);
  // 0.3 in = 21.6 pt, set from the Row height dialog.
  await (await onTab(page, 'tableLayout')).getByRole('button', { name: 'Row height', exact: true }).click();
  const height = page.getByRole('dialog', { name: 'Row height', exact: true });
  await height.getByLabel('Row height setting').selectOption('atLeast');
  await height.getByLabel('Minimum row height (pt)').fill('21.6');
  await height.getByRole('button', { name: 'Apply' }).click();
  await expect(height).toBeHidden();
  await ribbon(page).getByRole('button', { name: 'Table properties', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Table properties' });
  await expect(dialog.getByLabel('Row height (pt)')).toHaveValue('21.6');
  await dialog.getByLabel('Vertical alignment').selectOption('center');
  await dialog.getByRole('button', { name: 'Apply' }).click();
  await expect(dialog).toBeHidden();
  expect(await page.evaluate(() => { const row = window.__docs.current.view.engine.model.tables[0].rows[0]; return [row.minHeight, row.heightRule, row.cells[0].vertical]; })).toEqual([432, 'atLeast', 'center']);
});

test('the Table menu and context menu offer the table commands', async ({ page }) => {
  await newTable(page, 2, 2, ['a', 'b', 'c', 'd']);
  await goToCell(page, 0, 0);
  const labels = await page.evaluate(() => {
    const flatten = items => items.flatMap(i => !i || i.separator ? [] : [i.label, ...(i.items ? flatten(i.items) : [])]);
    const c = window.__docs.current.view.commands;
    return { menu: flatten(c.extendMenu('table', {})), context: flatten(c.contextMenuItems('table', {})) };
  });
  for (const name of ['Draw Table', 'Insert', 'Columns to the Left', 'Rows Below', 'Cells…', 'Delete', 'Select', 'Merge Cells', 'Split Cells…', 'Split Table', 'AutoFit and Distribute', 'Distribute Rows Evenly', 'Repeat Header Rows', 'Convert Text to Table…', 'Convert Table to Text…', 'Sort…', 'Formula…', 'View Gridlines', 'Table Properties…']) expect(labels.menu, name).toContain(name);
  for (const name of ['Insert Rows Above', 'Delete Cells…', 'Merge Cells', 'Split Cells…', 'Borders', 'Cell Alignment', 'AutoFit', 'Text Direction', 'Table Properties…']) expect(labels.context, name).toContain(name);
});

test('the menu bar Table menu runs the table commands', async ({ page }) => {
  await newTable(page, 2, 2, ['A', 'B', 'C', 'D']);
  await goToCell(page, 0, 0);
  const menu = await menuBarMenu(page, 'Table');
  await expect(menu.getByRole('menuitemcheckbox', { name: 'Draw Table', exact: true })).toBeVisible();
  for (const name of ['Insert', 'Delete', 'Select', 'Merge Cells', 'Split Cells…', 'Split Table', 'Sort…', 'Formula…', 'Table Properties…']) await expect(menu.getByRole('menuitem', { name, exact: true }).first()).toBeVisible();
  await menu.getByRole('menuitem', { name: 'Insert', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Rows Below', exact: true }).click();
  expect((await model(page)).tables[0].rows).toHaveLength(3);
});
