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

test('a row of exact height stays exact when its border is dragged or its height typed', async ({ page }) => {
  await newTable(page, 2, 2);
  // Row 1 at exactly 0.5 in (Table Properties > Row > Exactly).
  await page.evaluate(() => {
    const e = window.__docs.current.view.engine, row = e.model.tables[0].rows[0];
    e.execute(() => { Object.assign(row, { heightRule: 'exact', minHeight: 720, heightExplicit: true, heightChanged: true }); e.model.didChange(); return true; });
  });
  const box = (await cells(page))[0];
  const rowBottom = { x: box[0].x + box[0].w / 2, y: box[0].y + box[0].h };
  await drag(page, rowBottom, { x: rowBottom.x, y: rowBottom.y + 30 });
  let row = (await tables(page))[0].rows[0];
  expect(row).toMatchObject({ rule: 'exact', explicit: true });
  expect(row.height).toBeGreaterThan(720 + 20 * 15);
  // The Height box on Table Layout keeps the rule too; a row without one becomes at least that tall.
  await page.evaluate(() => { const e = window.__docs.current.view.engine; e.model.setCellBlock({ tableId: e.model.tables[0].id, top: 0, bottom: 1, left: 0, right: 2 }); e.syncInput(); e.paint(); e.onSelection(); e.focus(); });
  await onTab(page, 'tableLayout');
  const height = page.locator('#ribbon-panel-tableLayout').getByRole('spinbutton', { name: 'Height (in)', exact: true });
  await height.fill('0.8'); await height.press('Enter');
  const rows = (await tables(page))[0].rows;
  expect(rows[0]).toMatchObject({ rule: 'exact', height: 1152 });
  expect(rows[1]).toMatchObject({ rule: 'atLeast', height: 1152 });
});

test('dragging the border of a row that breaks across pages draws its guide at the pointer on each page', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1300 });
  await newTable(page, 2, 2);
  await page.evaluate(() => {
    const e = window.__docs.current.view.engine, t = e.model.tables[0];
    e.execute(() => { e.model.selectCell(t.rows[0].cells[0].id); e.model.replace(Array.from({ length: 70 }, (_, i) => `Line ${i}`).join('\n')); });
  });
  // The client rectangle of the first row's part on a page, scrolled into view.
  const part = p => page.evaluate(p => {
    const e = window.__docs.current.view.engine, row = e.model.tables[0].rows[0];
    e.canvases[p].scrollIntoView({ block: 'center' });
    const box = e.selectionLayout.cells.find(c => c.rowId === row.id && c.page === p), r = e.canvases[p].getBoundingClientRect();
    return { x: r.left + box.x * e.zoom, y: r.top + box.y * e.zoom, w: box.width * e.zoom, h: box.height * e.zoom };
  }, p);
  // The client y of each line of the page's canvas that the dashed accent-blue guide crosses.
  const guide = p => page.evaluate(p => {
    const c = window.__docs.current.view.engine.canvases[p], r = c.getBoundingClientRect(), data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data, found = [];
    for (let y = 0; y < c.height; y++) {
      let blue = 0; for (let x = 0; x < c.width; x++) { const i = (y * c.width + x) * 4; if (data[i + 2] - data[i] > 50) blue++; }
      if (blue > 100) found.push(Math.round(r.top + y * r.height / c.height));
    }
    return found;
  }, p);
  expect(await page.evaluate(() => new Set(window.__docs.current.view.engine.selectionLayout.cells.filter(c => c.rowId === window.__docs.current.view.engine.model.tables[0].rows[0].id).map(c => c.page)).size)).toBeGreaterThan(1);
  for (const p of [0, 1]) {
    await part(p); await page.waitForTimeout(100);
    const box = await part(p), border = { x: box.x + box.w / 2, y: box.y + box.h };
    await page.mouse.move(border.x, border.y - 30); await page.mouse.move(border.x, border.y);
    await expect(page.locator('.canvas-pages')).toHaveAttribute('data-table-cursor', 'row-resize');
    await page.mouse.down(); await page.mouse.move(border.x, border.y - 20, { steps: 4 });
    await expect.poll(() => guide(p)).toEqual([Math.round(border.y - 20)]);
    await page.keyboard.press('Escape'); await page.mouse.up();
  }
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

