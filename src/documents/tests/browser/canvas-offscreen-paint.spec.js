import {test, expect} from '@playwright/test';

// A long document paints the pages on screen at once and the rest when they are shown, read or idle.
test.beforeEach(async ({page}) => {
  await page.setViewportSize({width: 1000, height: 800});
  await page.goto('/playground.html');
  await page.evaluate(async () => {
    // Idle painting is held back, so the test sees exactly what is painted on demand.
    window.idleTasks = []; window.requestIdleCallback = task => window.idleTasks.push(task); window.cancelIdleCallback = () => {};
    const {CanvasEditor} = await import('/src/engine/canvas-editor.js');
    const {paragraph} = await import('/src/engine/model.js');
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;overflow:auto;background:#ddd';
    document.body.replaceChildren(host);
    const words = 'The quick brown fox jumps over the lazy dog while every page stays in view. ';
    window.editor = new CanvasEditor(host, {paragraphs: Array.from({length: 1000}, (_, i) => paragraph(`Paragraph ${i}. ${words.repeat(3)}`))});
    window.editor.focus();
    window.pixels = index => window.editor.canvases[index].toDataURL();
    // What a page shows when painted again from the current layout.
    window.fresh = index => { editor.paint({pages: [index]}); return pixels(index); };
    window.painted = new Set();
    const fillText = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (...args) { window.painted.add(this.canvas); return fillText.apply(this, args); };
  });
});

test('typing repaints only the pages on screen, and a page scrolled into view is current', async ({page}) => {
  const count = await page.evaluate(() => editor.canvases.length);
  expect(count).toBeGreaterThan(80);
  await page.evaluate(() => { painted.clear(); editor.input.setSelectionRange(0, 0); editor.nativeSelection(); });
  await page.keyboard.press('Enter');
  const repainted = await page.evaluate(() => editor.canvases.filter(c => painted.has(c)).map(c => Number(c.dataset.page)));
  expect(repainted.length).toBeGreaterThan(0);
  expect(repainted.length).toBeLessThan(8);
  expect(repainted).toContain(0);
  // The new paragraph moved every following line down: scroll to the end, as the user would.
  const last = count - 1;
  expect(await page.evaluate(last => editor.stalePages.has(last), last)).toBe(true);
  await page.evaluate(last => { editor.canvases[last].scrollIntoView(); }, last);
  await expect.poll(() => page.evaluate(last => editor.stalePages.has(last), last)).toBe(false);
  expect(await page.evaluate(last => [...painted].includes(editor.canvases[last]), last)).toBe(true);
  // A page nobody looked at still answers pixel reads with current content.
  const middle = Math.floor(count / 2);
  expect(await page.evaluate(middle => editor.stalePages.has(middle), middle)).toBe(true);
  const read = await page.evaluate(middle => pixels(middle), middle);
  expect(await page.evaluate(middle => editor.stalePages.has(middle), middle)).toBe(false);
  expect(read).toBe(await page.evaluate(middle => fresh(middle), middle));
  // Idle time paints the rest, nearest first, a few pages at a time.
  await page.evaluate(() => { while (editor.stalePages.size) { const task = idleTasks.shift(); if (!task) break; task({didTimeout: false, timeRemaining: () => 10}); } });
  expect(await page.evaluate(() => editor.stalePages.size)).toBe(0);
  for (const index of [middle + 1, last - 2]) {
    const idle = await page.evaluate(index => pixels(index), index);
    expect(idle).toBe(await page.evaluate(index => fresh(index), index));
  }
});

test('moving the caret repaints only the pages on screen; a document of up to 80 pages paints every page', async ({page}) => {
  await page.evaluate(() => { editor.input.setSelectionRange(0, 0); editor.nativeSelection(); painted.clear(); });
  await page.keyboard.press('ArrowRight');
  expect(await page.evaluate(() => editor.model.selection.focus)).toBe(1);
  const moved = await page.evaluate(() => painted.size);
  expect(moved).toBeGreaterThan(0);
  expect(moved).toBeLessThan(8);
  await page.evaluate(() => editor.flushPaint());
  expect(await page.evaluate(() => editor.stalePages.size)).toBe(0);
  // Read in the same task as the paint, counting the editor's own pages only.
  const short = await page.evaluate(async () => {
    const {paragraph} = await import('/src/engine/model.js');
    const host = editor.host, Editor = editor.constructor; editor.destroy();
    window.editor = new Editor(host, {paragraphs: Array.from({length: 250}, (_, i) => paragraph(`Short ${i}. ${'Words fill the line. '.repeat(10)}`))});
    editor.focus(); painted.clear(); editor.paint();
    return {count: editor.canvases.length, painted: editor.canvases.filter(canvas => painted.has(canvas)).length, stale: editor.stalePages.size};
  });
  expect(short.count).toBeGreaterThan(12);
  expect(short.count).toBeLessThanOrEqual(80);
  expect(short.painted).toBe(short.count);
  expect(short.stale).toBe(0);
});
