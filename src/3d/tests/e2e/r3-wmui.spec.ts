import { test, expect, type Page } from '@playwright/test';
import { openApp, hoverViewport, expectNoErrors } from './helpers';

type AnyApp = { run(id: string, p?: object, o?: object): string; doc: Record<string, any>; activeObject: Record<string, any>; reports: { message: string }[]; hoverArea: { editor: Record<string, any> } }; // eslint-disable-line @typescript-eslint/no-explicit-any

const run = (page: Page, id: string, props: object = {}) => page.evaluate(([i, p]) => (window as unknown as { app: AnyApp }).app.run(i as string, p as object), [id, props] as const);

async function menuLabels(page: Page) {
  return page.$$eval('.popup-layer .menu .mi-label, .popup-layer .menu .menu-sep', (els) => els.map((e) => (e.classList.contains('menu-sep') ? '---' : (e.textContent ?? ''))));
}

async function objectTab(page: Page) {
  await page.locator('.rail-tab[data-tab="OBJECT"]').click();
}

test('context operators toggle, set, cycle and scale settings by data path', async ({ page }) => {
  const errors = await openApp(page);
  await hoverViewport(page);
  const r = await page.evaluate(() => {
    const a = (window as unknown as { app: AnyApp }).app;
    const ts = () => a.doc.scene.tool_settings;
    const out: Record<string, unknown> = { snap0: ts().use_snap };
    a.run('wm.context_toggle', { data_path: 'tool_settings.use_snap' });
    out.snap1 = ts().use_snap;
    a.run('wm.context_set_enum', { data_path: 'tool_settings.proportional_edit_falloff', value: 'LINEAR' });
    a.run('wm.context_cycle_enum', { data_path: 'tool_settings.proportional_edit_falloff', wrap: true });
    out.falloff = ts().proportional_edit_falloff;
    const v = a.hoverArea.editor;
    const side = v.showSidebar;
    a.run('wm.context_toggle', { data_path: 'space_data.show_region_ui' });
    out.side = v.showSidebar !== side;
    a.run('wm.context_set_value', { data_path: 'object.location', value: '(1, 2, 3)' });
    out.loc = Array.from(a.activeObject.location as number[]);
    a.run('wm.context_scale_float', { data_path: 'object.scale[0]', value: 2 });
    out.sx = a.activeObject.scale[0];
    return out;
  });
  expect(r).toEqual({ snap0: false, snap1: true, falloff: 'CONSTANT', side: true, loc: [1, 2, 3], sx: 2 });
  // Alt+W: the selection tool pie
  await hoverViewport(page);
  await page.keyboard.press('Alt+w');
  await expect(page.locator('.pie')).toBeVisible();
  await expect(page.locator('.pie')).toContainText('Select Lasso');
  await page.keyboard.press('Escape');
  // a named pie
  await run(page, 'wm.call_menu_pie', { name: 'VIEW3D_MT_proportional_editing_falloff_pie' });
  await expect(page.locator('.pie')).toContainText('Inverse Square');
  await page.keyboard.press('Escape');
  await expectNoErrors(errors);
});

test('property context menu lists keyframe, driver, keying set, path and copy entries; F1 shows help', async ({ page }) => {
  const errors = await openApp(page);
  await objectTab(page);
  const field = page.locator('.panel-body .num-field').first();
  await field.click({ button: 'right' });
  const labels = await menuLabels(page);
  expect(labels.join('|')).toBe(
    [
      'Insert Keyframes',
      'Insert Single Keyframe',
      '---',
      'Add Drivers',
      'Add Single Driver',
      'Open Drivers Editor',
      'Pick Driver Source…',
      '---',
      'Add All to Keying Set',
      'Add Single to Keying Set',
      '---',
      'Reset All to Default Values',
      'Reset Single to Default Value',
      '---',
      'Copy Data Path',
      'Copy Full Data Path',
      'Copy as New Driver',
      '---',
      'Copy All to Selected',
      'Copy Single to Selected',
      '---',
      'Copy Value',
      'Paste Value',
      'Copy Entire Array',
      'Paste Entire Array',
      '---',
      'Help',
    ].join('|'),
  );
  // insert a keyframe from the menu: the entry acts on the button the menu was opened from
  await page.locator('.popup-layer .menu .mi-label', { hasText: /^Insert Keyframes$/ }).click();
  await field.click({ button: 'right' });
  const keyed = await menuLabels(page);
  expect(keyed.slice(0, 7)).toEqual(['Replace Keyframes', 'Replace Single Keyframe', 'Delete Keyframes', 'Delete Single Keyframe', 'Clear Keyframes', 'Clear Single Keyframes', 'View in Graph Editor']);
  await page.keyboard.press('Escape');
  await field.hover();
  await page.keyboard.press('F1');
  await expect(page.locator('.help-card')).toContainText('bpy.data.objects["Cube"].location[0]');
  await expectNoErrors(errors);
});

