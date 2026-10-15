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

test('F3 searches the top bar and header menus with their paths', async ({ page }) => {
  const errors = await openApp(page);
  const v = await areaBox(page, 'VIEW_3D');
  await page.mouse.move(v.x + 300, v.y + 300);
  await page.keyboard.press('F3');
  await page.keyboard.type('recover auto');
  await expect(page.locator('.search-popup .menu-item').first()).toContainText('File ▸ Recover ▸ Auto Save');
  await page.locator('.search-input').fill('area toggle maximize');
  await expect(page.locator('.search-popup .menu-item').first()).toContainText('View ▸ Area ▸ Toggle Maximize Area');
  await page.keyboard.press('Enter');
  expect(await areaCount(page)).toBe(1);
  await expectNoErrors(errors);
});

test('File menu: save adds to Open Recent, revert, save copy, startup file', async ({ page }) => {
  const errors = await openApp(page);
  await page.evaluate(async () => {
    const s = await import('/src/io/session.ts');
    await s.sessionReady;
    await s.clearRecent();
    await s.clearStartupFile();
  });
  // save: the file becomes the first recent file
  const dl = page.waitForEvent('download');
  await page.evaluate(() => (window as any).app.run('wm.save_mainfile'));
  await dl;
  await expect.poll(() => page.evaluate(async () => (await import('/src/io/session.ts')).recentFiles().map((e) => e.name))).toEqual(['untitled.p3d']);
  // change something, then revert to the saved state
  await page.evaluate(() => {
    const a = (window as any).app;
    a.activeObject.location[0] = 5;
    a.pushUndo('Move');
    a.run('wm.revert_mainfile', {}, { invoke: false });
  });
  await expect.poll(() => get(page, 'app.activeObject.location[0]')).toBe(0);
  // Ctrl Shift O lists the recent file; picking it opens it
  const v = await areaBox(page, 'VIEW_3D');
  await page.mouse.move(v.x + 300, v.y + 300);
  await page.keyboard.press('Control+Shift+o');
  await expect(page.locator('.menu .menu-item', { hasText: 'untitled.p3d' })).toBeVisible();
  await page.keyboard.press('Escape');
  // Ctrl N opens the New File menu
  await page.keyboard.press('Control+n');
  await expect(page.locator('.menu .menu-item', { hasText: 'General' })).toBeVisible();
  await page.keyboard.press('Escape');
  // save copy keeps the current name
  await page.evaluate(() => {
    const a = (window as any).app;
    a.filename = 'mine.p3d';
  });
  const dl2 = page.waitForEvent('download');
  await page.evaluate(() => (window as any).app.run('wm.save_as_mainfile', { filepath: 'other.p3d', copy: true }, { invoke: false }));
  expect((await dl2).suggestedFilename()).toBe('other.p3d');
  expect(await get(page, 'app.filename')).toBe('mine.p3d');
  // startup file: New File starts from it
  await page.evaluate(async () => {
    const a = (window as any).app;
    a.activeObject.name = 'StartupCube';
    a.pushUndo('Rename');
    a.run('wm.save_homefile', {}, { invoke: false });
    await new Promise((r) => setTimeout(r, 200));
    a.run('wm.read_homefile', { use_factory_startup: true });
  });
  expect(await get(page, 'app.activeObject.name')).toBe('Cube');
  await page.evaluate(() => (window as any).app.run('wm.read_homefile'));
  expect(await get(page, 'app.activeObject.name')).toBe('StartupCube');
  await page.evaluate(async () => (await import('/src/io/session.ts')).clearStartupFile());
  await expectNoErrors(errors);
});

test('Edit menu: repeat history, undo history submenu; splash and system menus', async ({ page }) => {
  const errors = await openApp(page);
  await page.evaluate(() => {
    const a = (window as any).app;
    a.run('mesh.primitive_cube_add', {}, { invoke: false });
  });
  const n = await get(page, 'Object.keys(app.doc.objects).length');
  await page.locator('.tb-menu', { hasText: 'Edit' }).dispatchEvent('pointerdown');
  await page.locator('.menu .menu-item', { hasText: 'Repeat History' }).click();
  await page.locator('.menu .menu-item', { hasText: 'Cube' }).first().click();
  expect(await get(page, 'Object.keys(app.doc.objects).length')).toBe((n as number) + 1);
  await page.locator('.tb-menu', { hasText: 'Edit' }).dispatchEvent('pointerdown');
  await page.locator('.menu .menu-item', { hasText: 'Undo History' }).hover();
  await expect(page.locator('.menu .menu-item', { hasText: 'Original' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.evaluate(() => (window as any).app.run('wm.splash'));
  await expect(page.locator('.splash')).toBeVisible();
  await expect(page.locator('.splash-item', { hasText: 'General' })).toBeVisible();
  await page.locator('.splash-hero').click();
  await expect(page.locator('.splash')).toHaveCount(0);
  await page.evaluate(() => {
    const a = (window as any).app;
    a.run('wm.memory_statistics');
    a.run('wm.redraw_timer', { type: 'DRAW', iterations: 3 });
  });
  const reports = (await get(page, 'app.reports.map(r => r.message).join("\\n")')) as string;
  expect(reports).toMatch(/Data-blocks: .*objects/);
  expect(reports).toMatch(/Draw Region: 3 iterations/);
  await expectNoErrors(errors);
});
