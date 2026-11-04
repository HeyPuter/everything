import { test, expect } from '@playwright/test';

test.use({ viewport: { width: 768, height: 1024 }, isMobile: true, hasTouch: true });

// Insert > Shapes asks for a drag on the page. A finger drawing a tall shape went mostly downwards, which the pages
// took as a scroll: the drag was cancelled and no shape came. The pages hold still while a shape is drawn.
test('a finger draws a tall shape with a mostly downward drag', async ({ page }) => {
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('textbox', { name: 'Document text' })).toBeAttached();
  await expect.poll(() => page.evaluate(() => !!window.__docs?.current?.view?.engine)).toBe(true);
  await page.evaluate(() => {
    const e = window.__docs.current.view.engine;
    e.model.replace(Array.from({ length: 60 }, (_, i) => `Paragraph ${i} of text.`).join('\n'));
    e.relayout(); e.model.select(0); e.syncInput();
  });
  await page.locator('#ribbon-tab-insert').tap();
  await page.locator('#ribbon-panel-insert').getByRole('button', { name: 'Shapes', exact: true }).tap();
  await page.getByRole('menuitem', { name: 'Rectangle', exact: true }).tap();
  const objects = () => page.evaluate(() => (window.__docs.current.view.engine.model.text.match(/￼/g) || []).length);
  expect(await objects()).toBe(0);
  const box = await page.locator('canvas.canvas-page').first().boundingBox();
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, radiusX: 1, radiusY: 1 }] });
  const [x, y] = [box.x + 200, box.y + 300];
  await touch('touchStart', x, y);
  for (let i = 1; i <= 10; i++) { await touch('touchMove', x + i * 4, y + i * 15); await page.waitForTimeout(16); }
  await touch('touchEnd');
  await expect.poll(objects).toBe(1);
  expect(await page.evaluate(() => window.__docs.current.view.engine.host.scrollTop)).toBe(0);
});
