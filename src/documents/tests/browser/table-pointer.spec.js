import { test, expect } from '@playwright/test';
import { onTab } from './helpers/editor-tools.js';

test.use({ viewport: { width: 1440, height: 900 } });
const input = page => page.getByRole('textbox', { name: 'Document text' });
const ribbon = page => page.locator('.ribbon-card');
/** The client rectangles of a table's cells: [row][cell] = { x, y, w, h }. */
const cells = (page, t = 0) => page.evaluate(t => {
  const e = window.__docs.current.view.engine, table = e.model.tables[t];
  return table.rows.map(row => row.cells.map(cell => {
    const box = e.selectionLayout.cells.find(c => c.id === cell.id);
    if (!box) return null;
    const r = e.canvases[box.page].getBoundingClientRect();
    return { x: r.left + box.x * e.zoom, y: r.top + box.y * e.zoom, w: box.width * e.zoom, h: box.height * e.zoom };
  }));
}, t);
const tables = page => page.evaluate(() => window.__docs.current.view.engine.model.tables.map(t => ({ grid: [...t.grid], layout: t.layout, rows: t.rows.map(r => ({ height: r.minHeight, rule: r.heightRule, explicit: !!r.heightExplicit, cells: r.cells.length })), top: t.rows[0].cells[0].borders?.top || null })));
const block = page => page.evaluate(() => { const b = window.__docs.current.view.engine.model.activeCellBlock; return b && [b.top, b.bottom, b.left, b.right]; });
async function newTable(page, columns, rows) {
  await page.goto('/mock.html#/new');
  await expect((await onTab(page, 'home')).getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await input(page).focus();
  await page.keyboard.type('Intro'); await page.keyboard.press('Enter');
  await (await onTab(page, 'insert')).getByRole('button', { name: 'Insert table', exact: true }).click();
  await page.getByRole('menuitem', { name: `${columns} columns, ${rows} rows` }).click();
  for (let i = 0; i < columns * rows; i++) { if (i) await input(page).press('Tab'); await page.keyboard.type(`X${i}`); }
}
async function drag(page, from, to, steps = 8) {
  await page.mouse.move(from.x, from.y); await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps }); await page.mouse.up();
}

test('dragging column and row borders resizes them, with one undo each', async ({ page }) => {
  await newTable(page, 3, 2);
  const before = await tables(page), box = (await cells(page))[0];
  const border = { x: box[0].x + box[0].w, y: box[0].y + box[0].h / 2 };
  await page.mouse.move(border.x, border.y);
  await expect(page.locator('.canvas-pages')).toHaveAttribute('data-table-cursor', 'col-resize');
  await drag(page, border, { x: border.x + 60, y: border.y });
  const after = await tables(page);
  expect(after[0].layout).toBe('fixed');
  expect(after[0].grid[0] - before[0].grid[0]).toBeGreaterThan(700);
  expect(after[0].grid[0] + after[0].grid[1]).toBeCloseTo(before[0].grid[0] + before[0].grid[1], -1);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await tables(page))[0].grid).toEqual(before[0].grid);
  // The ruler shows the table's column lines; dragging one resizes the same way.
  const markers = page.locator('.table-ruler-marker');
  await expect(markers).toHaveCount(4);
  const marker = await markers.nth(2).boundingBox();
  await drag(page, { x: marker.x + marker.width / 2, y: marker.y + 4 }, { x: marker.x + marker.width / 2 - 45, y: marker.y + 4 });
  const ruled = await tables(page);
  expect(before[0].grid[1] - ruled[0].grid[1]).toBeGreaterThan(500);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  // The bottom border of the first row: a taller minimum height.
  const rowBottom = { x: box[1].x + box[1].w / 2, y: box[1].y + box[1].h };
  await drag(page, rowBottom, { x: rowBottom.x, y: rowBottom.y + 30 });
  const rows = (await tables(page))[0].rows;
  expect(rows[0]).toMatchObject({ rule: 'atLeast', explicit: true });
  expect(rows[0].height).toBeGreaterThan(Math.round((box[1].h + 20) * 15));
});

