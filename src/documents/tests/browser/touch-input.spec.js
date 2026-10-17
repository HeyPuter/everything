import { test, expect } from '@playwright/test';

test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 800 } });

const engineState = page => page.evaluate(() => {
  const e = window.__docs.current.view.engine;
  return { range: [...e.model.range], scroll: Math.round(e.host.scrollTop), focused: document.activeElement === e.input };
});
async function open(page) {
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('textbox', { name: 'Document text' })).toBeAttached();
  await expect.poll(() => page.evaluate(() => !!window.__docs?.current?.view?.engine)).toBe(true);
  await page.evaluate(() => {
    const e = window.__docs.current.view.engine;
    e.model.replace(Array.from({ length: 150 }, (_, i) => `Paragraph number ${i} of the long document`).join('\n'));
    e.relayout(); e.model.select(0); e.syncInput(); e.input.blur(); e.host.scrollTop = 0;
  });
  const cdp = await page.context().newCDPSession(page);
  const touch = async (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  const box = await page.locator('canvas.canvas-page').first().boundingBox();
  return { touch, box };
}

test('a finger that scrolls the pages leaves the caret and keyboard alone; a tap places the caret', async ({ page }) => {
  const { touch, box } = await open(page);
  const x = box.x + box.width / 2;
  await touch('touchStart', x, 600);
  for (let i = 1; i <= 10; i++) { await touch('touchMove', x, 600 - i * 30); await page.waitForTimeout(16); }
  await touch('touchEnd');
  await expect.poll(async () => (await engineState(page)).scroll).toBeGreaterThan(100);
  expect(await engineState(page)).toMatchObject({ range: [0, 0], focused: false });
  await page.touchscreen.tap(x, 400);
  await expect.poll(async () => (await engineState(page)).focused).toBe(true);
  expect((await engineState(page)).range[0]).toBeGreaterThan(0);
});

test('a sideways finger drag selects text from where it went down', async ({ page }) => {
  const { touch, box } = await open(page);
  const y = box.y + 70;
  await touch('touchStart', box.x + 60, y);
  for (let i = 1; i <= 8; i++) { await touch('touchMove', box.x + 60 + i * 20, y); await page.waitForTimeout(16); }
  await touch('touchEnd');
  const { range, focused } = await engineState(page);
  expect(focused).toBe(true);
  expect(range[1] - range[0]).toBeGreaterThan(3);
});
