// Screen editing operators (area edges, region edges, header context menu), screens and
// workspace operators (pin scene, append, cycling), playback step / pause and the Info log window.
import { test, expect, type Page } from '@playwright/test';
import { openApp, expectNoErrors } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
const areaBox = async (page: Page, editor: string, i = 0) => (await page.locator(`.area[data-editor="${editor}"]`).nth(i).boundingBox())!;
const run = (page: Page, id: string, props: object = {}, opts: object = {}) => page.evaluate(([i, p, o]) => (window as any).app.run(i, p, o), [id, props, opts] as const);

test('area_move moves the edge under a window position; dragging an edge follows the pointer', async ({ page }) => {
  const errors = await openApp(page);
  const v = await areaBox(page, 'VIEW_3D');
  const t = await areaBox(page, 'TIMELINE');
  // the edge between the 3D view and the timeline, in window coordinates from the bottom left
  const edgeY = (v.y + v.height + t.y) / 2;
  const vh = await page.evaluate(() => innerHeight);
  await run(page, 'screen.area_move', { x: Math.round(v.x + 200), y: Math.round(vh - edgeY), delta: 60 });
  const v2 = await areaBox(page, 'VIEW_3D');
  // positive delta moves a horizontal edge up
  expect(v2.height).toBeCloseTo(v.height - 60, -1);
  // the operator's invoke drags the edge under the pointer
  await page.mouse.move(v.x + 200, v2.y + v2.height + 1);
  await run(page, 'screen.area_move', {}, { invoke: true, event: { x: v.x + 200, y: v2.y + v2.height + 1 } });
  await page.mouse.move(v.x + 200, v2.y + v2.height - 40);
  await page.mouse.up();
  const v3 = await areaBox(page, 'VIEW_3D');
  expect(v3.height).toBeCloseTo(v2.height - 40, -1);
  // Area options on the edge: the menu offers joins and swap
  await run(page, 'screen.area_options', {}, { invoke: true, event: { x: v.x + 200, y: v3.y + v3.height + 1 } });
  await expect(page.locator('.menu .menu-item', { hasText: 'Swap Areas' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expectNoErrors(errors);
});

test('dragging the sidebar edge resizes it, saved with the layout; dragging it closed hides it', async ({ page }) => {
  const errors = await openApp(page);
  const v = await areaBox(page, 'VIEW_3D');
  await page.mouse.move(v.x + v.width / 2, v.y + v.height / 2);
  await page.keyboard.press('n');
  const sb = page.locator('.area[data-editor="VIEW_3D"] .v3d-sidebar');
  await expect(sb).toBeVisible();
  const b = (await sb.boundingBox())!;
  const y = b.y + b.height / 2;
  await page.mouse.move(b.x + 1, y);
  await expect(page.locator('body.region-edge-hover')).toHaveCount(1);
  await page.mouse.down();
  await page.mouse.move(b.x - 40, y);
  await page.mouse.move(b.x - 80, y);
  await page.mouse.up();
  const b2 = (await sb.boundingBox())!;
  expect(b2.width).toBeCloseTo(b.width + 80, -1);
  const saved = await page.evaluate(() => (window as any).app.hoverArea.serialize().ui?.regions);
  expect(saved['.v3d-sidebar']).toBeCloseTo(b.width + 80, -1);
  // drag it nearly closed: the sidebar hides and comes back at its previous width
  await page.mouse.move(b2.x + 1, y);
  await page.mouse.down();
  await page.mouse.move(b2.x + b2.width - 20, y);
  await page.mouse.up();
  await expect(sb).toHaveCount(0);
  await page.mouse.move(v.x + v.width / 3, v.y + v.height / 2);
  await page.keyboard.press('n');
  const b3 = (await sb.boundingBox())!;
  expect(b3.width).toBeCloseTo(b2.width, -1);
  await expectNoErrors(errors);
});

test('header region context menu operator; area menu labels', async ({ page }) => {
  const errors = await openApp(page);
  const v = await areaBox(page, 'VIEW_3D');
  await page.mouse.move(v.x + 300, v.y + 300);
  await run(page, 'screen.region_context_menu', {}, { invoke: true });
  await expect(page.locator('.menu .menu-item', { hasText: 'Show Header' })).toBeVisible();
  await expect(page.locator('.menu .menu-item', { hasText: 'Maximize Area' })).toBeVisible();
  await expect(page.locator('.menu .menu-item', { hasText: 'Focus Mode' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expectNoErrors(errors);
});

test('workspaces: append by name, cycle screens, pin a scene', async ({ page }) => {
  const errors = await openApp(page);
  await run(page, 'workspace.append_activate', { idname: 'Sculpting' });
  await expect(page.locator('.ws-tab.on')).toHaveText('Sculpting.001');
  await page.locator('.ws-tab', { hasText: /^Layout$/ }).click();
  await run(page, 'screen.screen_set', { delta: 1 });
  await expect(page.locator('.ws-tab.on')).toHaveText('Modeling');
  await run(page, 'screen.screen_set', { delta: -2 });
  await expect(page.locator('.ws-tab.on')).toHaveText('Sculpting.001');
  await page.locator('.ws-tab', { hasText: /^Layout$/ }).click();
  // pin the Layout workspace to the current scene, then change scenes elsewhere
  const scene0 = await page.evaluate(() => (window as any).app.doc.scene.name);
  await page.locator('.ws-tab', { hasText: /^Layout$/ }).click({ button: 'right' });
  await page.locator('.menu .menu-item', { hasText: 'Pin Scene' }).click();
  await page.locator('.ws-tab', { hasText: /^Shading$/ }).click();
  await run(page, 'scene.new', { type: 'EMPTY' });
  const scene1 = await page.evaluate(() => (window as any).app.doc.scene.name);
  expect(scene1).not.toBe(scene0);
  await page.locator('.ws-tab', { hasText: /^Layout$/ }).click();
  expect(await page.evaluate(() => (window as any).app.doc.scene.name)).toBe(scene0);
  // the unpinned workspace keeps the scene that is active
  await page.locator('.ws-tab', { hasText: /^Shading$/ }).click();
  expect(await page.evaluate(() => (window as any).app.doc.scene.name)).toBe(scene0);
  // the Workspace panel shows the pin and the workspace's mode
  await page.locator('.ws-tab', { hasText: /^Layout$/ }).click({ button: 'right' });
  await expect(page.locator('.menu .menu-item', { hasText: 'Pin Scene' }).locator('.checked, .on, svg').first()).toBeVisible();
  await page.keyboard.press('Escape');
  await expectNoErrors(errors);
});

test('playback step and pause; Info log window', async ({ page }) => {
  const errors = await openApp(page);
  const f0 = await page.evaluate(() => (window as any).app.doc.scene.frame_current);
  await run(page, 'screen.animation_step');
  expect(await page.evaluate(() => (window as any).app.doc.scene.frame_current)).toBe(f0 + 1);
  await run(page, 'screen.animation_play');
  await page.waitForTimeout(200);
  await run(page, 'screen.animation_pause');
  const paused = await page.evaluate(() => ({ playing: (window as any).app.playing, f: (window as any).app.doc.scene.frame_current }));
  expect(paused.playing).toBe(false);
  expect(paused.f).toBeGreaterThan(f0);
  await run(page, 'screen.animation_pause');
  expect(await page.evaluate(() => (window as any).app.playing)).toBe('forward');
  await run(page, 'screen.animation_cancel', { restore_frame: false });
  await run(page, 'screen.info_log_show');
  await expect(page.locator('.area-window .area[data-editor="INFO"]')).toBeVisible();
  await expectNoErrors(errors);
});

test('quad view: dragging the middle edge moves both halves of the line', async ({ page }) => {
  const errors = await openApp(page);
  const v = await areaBox(page, 'VIEW_3D');
  await page.mouse.move(v.x + v.width / 2, v.y + v.height / 2);
  await page.keyboard.press('Control+Alt+q');
  await expect(page.locator('.area[data-editor="VIEW_3D"]')).toHaveCount(4);
  const boxes = async () => {
    const all = await page.locator('.area[data-editor="VIEW_3D"]').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON() as DOMRect));
    return all.sort((a, b) => a.top - b.top || a.left - b.left);
  };
  const b0 = await boxes();
  const edgeX = b0[0].right + 1;
  const y = b0[0].top + b0[0].height / 2;
  await page.mouse.move(edgeX, y);
  await page.mouse.down();
  await page.mouse.move(edgeX - 50, y, { steps: 3 });
  await page.mouse.up();
  const b1 = await boxes();
  expect(b1[0].width).toBeCloseTo(b0[0].width - 50, -1);
  // the lower row follows
  expect(b1[2].width).toBeCloseTo(b0[2].width - 50, -1);
  // the crossing in the middle moves both lines
  const cx = b1[0].right + 1,
    cy = b1[0].bottom + 1;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 40, cy + 30, { steps: 3 });
  await page.mouse.up();
  const b2 = await boxes();
  expect(b2[0].width).toBeCloseTo(b1[0].width + 40, -1);
  expect(b2[0].height).toBeCloseTo(b1[0].height + 30, -1);
  expect(b2[3].height).toBeCloseTo(b1[3].height - 30, -1);
  await expectNoErrors(errors);
});

test('scripts read and change the active workspace', async ({ page }) => {
  const errors = await openApp(page);
  const out = await page.evaluate(async () => {
    const { runJavaScript } = await import('/src/scripting/runner.ts' as string);
    const r = runJavaScript(`
      const ws = bpy.context.workspace;
      window.__o = [ws.name, ws.object_mode, ws.use_pin_scene];
      ws.object_mode = 'SCULPT';
      ws.use_pin_scene = true;
      ws.name = 'Main';
      window.__o.push(bpy.context.workspace.name, bpy.context.workspace.object_mode, bpy.context.workspace.use_pin_scene);
    `);
    return r.ok ? (window as any).__o : r.error;
  });
  expect(out).toEqual(['Layout', 'OBJECT', false, 'Main', 'SCULPT', true]);
  await expect(page.locator('.ws-tab.on')).toHaveText('Main');
  await expectNoErrors(errors);
});

test('side regions of other editors resize from their inner edge too', async ({ page }) => {
  const errors = await openApp(page);
  const v = await areaBox(page, 'VIEW_3D');
  await page.mouse.move(v.x + 300, v.y + 300);
  await page.evaluate(() => (window as any).app.hoverArea.setType('FILE_BROWSER'));
  const side = page.locator('.area[data-editor="FILE_BROWSER"] .fb-side');
  const b = (await side.boundingBox())!;
  await page.mouse.move(b.x + b.width - 1, b.y + 200);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width + 60, b.y + 200, { steps: 3 });
  await page.mouse.up();
  expect((await side.boundingBox())!.width).toBeCloseTo(b.width + 61, -1);
  await expectNoErrors(errors);
});