test('a press left of a row, just above a column or just inside a cell’s left edge selects it, and a drag selects more', async ({ page }) => {
  await newTable(page, 3, 3);
  const box = await cells(page), cursor = () => page.locator('.canvas-pages').getAttribute('data-table-cursor');
  const press = async (x, y, kind) => {
    await page.mouse.move(x, y);
    await expect.poll(cursor).toBe(kind);
    await page.mouse.down(); await page.mouse.up();
  };
  // Beside the middle of row 2 (its lines are the + marks' places).
  await press(box[1][0].x - 12, box[1][0].y + box[1][0].h / 2, 'select-row');
  expect(await block(page)).toEqual([1, 1, 0, 3]);
  await press(box[0][1].x + box[0][1].w / 2, box[0][1].y - 6, 'select-column');
  expect(await block(page)).toEqual([0, 2, 1, 2]);
  await press(box[2][1].x + 6, box[2][1].y + box[2][1].h / 2, 'select-cell');
  expect(await block(page)).toEqual([2, 2, 1, 2]);
  await press(box[1][0].x + 3, box[1][0].y + box[1][0].h / 2, 'select-cell');
  expect(await block(page)).toEqual([1, 1, 0, 1]);
  // The borders, the + marks and the text keep their own presses.
  await page.mouse.move(box[1][1].x + 1, box[1][1].y + box[1][1].h / 2);
  await expect.poll(cursor).toBe('col-resize');
  await page.mouse.move(box[1][0].x - 12, box[1][0].y);
  await expect.poll(cursor).toBe('pointer');
  await page.mouse.move(box[1][1].x + 20, box[1][1].y + box[1][1].h / 2);
  await expect.poll(cursor).toBe(null);
  await page.mouse.down(); await page.mouse.up();
  expect(await block(page)).toBe(null);
  // Dragging down the rows' bar, along the columns' or across cells selects every one passed.
  await drag(page, { x: box[0][0].x - 12, y: box[0][0].y + box[0][0].h / 2 }, { x: box[1][0].x - 12, y: box[1][0].y + box[1][0].h / 2 });
  expect(await block(page)).toEqual([0, 1, 0, 3]);
  await drag(page, { x: box[0][2].x + box[0][2].w / 2, y: box[0][2].y - 6 }, { x: box[0][1].x + box[0][1].w / 2, y: box[0][1].y - 6 });
  expect(await block(page)).toEqual([0, 2, 1, 3]);
  await drag(page, { x: box[0][1].x + 6, y: box[0][1].y + 8 }, { x: box[1][2].x + 30, y: box[1][2].y + 8 });
  expect(await block(page)).toEqual([0, 1, 1, 3]);
  expect((await tables(page))[0].rows).toHaveLength(3);
});

test('beside a table nested in a cell, the outer column line still resizes rather than selecting a nested row', async ({ page }) => {
  await newTable(page, 2, 2);
  await page.evaluate(() => {
    const e = window.__docs.current.view.engine, m = e.model, t = m.tables[0];
    e.execute(() => { m.selectCell(t.rows[0].cells[1].id); return m.insertTable(3, 2, 3000); });
  });
  const geometry = await page.evaluate(() => {
    const e = window.__docs.current.view.engine, m = e.model, outer = m.tables.find(t => !t.parentCellId), inner = m.tables.find(t => t.parentCellId);
    const box = id => { const b = e.selectionLayout.cells.find(c => c.id === id), r = e.canvases[b.page].getBoundingClientRect(); return { x: r.left + b.x * e.zoom, y: r.top + b.y * e.zoom, h: b.height * e.zoom }; };
    return { line: box(outer.rows[0].cells[1].id).x, inner: box(inner.rows[1].cells[0].id) };
  });
  const cursor = () => page.locator('.canvas-pages').getAttribute('data-table-cursor'), y = geometry.inner.y + geometry.inner.h / 2;
  await page.mouse.move(geometry.line + 1, y);
  await expect.poll(cursor).toBe('col-resize');
  // Just inside the outer cell, before the nested table, a press selects the outer cell.
  await page.mouse.move(geometry.line + 5, y);
  await expect.poll(cursor).toBe('select-cell');
});

