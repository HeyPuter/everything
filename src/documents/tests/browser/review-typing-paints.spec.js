import { test, expect } from '@playwright/test';

const input = page => page.getByRole('textbox', { name: 'Document text' });
const engine = 'window.__docs.current.view.engine';
const SPELLING_KEY = 'documents:spellcheck';

test('typing in a commented document with Track Changes on paints the pages once a keystroke, as they would be painted afresh', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  // Spelling marks are painted once typing pauses; leave them out of the count.
  await page.addInitScript(key => localStorage.setItem(key, 'off'), SPELLING_KEY);
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await page.locator('canvas.canvas-page').first().click({ position: { x: 150, y: 110 } });
  await input(page).fill(Array.from({ length: 30 }, (_, i) => `Paragraph ${i} has a few words in it to fill the line.`).join('\n'));
  await page.evaluate(engine => {
    const e = eval(engine);
    for (let i = 3; i < 30; i += 4) { const at = e.model.text.indexOf(`Paragraph ${i} `); e.model.addComment({ author: 'A', text: 'Note', range: [at, at + 9] }); }
    e.relayout(); e.onChange();
  }, engine);
  await input(page).press('ControlOrMeta+Shift+e');
  await expect.poll(() => page.evaluate(engine => !!eval(engine).model.trackChanges, engine)).toBe(true);
  await input(page).evaluate(el => { el.setSelectionRange(5, 5); el.dispatchEvent(new Event('select')); });
  // The first keystroke starts the tracked insertion, whose bar the Review pane adds once it catches up.
  await page.keyboard.type('X');
  await expect.poll(() => page.evaluate(engine => eval(engine).marginBars?.ranges.length, engine)).toBe(1);
  await page.waitForTimeout(300);
  await page.evaluate(engine => {
    const e = eval(engine), paint = e.paint;
    window.paintsOnScreen = 0;
    e.paint = function (options) { if (!options?.pages) window.paintsOnScreen++; return paint.call(this, options); };
  }, engine);
  // Each further keystroke moves every comment after it and lengthens the insertion.
  for (let i = 0; i < 8; i++) {
    await page.keyboard.type('y');
    // The Review pane catches up a frame after each keystroke.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 20))));
  }
  expect(await page.evaluate(() => window.paintsOnScreen)).toBe(8);
  await page.waitForTimeout(300);
  const state = () => page.evaluate(engine => {
    const e = eval(engine);
    return { tints: e.rangeTints.map(t => [t.start, t.end, t.fill]), bars: e.marginBars.ranges.map(r => [r.start, r.end]), pixels: e.canvases[0].toDataURL() };
  }, engine);
  const typed = await state();
  expect(typed.bars).toEqual([[5, 14]]);
  expect(typed.tints[0].slice(0, 2)).toEqual([await page.evaluate(engine => eval(engine).model.text.indexOf('Paragraph 3 '), engine), await page.evaluate(engine => eval(engine).model.text.indexOf('Paragraph 3 ') + 9, engine)]);
  // The Review pane sets every tint and bar again from nothing: the page is painted the same.
  await page.evaluate(engine => {
    const e = eval(engine);
    e.setRangeTints([], 'comments'); e.setMarginBars([]);
    e.onSelection();
  }, engine);
  await expect.poll(() => page.evaluate(engine => eval(engine).marginBars.ranges.length, engine)).toBe(1);
  await page.waitForTimeout(200);
  expect(await state()).toEqual(typed);
  expect(errors).toEqual([]);
});
