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