test('the + marks insert rows and columns; the move handle selects the table; keys follow desktop conventions', async ({ page }) => {
  await newTable(page, 2, 2);
  let box = await cells(page);
  // Hover in the left gutter at the line between the rows, then click the + mark.
  const gutter = { x: box[0][0].x - 11, y: box[0][0].y + box[0][0].h };
  await page.mouse.move(gutter.x, gutter.y);
  await expect(page.locator('.canvas-pages')).toHaveAttribute('data-table-cursor', 'pointer');
  await page.mouse.click(gutter.x, gutter.y);
  expect((await tables(page))[0].rows).toHaveLength(3);
  // Above the table at the line between the columns.
  box = await cells(page);
  const top = { x: box[0][0].x + box[0][0].w, y: box[0][0].y - 11 };
  await page.mouse.move(top.x, top.y); await page.mouse.click(top.x, top.y);
  expect((await tables(page))[0].grid).toHaveLength(3);
  // The move handle selects the whole table.
  box = await cells(page);
  await page.mouse.click(box[0][0].x - 10, box[0][0].y - 10);
  expect(await block(page)).toEqual([0, 2, 0, 3]);
  // Delete clears the contents; Backspace on whole rows removes them.
  await page.keyboard.press('Delete');
  await expect(input(page)).toHaveValue(/^Intro\n\n\n/);
  expect((await tables(page))[0].rows).toHaveLength(3);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await input(page).evaluate(el => { const at = el.value.indexOf('X0') + 1; el.setSelectionRange(at, at); el.dispatchEvent(new Event('select', { bubbles: true })); });
  await onTab(page, 'tableLayout');
  await ribbon(page).getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Select Row' }).click();
  await page.keyboard.press('Backspace');
  expect((await tables(page))[0].rows).toHaveLength(2);
  // Tab in the last cell adds a row.
  await page.keyboard.press('ControlOrMeta+End');
  await input(page).evaluate(el => { const at = el.value.lastIndexOf('X3') + 2; el.setSelectionRange(at, at); el.dispatchEvent(new Event('select', { bubbles: true })); });
  await input(page).press('Tab');
  expect((await tables(page))[0].rows).toHaveLength(3);
});

test('Draw Table draws a table and splits cells; the eraser merges them; the Border Painter paints edges', async ({ page }) => {
  await newTable(page, 2, 2);
  await onTab(page, 'tableLayout');
  const draw = ribbon(page).locator('.ribbon-group[data-group="draw"]');
  const open = async name => { const collapsed = draw.locator('.ribbon-collapsed'); if (await collapsed.isVisible()) await collapsed.click(); await page.getByRole('button', { name, exact: true }).click(); };
  await open('Draw Table');
  await expect(page.locator('.canvas-pages')).toHaveAttribute('data-table-cursor', 'crosshair');
  // An outline below the table makes a one-cell table that size.
  const box = await cells(page), below = box[1][0].y + box[1][0].h + 60;
  await drag(page, { x: box[0][0].x + 20, y: below }, { x: box[0][0].x + 260, y: below + 50 });
  let state = await tables(page);
  expect(state).toHaveLength(2);
  expect(state[1].grid[0]).toBeGreaterThan(3000);
  // A vertical line through the new table splits it into two columns.
  const drawn = (await cells(page, 1))[0][0];
  await drag(page, { x: drawn.x + drawn.w / 2, y: drawn.y + 4 }, { x: drawn.x + drawn.w / 2, y: drawn.y + drawn.h - 4 });
  expect((await tables(page))[1].rows[0].cells).toBe(2);
  // The eraser removes that line again.
  await page.keyboard.press('Escape');
  await open('Eraser');
  const split = (await cells(page, 1))[0];
  await page.mouse.click(split[0].x + split[0].w - 1, split[0].y + split[0].h / 2);
  expect((await tables(page))[1].rows[0].cells).toBe(1);
  await page.keyboard.press('Escape');
  // Border Painter: a 1½ pt red pen on the first cell's top edge.
  await onTab(page, 'tableDesign');
  await ribbon(page).getByRole('button', { name: 'Line Weight', exact: true }).click();
  await page.getByRole('menuitemradio', { name: '1½ pt' }).click();
  await ribbon(page).getByRole('button', { name: 'Border Painter', exact: true }).click();
  await expect(ribbon(page).getByRole('button', { name: 'Border Painter', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const first = (await cells(page))[0][0];
  await page.mouse.move(first.x + first.w / 2, first.y + 1);
  await page.mouse.click(first.x + first.w / 2, first.y + 1);
  state = await tables(page);
  expect(state[0].top).toMatchObject({ style: 'single', size: 12 });
});