test('a press on the text just above a table places the caret there rather than inserting a column', async ({ page }) => {
  await newTable(page, 3, 2);
  // The intro runs past the first column line, so its text lies over the strip where the column + marks show.
  await input(page).evaluate(el => { el.setSelectionRange(5, 5); el.dispatchEvent(new Event('select', { bubbles: true })); });
  await page.keyboard.type(' paragraph that runs well across the page');
  const point = await page.evaluate(() => {
    const e = window.__docs.current.view.engine, table = e.model.tables[0], first = e.selectionLayout.cells.find(c => c.id === table.rows[0].cells[0].id);
    const line = e.selectionLayout.lines.filter(l => !l.cellId && l.page === first.page && l.y < first.y).at(-1);
    const r = e.canvases[first.page].getBoundingClientRect(), x = first.x + first.width;
    // On the line's text, inside the strip 3 to 20 page units above the table.
    const y = Math.min(line.y + line.height - 1, first.y - 4);
    return { x: r.left + x * e.zoom, y: r.top + y * e.zoom, inStrip: y >= first.y - 20 && y < first.y - 3, onText: x > line.stops[0].x && x < line.stops.at(-1).x, length: e.model.paragraphs[0].runs.map(run => run.text).join('').length };
  });
  expect(point).toMatchObject({ inStrip: true, onText: true });
  await page.mouse.move(point.x, point.y);
  await expect(page.locator('.canvas-pages')).not.toHaveAttribute('data-table-cursor', 'pointer');
  await page.mouse.click(point.x, point.y);
  expect((await tables(page))[0].grid).toHaveLength(3);
  const caret = await input(page).evaluate(el => [el.selectionStart, el.selectionEnd]);
  expect(caret[0]).toBe(caret[1]); expect(caret[0]).toBeGreaterThan(0); expect(caret[0]).toBeLessThanOrEqual(point.length);
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

test('a block of cells formats every cell, and typing replaces only its first cell', async ({ page }) => {
  await newTable(page, 3, 2);
  // From X1 (row 0, column 1) to X5 (row 1, column 2): a 2 × 2 block, not the X3 cell between them in reading order.
  await input(page).evaluate(el => { el.setSelectionRange(el.value.indexOf('X1'), el.value.indexOf('X5') + 1); el.dispatchEvent(new Event('select', { bubbles: true })); });
  await expect.poll(() => block(page)).toEqual([0, 1, 1, 3]);
  await page.keyboard.press('ControlOrMeta+b');
  const bold = await page.evaluate(() => { const m = window.__docs.current.view.engine.model; return Object.fromEntries(m.paragraphs.filter(p => p.cellId).map(p => [p.runs.map(r => r.text).join(''), !!p.runs[0]?.bold])); });
  expect(bold).toMatchObject({ X0: false, X1: true, X2: true, X3: false, X4: true, X5: true });
  await page.keyboard.type('Z');
  await expect(input(page)).toHaveValue(/\nX0\nZ\nX2\nX3\nX4\nX5\n/);
});

test('a ruler marker drag the browser cancels leaves the columns as they were and the borders answering the pointer', async ({ page }) => {
  await newTable(page, 3, 2);
  await expect(page.locator('.table-ruler-marker')).toHaveCount(4);
  const result = await page.evaluate(async () => {
    // Synthetic pointers have no capture to set; a real finger's drag is cancelled when it turns into a scroll.
    Element.prototype.setPointerCapture = () => {};
    const marker = document.querySelectorAll('.table-ruler-marker')[1], b = marker.getBoundingClientRect();
    const touch = { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'touch', button: 0, clientX: b.x + 4, clientY: b.y + 4, isPrimary: true };
    marker.dispatchEvent(new PointerEvent('pointerdown', touch));
    marker.dispatchEvent(new PointerEvent('pointermove', { ...touch, clientX: b.x + 40 }));
    marker.dispatchEvent(new PointerEvent('pointercancel', touch));
    await new Promise(r => setTimeout(r, 100));
    const e = window.__docs.current.view.engine, table = e.model.tables[0], cell = e.selectionLayout.cells.find(c => c.id === table.rows[1].cells[0].id);
    const r = e.canvases[cell.page].getBoundingClientRect();
    e.canvases[cell.page].dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse', clientX: r.left + (cell.x + cell.width) * e.zoom, clientY: r.top + (cell.y + cell.height / 2) * e.zoom }));
    return { grid: [...table.grid], dragging: document.querySelectorAll('.table-ruler-marker.is-dragging').length };
  });
  expect(result).toEqual({ grid: (await tables(page))[0].grid, dragging: 0 });
  expect(new Set(result.grid).size).toBe(1);
  await expect(page.locator('.canvas-pages')).toHaveAttribute('data-table-cursor', 'col-resize');
});

test('Escape while dragging a column border puts the border back', async ({ page }) => {
  await newTable(page, 3, 2);
  const before = await tables(page), box = (await cells(page))[0];
  const border = { x: box[0].x + box[0].w, y: box[0].y + box[0].h / 2 };
  const text = await input(page).inputValue();
  await page.mouse.move(border.x, border.y); await page.mouse.down();
  await page.mouse.move(border.x + 60, border.y, { steps: 6 });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  expect(await tables(page)).toEqual(before);
  await expect(input(page)).toHaveValue(text);
  // The next drag still resizes.
  await drag(page, border, { x: border.x + 60, y: border.y });
  expect((await tables(page))[0].grid[0]).toBeGreaterThan(before[0].grid[0]);
});
