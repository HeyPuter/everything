import { test, expect } from '@playwright/test';

// Side to Side with Thumbnails drew every thumbnail again after each keystroke, and painted every page
// of the document first to draw them from. Typing in a long document now paints the pages on screen
// and draws their thumbnails; the other pages, and their thumbnails, follow once typing pauses.
const input = page => page.getByRole('textbox', { name: 'Document text' });
const frame = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => setTimeout(() => requestAnimationFrame(() => setTimeout(resolve)), 0))));

test('side-to-side thumbnails follow typing in a long document without painting every page at each keystroke', async ({ page }) => {
  test.setTimeout(120000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => localStorage.setItem('documents:spellcheck', 'off'));
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await page.locator('canvas.canvas-page').first().click({ position: { x: 150, y: 110 } });
  await page.evaluate(() => {
    const e = window.__docs.current.view.engine;
    e.model.select(0);
    e.execute(() => e.model.replace(Array.from({ length: 2200 }, (_, i) => `Paragraph ${i} holds a few more words to fill the line.`).join('\n')));
  });
  await expect.poll(() => page.evaluate(() => window.__docs.current.view.engine.layout.pageCount)).toBeGreaterThan(85);
  await page.locator('#ribbon-tab-view').click();
  await page.locator('.ribbon-card').getByRole('button', { name: 'Side to Side', exact: true }).click();
  await page.locator('.ribbon-card').getByRole('button', { name: 'Thumbnails', exact: true }).click();
  const pageCount = await page.evaluate(() => window.__docs.current.view.engine.layout.pageCount);
  const strip = page.getByRole('list', { name: 'Page thumbnails' });
  await expect(strip.getByRole('listitem')).toHaveCount(pageCount);
  await input(page).focus();
  await input(page).evaluate(el => { el.setSelectionRange(3, 3); el.dispatchEvent(new Event('select')); });
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    const e = window.__docs.current.view.engine, paint = e.paint;
    window.counts = { painted: 0, thumbnails: 0, sized: 0 };
    e.paint = function (options) { window.counts.painted += options?.pages?.length ?? e.shownPages().length; return paint.call(this, options); };
    const draw = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (...args) { if (this.canvas.closest?.('.view-thumbnails')) window.counts.thumbnails++; return draw.apply(this, args); };
    const width = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'width');
    Object.defineProperty(HTMLCanvasElement.prototype, 'width', { configurable: true, get: width.get, set(value) { if (this.closest?.('.view-thumbnails')) window.counts.sized++; width.set.call(this, value); } });
  });
  // Each keystroke paints the pages on screen and draws their thumbnails, not the whole document's.
  for (let i = 0; i < 6; i++) { await page.keyboard.type('x'); await frame(page); await page.waitForTimeout(150); }
  const counts = await page.evaluate(() => window.counts);
  expect(counts.painted).toBeLessThan(pageCount);
  expect(counts.thumbnails).toBeGreaterThan(0);
  expect(counts.thumbnails).toBeLessThanOrEqual(counts.painted);
  expect(counts.sized).toBeLessThanOrEqual(counts.thumbnails);
  // Once typing pauses the other pages are painted, and every thumbnail shows its page.
  await expect.poll(() => page.evaluate(() => window.__docs.current.view.engine.stalePages.size), { timeout: 30000 }).toBe(0);
  await page.waitForTimeout(300);
  const result = await page.evaluate(() => {
    const engine = window.__docs.current.view.engine, sources = engine.canvases, thumbs = [...document.querySelectorAll('.view-thumbnails canvas')];
    const differing = thumbs.flatMap((thumb, i) => {
      const fresh = document.createElement('canvas'); fresh.width = thumb.width; fresh.height = thumb.height;
      const ctx = fresh.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, fresh.width, fresh.height); ctx.drawImage(sources[i], 0, 0, fresh.width, fresh.height);
      const a = thumb.getContext('2d').getImageData(0, 0, thumb.width, thumb.height).data, b = ctx.getImageData(0, 0, fresh.width, fresh.height).data;
      return a.every((v, j) => v === b[j]) ? [] : [i];
    });
    const current = [...document.querySelectorAll('.view-thumb[aria-current="page"]')].map(b => Number(b.dataset.index));
    return { differing, count: thumbs.length, pages: sources.length, current, caretPage: engine.caretPageIndex ?? 0 };
  });
  expect(result.differing).toEqual([]);
  expect(result.count).toBe(result.pages);
  expect(result.current).toEqual([result.caretPage]);
  expect(errors).toEqual([]);
});
