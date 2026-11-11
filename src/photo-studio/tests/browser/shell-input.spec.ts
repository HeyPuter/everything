// Workspace chrome driven from the keyboard and touch: context menus, panel
// menus and canvas gestures.
import { test, expect } from '@playwright/test';
import { boot, idle, openImage } from './helpers';

test.beforeEach(async ({ page }) => {
  await boot(page);
  await openImage(page, 240, 160, '#808080', 'shell.png');
});

test('context menus work from the keyboard and keep keys away from the canvas', async ({ page }) => {
  await page.evaluate(() => window.photoStudio.setTool('move'));
  const viewport = page.locator('#viewport');
  const box = (await viewport.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
  const menu = page.locator('.context-menu');
  await expect(menu).toBeVisible();
  const focused = () => page.evaluate(() => document.activeElement?.querySelector('.menu-label')?.textContent ?? document.activeElement?.id);
  const first = await focused();
  const before = await page.evaluate(() => window.photoStudio.doc);
  await page.keyboard.press('ArrowDown');
  expect(await focused()).not.toBe(first);
  await page.keyboard.press('ArrowUp');
  expect(await focused()).toBe(first);
  await page.keyboard.press('End');
  expect(await focused()).not.toBe(first);
  await page.keyboard.press('Home');
  expect(await focused()).toBe(first);
  // The arrows moved the focus, not the layer (the Move tool nudges with arrows).
  expect(await page.evaluate((doc) => JSON.stringify(window.photoStudio.doc.layers) === JSON.stringify(doc.layers), before)).toBe(true);
  // Escape closes the menu and gives the focus back to the canvas.
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  expect(await page.evaluate(() => document.activeElement?.id)).toBe('viewport');
  // Enter runs the focused command (Select → All, the first item without a selection).
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
  await expect(menu).toBeVisible();
  expect(await page.evaluate(() => document.activeElement?.getAttribute('data-command'))).toBe('select.all');
  await page.keyboard.press('Enter');
  await expect(menu).toHaveCount(0);
  await idle(page);
  expect(await page.evaluate(() => window.photoStudio.doc.selection)).toEqual({ x: 0, y: 0, width: 240, height: 160 });
});

test('a panel menu opened from the keyboard can be navigated and used', async ({ page }) => {
  const button = page.locator('[data-panel-menu]').first();
  await button.focus();
  await page.keyboard.press('Enter');
  const menu = page.locator('.context-menu');
  await expect(menu).toBeVisible();
  const items = menu.locator(':scope > .menu-item');
  await expect(items.first()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(items.nth(1)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(button).toBeFocused();
});

test('two fingers pinch to zoom and pan without painting; one finger still paints', async ({ page }) => {
  await page.evaluate(() => window.photoStudio.setTool('brush'));
  await idle(page);
  const box = (await page.locator('#viewport').boundingBox())!;
  const cx = box.x + box.width / 2,
    cy = box.y + box.height / 2;
  const cdp = await page.context().newCDPSession(page);
  const touch = (type: string, points: [number, number][]) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });
  const zoom = await page.evaluate(() => window.photoStudio.zoom);
  // Two fingers land and spread to twice their distance.
  await touch('touchStart', [[cx - 40, cy], [cx + 40, cy]]);
  for (let i = 1; i <= 8; i++) await touch('touchMove', [[cx - 40 - i * 5, cy + i * 2], [cx + 40 + i * 5, cy + i * 2]]);
  await touch('touchEnd', []);
  await idle(page);
  expect(await page.evaluate(() => window.photoStudio.history.labels)).toEqual([]);
  expect(await page.evaluate(() => window.photoStudio.zoom)).toBeCloseTo(zoom * 2, 2);
  // The document point under the fingers' midpoint moved with it (16 px down).
  const [, y] = await page.evaluate(([x, y]) => window.photoStudio.docPoint(x, y), [cx, cy + 16]);
  const [, y0] = await page.evaluate(([x, y]) => window.photoStudio.docPoint(x, y), [cx, cy]);
  expect(y - y0).toBeCloseTo(16 / (zoom * 2), 3);
  // A one-finger drag is a brush stroke.
  await touch('touchStart', [[cx, cy]]);
  for (let i = 1; i <= 5; i++) await touch('touchMove', [[cx + i * 8, cy]]);
  await touch('touchEnd', []);
  await idle(page);
  expect(await page.evaluate(() => window.photoStudio.history.labels)).toEqual(['Brush Tool']);
});
