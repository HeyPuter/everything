import { test, expect } from '@playwright/test';

const input = page => page.getByRole('textbox', { name: 'Document text' });
const engine = 'window.__docs.current.view.engine';
const SPELLING_KEY = 'documents:spellcheck';

// Next Change and Next Comment gave the document the keyboard, which painted the pages, and then painted them
// again once the view had moved to the change or comment. They now paint once, after the view has moved, and
// leave the pages, the view and the keyboard exactly as a fresh paint of the same state would.
test('Next Change, Accept and Next Comment paint the pages once for the selection they make', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(key => localStorage.setItem(key, 'off'), SPELLING_KEY);
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await page.locator('canvas.canvas-page').first().click({ position: { x: 150, y: 110 } });
  await input(page).fill(Array.from({ length: 120 }, (_, i) => `Paragraph ${i} has a few words in it to fill the line and then some more.`).join('\n'));
  await page.evaluate(engine => {
    const e = eval(engine);
    for (let i = 5; i < 120; i += 20) { const at = e.model.text.indexOf(`Paragraph ${i} `); e.model.addComment({ author: 'A', text: 'Note', range: [at, at + 9] }); }
    e.relayout(); e.onChange();
  }, engine);
  // Tracked insertions here and there.
  await input(page).press('ControlOrMeta+Shift+e');
  await expect.poll(() => page.evaluate(engine => !!eval(engine).model.trackChanges, engine)).toBe(true);
  for (const i of [10, 40, 70, 100]) {
    const at = await page.evaluate(([engine, i]) => eval(engine).model.text.indexOf(`Paragraph ${i} `), [engine, i]);
    await input(page).evaluate((el, at) => { el.setSelectionRange(at, at); el.dispatchEvent(new Event('select')); }, at);
    await page.keyboard.type('New ');
  }
  await input(page).evaluate(el => { el.setSelectionRange(0, 0); el.dispatchEvent(new Event('select')); });
  await page.getByRole('tab', { name: 'Review' }).click();
  await page.waitForTimeout(400);
  await page.evaluate(engine => {
    const e = eval(engine), paint = e.paint;
    window.paints = 0;
    e.paint = function (options) { if (!options?.pages) window.paints++; return paint.call(this, options); };
  }, engine);
  const state = () => page.evaluate(engine => {
    const e = eval(engine);
    e.flushPaint();
    return { range: e.model.range, scroll: e.host.scrollTop, focused: document.activeElement === e.input, field: [e.input.selectionStart, e.input.selectionEnd], pixels: e.canvases.map(c => c.toDataURL()) };
  }, engine);
  const fresh = () => page.evaluate(engine => { const e = eval(engine); e.paint(); e.flushPaint(); window.paints--; return e.canvases.map(c => c.toDataURL()); }, engine);
  for (const [button, paints] of [['Next Change', 1], ['Next Change', 1], ['Accept', 3], ['Next Comment', 2], ['Next Comment', 2]]) {
    await page.evaluate(() => { window.paints = 0; });
    await page.getByRole('button', { name: button, exact: true }).first().evaluate(b => b.click());
    await page.waitForTimeout(300);
    // Accept lays the document out again; Next Comment tints the comment it goes to. Neither paints twice for the selection.
    expect(await page.evaluate(() => window.paints), button).toBe(paints);
    const shown = await state();
    expect(shown.focused).toBe(true);
    expect(shown.field).toEqual(shown.range);
    expect(shown.range[1]).toBeGreaterThan(shown.range[0]);
    expect(await fresh()).toEqual(shown.pixels);
  }
  expect(errors).toEqual([]);
});
