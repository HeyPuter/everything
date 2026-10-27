import { test, expect } from '@playwright/test';

const input = page => page.getByRole('textbox', { name: 'Document text' });
const engine = 'window.__docs.current.view.engine';

// Change bars whose ranges touch or overlap are kept as one range, so that typing on in a tracked insertion
// finds the bars where they already are. The pages must look exactly as they do with the bars as given.
test('change bars joined where their ranges touch paint the pages exactly as the separate ranges do', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await page.locator('canvas.canvas-page').first().click({ position: { x: 150, y: 110 } });
  await input(page).fill(Array.from({ length: 14 }, (_, i) => i % 4 === 1 ? '' : `Paragraph ${i} ${'has words that wrap over more than one line of the page. '.repeat(1 + i % 3)}`).join('\n'));
  // A table with empty and filled cells: its lines are laid out cell by cell.
  await page.evaluate(engine => {
    const e = eval(engine);
    e.model.select(e.model.text.indexOf('Paragraph 6'));
    e.execute(() => e.model.insertTable(3, 3, 400));
    e.relayout(); e.paint();
  }, engine);
  await page.waitForTimeout(300);
  const result = await page.evaluate(engine => {
    const e = eval(engine), length = e.model.text.length, pixels = () => e.canvases.map(c => c.toDataURL());
    let seed = 11;
    const random = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    const rounds = [];
    for (let round = 0; round < 30; round++) {
      // Ranges that touch, overlap, nest, are empty and stand alone, as tracked changes and followed edits give them.
      const ranges = [];
      for (let i = 0, at = random(40); i < 3 + random(10) && at < length; i++) {
        const end = Math.min(length, at + random(60));
        ranges.push({ start: at, end });
        at = [end, end + random(30), Math.max(0, at + random(Math.max(1, end - at)))][random(3)];
      }
      ranges.sort((a, b) => a.start - b.start);
      const side = ['left', 'right', 'outside'][round % 3];
      // The bars as given, painted without being joined.
      e.marginBars = { ranges, color: '#C4314B', side }; e.marginBarKey = null; e.paint();
      const separate = pixels();
      e.setMarginBars(ranges, '#C4314B', side); e.paint();
      rounds.push({ ranges: ranges.length, joined: e.marginBars.ranges.length, same: pixels().every((url, i) => url === separate[i]) });
    }
    // The comparison sees bars: a page with one more bar differs.
    e.setMarginBars([], '#C4314B'); e.paint();
    const bare = pixels();
    e.setMarginBars([{ start: 0, end: 1 }], '#C4314B'); e.paint();
    return { pages: e.canvases.length, tables: e.model.tables?.length || 0, rounds, barSeen: pixels()[0] !== bare[0] };
  }, engine);
  expect(result.tables).toBe(1);
  expect(result.barSeen).toBe(true);
  expect(result.rounds.every(r => r.same)).toBe(true);
  // Some rounds did join ranges.
  expect(result.rounds.some(r => r.joined < r.ranges)).toBe(true);
  expect(errors).toEqual([]);
});
