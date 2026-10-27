import { test, expect } from '@playwright/test';

const input = page => page.getByRole('textbox', { name: 'Document text' });
const frame = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => setTimeout(() => requestAnimationFrame(() => setTimeout(resolve)), 0))));

test('page thumbnails follow typing in a long document without painting every page at each keystroke', async ({ page }) => {
  test.setTimeout(120000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => localStorage.setItem('documents:spellcheck', 'off'));
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await page.locator('canvas.canvas-page').first().click({ position: { x: 150, y: 110 } });
  // More pages than are painted at once after each change.
  await page.evaluate(() => {
    const e = window.__docs.current.view.engine;
    e.model.select(0);
    e.execute(() => e.model.replace(Array.from({ length: 2200 }, (_, i) => `Paragraph ${i} holds a few more words to fill the line.`).join('\n')));
  });
  await expect.poll(() => page.evaluate(() => window.__docs.current.view.engine.layout.pageCount)).toBeGreaterThan(85);
  await input(page).press('ControlOrMeta+f');
  const pane = page.getByRole('complementary', { name: 'Navigation' });
  await pane.getByRole('tab', { name: 'Pages' }).click();
  const pageCount = await page.evaluate(() => window.__docs.current.view.engine.layout.pageCount);
  await expect(pane.locator('.nav-page')).toHaveCount(pageCount);
  await input(page).focus();
  await input(page).evaluate(el => { el.setSelectionRange(3, 3); el.dispatchEvent(new Event('select')); });
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    const e = window.__docs.current.view.engine, paint = e.paint;
    window.counts = { painted: 0, thumbnails: 0 };
    e.paint = function (options) { window.counts.painted += options?.pages?.length ?? e.shownPages().length; return paint.call(this, options); };
    const draw = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (...args) { if (this.canvas.closest?.('.nav-pages')) window.counts.thumbnails++; return draw.apply(this, args); };
  });
  // Each keystroke paints the pages on screen and draws their thumbnails, not the whole document's.
  for (let i = 0; i < 6; i++) { await page.keyboard.type('x'); await frame(page); }
  const counts = await page.evaluate(() => window.counts);
  expect(counts.painted).toBeLessThan(pageCount);
  expect(counts.thumbnails).toBeLessThanOrEqual(counts.painted);
  // Once typing pauses the other pages are painted, and every thumbnail shows its page.
  await expect.poll(() => page.evaluate(() => window.__docs.current.view.engine.stalePages.size), { timeout: 30000 }).toBe(0);
  await frame(page);
  const differing = await page.evaluate(() => {
    const sources = window.__docs.current.view.engine.canvases, thumbs = [...document.querySelectorAll('.nav-pages canvas')];
    return thumbs.flatMap((thumb, i) => {
      const fresh = document.createElement('canvas'); fresh.width = thumb.width; fresh.height = thumb.height;
      const ctx = fresh.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, fresh.width, fresh.height); ctx.drawImage(sources[i], 0, 0, fresh.width, fresh.height);
      const a = thumb.getContext('2d').getImageData(0, 0, thumb.width, thumb.height).data, b = ctx.getImageData(0, 0, fresh.width, fresh.height).data;
      return a.every((v, j) => v === b[j]) ? [] : [i];
    });
  });
  expect(differing).toEqual([]);
  expect(errors).toEqual([]);
});
