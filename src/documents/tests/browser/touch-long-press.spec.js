import { test, expect } from '@playwright/test';

test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 800 } });

// A finger held still on the text opens the context menu, as a right-click does, in every touch browser (Safari on
// iPhone and iPad reports no contextmenu event for a long press). Lifting that finger chooses nothing.
async function open(page) {
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('textbox', { name: 'Document text' })).toBeAttached();
  await expect.poll(() => page.evaluate(() => !!window.__docs?.current?.view?.engine)).toBe(true);
  await page.evaluate(() => {
    const e = window.__docs.current.view.engine;
    e.model.replace(Array.from({ length: 40 }, (_, i) => `Paragraph number ${i} of the long document`).join('\n'));
    e.relayout(); e.model.select(0); e.syncInput(); e.input.blur(); e.host.scrollTop = 0;
  });
  const cdp = await page.context().newCDPSession(page);
  return (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
}
const text = page => page.evaluate(() => window.__docs.current.view.engine.model.text);
const menu = page => page.getByRole('menu', { name: 'Document menu' });

test('a long press opens the document menu, which stays open with nothing chosen when the finger lifts', async ({ page }) => {
  const touch = await open(page);
  const before = await text(page);
  await touch('touchStart', 150, 300);
  await expect(menu(page)).toBeVisible();
  // The browser's own long-press menu, where it sends one, does not open it a second time.
  await page.evaluate(() => document.elementFromPoint(150, 300).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 150, clientY: 300 })));
  await touch('touchEnd');
  await page.waitForTimeout(300);
  await expect(menu(page)).toBeVisible();
  await expect(menu(page)).toHaveCount(1);
  expect(await text(page)).toBe(before);
  const box = await menu(page).boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  // A tap then chooses an item.
  await menu(page).getByRole('menuitem', { name: /^Paragraph/ }).tap();
  await expect(page.getByRole('dialog', { name: 'Paragraph' })).toBeVisible();
});

test('a quick tap or a held scroll opens no menu', async ({ page }) => {
  const touch = await open(page);
  await touch('touchStart', 150, 300);
  await page.waitForTimeout(100);
  await touch('touchEnd');
  await page.waitForTimeout(700);
  await expect(menu(page)).toHaveCount(0);
  await page.evaluate(() => window.__docs.current.view.engine.input.blur());
  await touch('touchStart', 150, 500);
  for (let i = 1; i <= 6; i++) { await touch('touchMove', 150, 500 - i * 30); await page.waitForTimeout(16); }
  await page.waitForTimeout(800);
  await touch('touchEnd');
  await expect(menu(page)).toHaveCount(0);
});
