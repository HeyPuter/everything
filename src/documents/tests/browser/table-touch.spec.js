import { test, expect } from '@playwright/test';

test.use({ viewport: { width: 768, height: 1024 }, isMobile: true, hasTouch: true });

// A finger drags a table's borders: a row border down (the pages, which scroll under a finger, hold still while it
// does), and a column border it lands a few pixels beside. A tap beside a border places the caret, as on any text.
async function open(page) {
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('textbox', { name: 'Document text' })).toBeAttached();
  await expect.poll(() => page.evaluate(() => !!window.__docs?.current?.view?.engine)).toBe(true);
  await page.evaluate(() => {
    const e = window.__docs.current.view.engine;
    e.model.replace(['Intro', ...Array.from({ length: 80 }, (_, i) => `Paragraph ${i} below the table`)].join('\n'));
    e.relayout(); e.model.select(5); e.insertTable(3, 3); e.input.blur(); e.host.scrollTop = 0;
  });
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, radiusX: 1, radiusY: 1 }] });
  const drag = async (x, y, dx, dy) => {
    await touch('touchStart', x, y);
    for (let i = 1; i <= 8; i++) { await touch('touchMove', x + i * dx / 8, y + i * dy / 8); await page.waitForTimeout(16); }
    await touch('touchEnd');
  };
  const cell = await page.evaluate(() => {
    const e = window.__docs.current.view.engine, id = e.model.tables[0].rows[1].cells[0].id;
    const box = e.selectionLayout.cells.find(c => c.id === id), r = e.canvases[box.page].getBoundingClientRect();
    return { x: r.left + box.x * e.zoom, y: r.top + box.y * e.zoom, w: box.width * e.zoom, h: box.height * e.zoom };
  });
  return { drag, cell };
}
const table = page => page.evaluate(() => {
  const e = window.__docs.current.view.engine, t = e.model.tables[0];
  return { grid: [...t.grid], heights: t.rows.map(r => r.minHeight || 0), top: Math.round(e.host.scrollTop), range: [...e.model.range] };
});

test('a finger drags a row border down without scrolling the pages', async ({ page }) => {
  const { drag, cell } = await open(page);
  const before = await table(page);
  await drag(cell.x + cell.w / 2, cell.y + cell.h, 0, 60);
  const after = await table(page);
  expect(after.heights[1]).toBeGreaterThan(0);
  expect(after.top).toBe(before.top);
});

test('a finger a few pixels beside a column border drags it, and a tap there places the caret', async ({ page }) => {
  const { drag, cell } = await open(page);
  const before = await table(page);
  await drag(cell.x + cell.w + 6, cell.y + cell.h / 2, 50, 0);
  const after = await table(page);
  expect(after.grid[0]).toBeGreaterThan(before.grid[0]);
  // A tap beside the border moves the caret into the cell, and the keyboard comes up.
  await page.touchscreen.tap(cell.x + cell.w - 4 + (after.grid[0] - before.grid[0]) / 15 * await page.evaluate(() => window.__docs.current.view.engine.zoom), cell.y + cell.h / 2);
  await expect.poll(() => page.evaluate(() => document.activeElement === window.__docs.current.view.engine.input)).toBe(true);
  expect((await table(page)).range[0]).not.toBe(before.range[0]);
});

test('a finger inside a cell still scrolls the pages', async ({ page }) => {
  const { drag, cell } = await open(page);
  await drag(cell.x + cell.w / 2, cell.y + cell.h / 2 + 300, 0, -250);
  await expect.poll(async () => (await table(page)).top).toBeGreaterThan(50);
});

test.describe('with the whole ribbon showing', () => {
  test.use({ viewport: { width: 1400, height: 900 }, isMobile: false, hasTouch: true });
  // Draw Table divides a cell where a finger draws down it; the pages used to take the stroke as a scroll.
  test('a finger draws a line down a cell with Draw Table', async ({ page }) => {
    const { drag } = await open(page);
    await page.evaluate(() => { const e = window.__docs.current.view.engine; e.model.select(7); e.syncInput(); e.onSelection?.(); });
    await page.locator('[role=tab]', { hasText: 'Table Layout' }).first().tap();
    await page.getByRole('button', { name: 'Draw Table', exact: true }).first().tap();
    await expect(page.locator('.canvas-pages')).toHaveAttribute('data-table-cursor', 'crosshair');
    const top = await page.evaluate(() => { const e = window.__docs.current.view.engine, id = e.model.tables[0].rows[0].cells[0].id; const box = e.selectionLayout.cells.find(c => c.id === id), r = e.canvases[box.page].getBoundingClientRect(); return { x: r.left + (box.x + box.width / 2) * e.zoom, y: r.top + box.y * e.zoom + 2, h: box.height * e.zoom - 4 }; });
    await drag(top.x, top.y, 0, top.h);
    await expect.poll(() => page.evaluate(() => window.__docs.current.view.engine.model.tables[0].rows[0].cells.length)).toBe(4);
  });
});