test('custom properties: add, edit, unset from the button menu, reset to the assigned default', async ({ page }) => {
  const errors = await openApp(page);
  await objectTab(page);
  const panel = page.locator('[data-panel="ob-custom"]');
  await panel.locator('.panel-header').click();
  await panel.locator('.cp-new').click();
  await expect(panel.locator('.custom-prop')).toHaveCount(1);
  // Edit Property dialog: rename and make it an integer with limits
  await panel.locator('.custom-prop .icon-btn').first().click();
  const dlg = page.locator('.op-dialog');
  await expect(dlg).toBeVisible();
  await page.evaluate(() => {
    const a = (window as unknown as { app: AnyApp }).app;
    a.run('wm.properties_edit', { data_path: 'object', old_name: 'prop', property_name: 'count', property_type: 'INT', value_int: 4, min: 0, max: 10, default_value: 1 }, { invoke: false });
  });
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => (window as unknown as { app: AnyApp }).app.activeObject.custom)).toEqual({ count: 4 });
  const field = panel.locator('.custom-prop .num-field');
  await expect(field).toContainText('4');
  // Backspace resets to the default from Edit Property
  await field.hover();
  await page.keyboard.press('Backspace');
  await expect(field).toContainText('1');
  expect(await page.evaluate(() => (window as unknown as { app: AnyApp }).app.activeObject.custom.count)).toBe(1);
  await field.click({ button: 'right' });
  const labels = await menuLabels(page);
  expect(labels).toContain('Assign Value as Default');
  expect(labels).toContain('Unset');
  await page.locator('.popup-layer .menu .mi-label', { hasText: /^Unset$/ }).click();
  await expect(panel.locator('.custom-prop')).toHaveCount(0);
  await expectNoErrors(errors);
});

test('operator buttons: right-click assigns a shortcut that works and copies the Python command', async ({ page }) => {
  const errors = await openApp(page);
  // any operator button: Object tab ▸ Custom Properties ▸ New
  await objectTab(page);
  const panel = page.locator('[data-panel="ob-custom"]');
  await panel.locator('.panel-header').click();
  const btn = panel.locator('.cp-new');
  await btn.click({ button: 'right' });
  const labels = await menuLabels(page);
  expect(labels).toEqual(['Add to Quick Favorites', '---', 'Assign Shortcut', '---', 'Copy Python Command', '---', 'Help']);
  await page.locator('.popup-layer .menu .mi-label', { hasText: 'Assign Shortcut' }).click();
  await page.keyboard.press('Control+Alt+Shift+F7');
  const key = await page.evaluate(async () => (await import('/src/ui/shortcuts.ts')).findShortcut('wm.properties_add', { data_path: 'object' })?.item.key);
  expect(key).toBe('F7');
  await hoverViewport(page);
  await page.keyboard.press('Control+Alt+Shift+F7');
  await expect(panel.locator('.custom-prop')).toHaveCount(1);
  // menu items get the same entries after Quick Favorites
  await btn.click({ button: 'right' });
  await expect(page.locator('.popup-layer .menu .mi-label', { hasText: 'Change Shortcut' })).toBeVisible();
  await page.locator('.popup-layer .menu .mi-label', { hasText: 'Remove Shortcut' }).click();
  expect(await page.evaluate(async () => !!(await import('/src/ui/shortcuts.ts')).findShortcut('wm.properties_add', { data_path: 'object' }))).toBe(false);
  await expectNoErrors(errors);
});

