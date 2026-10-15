// Window and screen framework: area split / join / swap, header regions, fullscreen, workspaces,
// top bar menus, and the Text Editor, Console, Info and File Browser editors.
import { test, expect, type Page } from '@playwright/test';
import { openApp, expectNoErrors } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
const get = (page: Page, expr: string) => page.evaluate(`(() => { const app = window.app; return ${expr}; })()`);
const areaCount = (page: Page) => page.locator('.screen > .area:visible').count();
const areaBox = async (page: Page, editor: string, i = 0) => (await page.locator(`.area[data-editor="${editor}"]`).nth(i).boundingBox())!;

test('header context menu: collapse menus, hide and restore the header', async ({ page }) => {
  const errors = await openApp(page);
  const v = await areaBox(page, 'VIEW_3D');
  const hdr = page.locator('.area[data-editor="VIEW_3D"] .area-header');
  await page.mouse.move(v.x + 300, v.y + 12);
  await page.mouse.click(v.x + 300, v.y + 12, { button: 'right' });
  await expect(page.locator('.menu .menu-item', { hasText: 'Show Menus' })).toBeVisible();
  await page.locator('.menu .menu-item', { hasText: 'Show Menus' }).click();
  await expect(hdr.locator('.hdr-menu').first()).toBeHidden();
  await hdr.locator('.hdr-collapsed-menus').dispatchEvent('pointerdown');
  await expect(page.locator('.menu .menu-item', { hasText: 'Object' }).first()).toBeVisible();
  await page.locator('.menu .menu-item', { hasText: 'View' }).first().hover();
  await expect(page.locator('.menu .menu-item', { hasText: 'Sidebar' }).first()).toBeVisible();
  await page.keyboard.press('Escape');
  // hide the header, then bring it back with the reveal tab
  await page.mouse.click(v.x + 300, v.y + 12, { button: 'right' });
  await page.locator('.menu .menu-item', { hasText: 'Show Header' }).click();
  await expect(hdr).toBeHidden();
  await page.locator('.area[data-editor="VIEW_3D"] .area-header-reveal').click();
  await expect(hdr).toBeVisible();
  // flip to bottom
  await page.mouse.click(v.x + 300, v.y + 12, { button: 'right' });
  await page.locator('.menu .menu-item', { hasText: 'Flip to Bottom' }).click();
  await expect(page.locator('.area[data-editor="VIEW_3D"]')).toHaveClass(/header-bottom/);
  await expectNoErrors(errors);
});

test('corner drag splits an area, edge menu joins and swaps, close area', async ({ page }) => {
  const errors = await openApp(page);
  const n0 = await areaCount(page);
  const v = await areaBox(page, 'VIEW_3D');
  // drag from the bottom-left corner to the right: side-by-side split at the release point
  await page.mouse.move(v.x + 3, v.y + v.height - 3);
  await page.mouse.down();
  await page.mouse.move(v.x + 60, v.y + v.height - 40, { steps: 4 });
  await page.mouse.move(v.x + v.width * 0.4, v.y + v.height - 40, { steps: 4 });
  await page.mouse.up();
  expect(await areaCount(page)).toBe(n0 + 1);
  const views = page.locator('.area[data-editor="VIEW_3D"]');
  await expect(views).toHaveCount(2);
  const left = (await views.nth(0).boundingBox())!;
  expect(left.width / v.width).toBeGreaterThan(0.33);
  expect(left.width / v.width).toBeLessThan(0.47);
  // right-click the new edge: Join Right removes the right-hand area
  const right = (await views.nth(1).boundingBox())!;
  const edgeX = (left.x + left.width + right.x) / 2;
  await page.mouse.move(edgeX, left.y + 200);
  await page.mouse.click(edgeX, left.y + 200, { button: 'right' });
  await expect(page.locator('.menu .menu-item', { hasText: 'Swap Areas' })).toBeVisible();
  await page.locator('.menu .menu-item', { hasText: 'Join Right' }).click();
  expect(await areaCount(page)).toBe(n0);
  await expect(views).toHaveCount(1);
  // swap the 3D view and the timeline below it by operator: the editors exchange places
  const tl0 = await areaBox(page, 'TIMELINE');
  const v0 = await areaBox(page, 'VIEW_3D');
  await page.evaluate(() => {
    const a = (window as any).app;
    const area = a.hoverArea.screen.areas.find((x: any) => x.type === 'VIEW_3D');
    a.run('screen.area_swap', { direction: 'DOWN' }, { area, invoke: false });
  });
  const tl1 = await areaBox(page, 'TIMELINE');
  expect(tl1.y).toBeLessThan(tl0.y);
  expect(Math.abs(tl1.height - v0.height)).toBeLessThan(3);
  // close the timeline
  await page.evaluate(() => {
    const a = (window as any).app;
    const area = a.hoverArea.screen.areas.find((x: any) => x.type === 'TIMELINE');
    a.run('screen.area_close', {}, { area });
  });
  expect(await areaCount(page)).toBe(n0 - 1);
  await expectNoErrors(errors);
});

test('maximize and fullscreen area, status bar toggle', async ({ page }) => {
  const errors = await openApp(page);
  const n0 = await areaCount(page);
  const v = await areaBox(page, 'VIEW_3D');
  await page.mouse.move(v.x + 200, v.y + 200);
  await page.keyboard.press('Control+Space');
  expect(await areaCount(page)).toBe(1);
  await expect(page.locator('.area[data-editor="VIEW_3D"] .area-header')).toBeVisible();
  await page.keyboard.press('Control+Space');
  expect(await areaCount(page)).toBe(n0);
  await page.keyboard.press('Control+Alt+Space');
  await expect(page.locator('.area[data-editor="VIEW_3D"] .area-header')).toBeHidden();
  await page.locator('.screen-fs-exit').click();
  expect(await areaCount(page)).toBe(n0);
  await expect(page.locator('.area[data-editor="VIEW_3D"] .area-header')).toBeVisible();
  await page.evaluate(() => (window as any).app.run('screen.toggle_statusbar'));
  await expect(page.locator('.statusbar')).toBeHidden();
  await page.evaluate(() => (window as any).app.run('screen.toggle_statusbar'));
  await expect(page.locator('.statusbar')).toBeVisible();
  await expectNoErrors(errors);
});

test('workspace tab menu: reorder and delete others', async ({ page }) => {
  const errors = await openApp(page);
  await page.locator('.ws-tab', { hasText: 'Layout' }).click({ button: 'right' });
  await page.locator('.menu .menu-item', { hasText: 'Reorder to Back' }).click();
  await expect(page.locator('.ws-tab').last()).toHaveText('Layout');
  await page.locator('.ws-tab', { hasText: 'Shading' }).click({ button: 'right' });
  await page.locator('.menu .menu-item', { hasText: 'Reorder to Front' }).click();
  await expect(page.locator('.ws-tab').first()).toHaveText('Shading');
  await page.locator('.ws-tab', { hasText: 'Modeling' }).click({ button: 'right' });
  await page.locator('.menu .menu-item', { hasText: 'Delete All Others' }).click();
  await expect(page.locator('.ws-tab')).toHaveCount(1);
  await expect(page.locator('.ws-tab.on')).toHaveText('Modeling');
  await expectNoErrors(errors);
});
