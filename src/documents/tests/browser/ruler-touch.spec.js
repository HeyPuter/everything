import { test, expect } from '@playwright/test';

test.use({ viewport: { width: 768, height: 1024 }, isMobile: true, hasTouch: true });

// A fingertip lands a little off the ruler's small markers (a first-line indent is a 12 by 8 pixel triangle). It takes
// the nearest marker within reach, instead of setting a tab stop beside it; a touch clear of every marker still sets one.
async function open(page) {
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('textbox', { name: 'Document text' })).toBeAttached();
  await expect.poll(() => page.evaluate(() => !!window.__docs?.current?.view?.engine)).toBe(true);
  await page.evaluate(() => {
    const e = window.__docs.current.view.engine;
    e.model.replace('A paragraph of text that is long enough to wrap onto a second line of the page, for its indents.');
    e.relayout(); e.model.select(0); e.syncInput();
  });
  await expect(page.locator('.canvas-ruler-handle[data-kind=firstLine]')).toBeVisible();
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, radiusX: 1, radiusY: 1 }] });
  const drag = async (x, y, dx) => {
    await touch('touchStart', x, y);
    for (let i = 1; i <= 8; i++) { await touch('touchMove', x + i * dx / 8, y); await page.waitForTimeout(16); }
    await touch('touchEnd');
  };
  return drag;
}
const format = page => page.evaluate(() => { const f = window.__docs.current.view.engine.model.paragraphFormatting; return { firstLine: f.firstLine, tabs: f.tabs.length }; });

test('a finger a few pixels off the first-line indent marker drags the marker', async ({ page }) => {
  const drag = await open(page);
  const marker = await page.locator('.canvas-ruler-handle[data-kind=firstLine]').boundingBox();
  await drag(marker.x + marker.width / 2 + 5, marker.y + marker.height / 2 + 1, 40);
  await expect.poll(() => format(page)).toEqual({ firstLine: expect.any(Number), tabs: 0 });
  expect((await format(page)).firstLine).toBeGreaterThan(0);
});

test('a finger clear of every marker still sets a tab stop', async ({ page }) => {
  const drag = await open(page);
  const marker = await page.locator('.canvas-ruler-handle[data-kind=firstLine]').boundingBox();
  await drag(marker.x + 150, marker.y + marker.height / 2 + 6, 0);
  await expect.poll(async () => (await format(page)).tabs).toBe(1);
  expect((await format(page)).firstLine).toBe(0);
});