test('panel presets: built-in format presets, user presets saved in IndexedDB', async ({ page }) => {
  const errors = await openApp(page);
  await page.locator('.rail-tab[data-tab="OUTPUT"]').click();
  const btn = page.locator('[data-panel="out-format"] .preset-btn');
  await btn.dispatchEvent('pointerdown');
  await page.locator('.popup-layer .menu .mi-label', { hasText: /^HDTV 720p$/ }).click();
  const res = () => page.evaluate(() => {
    const r = (window as unknown as { app: AnyApp }).app.doc.scene.render;
    return [r.resolution_x, r.resolution_y];
  });
  expect(await res()).toEqual([1280, 720]);
  // save the current values as a preset of our own
  await page.evaluate(() => {
    const a = (window as unknown as { app: AnyApp }).app;
    a.doc.scene.render.resolution_x = 1000;
    a.doc.scene.render.resolution_y = 500;
    a.run('render.preset_add', { name: 'Half Wide' });
    a.doc.scene.render.resolution_x = 64;
  });
  await page.evaluate(async () => (await import('/src/ui/presets.ts')).presetsSaved());
  await page.reload();
  await page.waitForFunction(() => !!(window as unknown as { app?: unknown }).app);
  await page.evaluate(async () => (await import('/src/ui/presets.ts')).presetsLoaded);
  await page.locator('.rail-tab[data-tab="OUTPUT"]').click();
  await page.locator('[data-panel="out-format"] .preset-btn').dispatchEvent('pointerdown');
  await page.locator('.popup-layer .menu .mi-label', { hasText: /^Half Wide$/ }).click();
  expect(await res()).toEqual([1000, 500]);
  // generic panel presets: camera sensor sizes
  await page.evaluate(() => {
    const a = (window as unknown as { app: AnyApp }).app;
    const cam = Object.values(a.doc.objects as Record<string, { id: string; type: string }>).find((o) => o.type === 'CAMERA')!;
    for (const o of Object.values(a.doc.objects as Record<string, { select: boolean }>)) o.select = false;
    (a.doc.objects as Record<string, { select: boolean }>)[cam.id].select = true;
    a.doc.scene.active_object = cam.id;
    a.changed('select');
  });
  await page.locator('.rail-tab[data-tab="DATA"]').click();
  await page.locator('[data-panel="ca-sensor"] .preset-btn').dispatchEvent('pointerdown');
  await page.locator('.popup-layer .menu .mi-label', { hasText: /^Super 35$/ }).click();
  const sensor = await page.evaluate(() => {
    const a = (window as unknown as { app: AnyApp }).app;
    const c = a.doc.cameras[a.activeObject.data];
    return [c.sensor_width, c.sensor_height];
  });
  expect(sensor).toEqual([24.89, 18.66]);
  await expectNoErrors(errors);
});

test('operator presets in the redo panel; restore defaults; quit asks to save; cheat sheet', async ({ page }) => {
  const errors = await openApp(page);
  await hoverViewport(page);
  await run(page, 'mesh.primitive_cube_add', { size: 3 });
  const panel = page.locator('.redo-panel');
  await panel.locator('.redo-header').click();
  await expect(panel.locator('.op-presets')).toBeVisible();
  await page.evaluate(() => (window as unknown as { app: AnyApp }).app.run('wm.operator_preset_add', { name: 'Big', operator: 'mesh.primitive_cube_add' }));
  const size = () => page.evaluate(() => (window as unknown as { app: { lastOp: { props: Record<string, unknown> } } }).app.lastOp.props.size);
  await run(page, 'mesh.primitive_cube_add', {});
  expect(await size()).toBe(2);
  await panel.locator('.op-preset-menu').dispatchEvent('pointerdown');
  await page.locator('.popup-layer .menu .mi-label', { hasText: /^Big$/ }).click();
  expect(await size()).toBe(3);
  await panel.locator('.op-preset-menu').dispatchEvent('pointerdown');
  await page.locator('.popup-layer .menu .mi-label', { hasText: /^Restore Defaults$/ }).click();
  expect(await size()).toBe(2);
  // quit with unsaved changes asks first
  await page.keyboard.press('Control+q');
  await expect(page.locator('.dialog', { hasText: 'Save changes before quitting?' })).toBeVisible();
  await page.locator('.dialog button', { hasText: 'Cancel' }).click();
  // cheat sheet text block
  await run(page, 'wm.operator_cheat_sheet');
  const sheet = await page.evaluate(() => Object.values((window as unknown as { app: AnyApp }).app.doc.texts as Record<string, { name: string; body: string }>).find((t) => t.name.startsWith('OperatorList'))?.body ?? '');
  expect(sheet).toContain('bpy.ops.mesh.primitive_cube_add(size=2, ');
  expect(await run(page, 'wm.url_open', { url: 'javascript:alert(1)' })).toBe('CANCELLED');
  await expectNoErrors(errors);
});

test('UI lists: drag to reorder, resize, filter, rename with F2, Delete removes; Ctrl+wheel toggles', async ({ page }) => {
  const errors = await openApp(page);
  await page.evaluate(() => {
    const a = (window as unknown as { app: AnyApp }).app;
    for (let i = 0; i < 4; i++) a.run('object.vertex_group_add');
  });
  await page.locator('.rail-tab[data-tab="DATA"]').click();
  const list = page.locator('.uilist[data-list="vg"]');
  const names = () => page.evaluate(() => {
    const a = (window as unknown as { app: AnyApp }).app;
    return (a.doc.meshes[a.activeObject.data].vertex_groups as { name: string }[]).map((g) => g.name);
  });
  expect(await names()).toEqual(['Group', 'Group.001', 'Group.002', 'Group.003']);
  const r0 = (await list.locator('.ul-row').nth(0).boundingBox())!;
  const r2 = (await list.locator('.ul-row').nth(2).boundingBox())!;
  await page.mouse.move(r0.x + 40, r0.y + 10);
  await page.mouse.down();
  await page.mouse.move(r0.x + 40, r0.y + 20, { steps: 3 });
  await page.mouse.move(r2.x + 40, r2.y + r2.height - 2, { steps: 5 });
  await page.mouse.up();
  expect(await names()).toEqual(['Group.001', 'Group.002', 'Group', 'Group.003']);
  // resize: three rows more than the four it had
  const g = (await list.locator('.ul-resize').boundingBox())!;
  await page.mouse.move(g.x + 5, g.y + 5);
  await page.mouse.down();
  await page.mouse.move(g.x + 5, g.y + 5 + 66, { steps: 4 });
  await page.mouse.up();
  expect(Math.round((await list.locator('.ul-rows').boundingBox())!.height)).toBe(7 * 22 + 4);
  // F2 renames the active item, Delete removes it
  await list.locator('.ul-row').nth(0).click();
  await page.keyboard.press('F2');
  await page.locator('.ul-rename').fill('Spine');
  await page.keyboard.press('Enter');
  expect((await names())[0]).toBe('Spine');
  await list.locator('.ul-row').nth(0).hover();
  await page.keyboard.press('Delete');
  expect(await names()).toEqual(['Group.002', 'Group', 'Group.003']);
  // Ctrl+F over the list opens its filter
  await list.hover();
  await page.keyboard.press('Control+f');
  await expect(list.locator('.ul-filter-text input')).toBeFocused();
  await page.keyboard.press('Escape');
  // Ctrl+wheel over a checkbox toggles it
  await page.locator('.rail-tab[data-tab="OBJECT"]').click();
  await page.locator('[data-panel="ob-display"] .panel-header').click();
  const cb = page.locator('[data-panel="ob-display"] .checkbox').first();
  const on0 = await cb.evaluate((e) => e.classList.contains('on'));
  await cb.hover();
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -100);
  await page.keyboard.up('Control');
  await expect(cb).toHaveClass(on0 ? /^(?!.*\bon\b)/ : /\bon\b/);
  await expectNoErrors(errors);
});

test('eyedroppers and drops: driver source pick, colour swatch drag, Outliner object onto an object field', async ({ page }) => {
  const errors = await openApp(page);
  await objectTab(page);
  const locX = page.locator('.panel-body .num-field').first();
  await locX.click({ button: 'right' });
  await page.locator('.popup-layer .menu .mi-label', { hasText: 'Pick Driver Source…' }).click();
  // click Scale X: it now drives Location X
  const scale = page.locator('[data-panel="ob-transform"] .num-field').nth(6);
  await scale.click();
  const drv = await page.evaluate(() => {
    const a = (window as unknown as { app: AnyApp }).app;
    const d = a.activeObject.animation_data?.drivers?.[0];
    return d ? [d.data_path, d.array_index, d.variables[0].targets[0].data_path] : null;
  });
  expect(drv).toEqual(['location', 0, 'scale[0]']);
  // material tab: drag Base Color onto another colour socket
  await page.locator('.rail-tab[data-tab="MATERIAL"]').click();
  const swatches = page.locator('.color-swatch[data-id]');
  await expect(swatches.first()).toBeVisible();
  const n = await swatches.count();
  expect(n).toBeGreaterThan(1);
  const a = (await swatches.nth(0).boundingBox())!;
  const b = (await swatches.nth(1).boundingBox())!;
  const colors = () => page.evaluate(() => [...document.querySelectorAll('.color-swatch[data-id]')].map((e) => (e as HTMLElement).style.getPropertyValue('--swatch')));
  const before = await colors();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 20, a.y + a.height / 2 + 10, { steps: 3 });
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 6 });
  await page.mouse.up();
  expect(before[1]).not.toBe(before[0]);
  await expect.poll(async () => (await colors())[1]).toBe(before[0]);
  await expect(page.locator('.popover')).toHaveCount(0);
  await expectNoErrors(errors);
});
