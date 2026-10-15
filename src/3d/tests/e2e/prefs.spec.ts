import { test, expect, type Page } from '@playwright/test';
import { openApp, hoverViewport, expectNoErrors } from './helpers';

async function openPrefs(page: Page, section: string) {
  await page.evaluate((s) => (window as unknown as { app: { run(id: string, p: object): void } }).app.run('screen.userpref_show', { section: s }), section);
  await expect(page.locator('.prefs-window')).toBeVisible();
  await page.locator(`.prefs-nav-btn[data-section="${section}"]`).click();
}

async function closePrefs(page: Page) {
  await page.locator('.prefs-window .dlg-close').click();
  await expect(page.locator('.prefs-window')).toHaveCount(0);
}

test('keymap: rebinding an item drives the real key handling and persists', async ({ page }) => {
  const errors = await openApp(page);
  await openPrefs(page, 'KEYMAP');
  await page.locator('.km-search input').fill('view3d.toggle_sidebar');
  const row = page.locator('.km-item', { hasText: 'Sidebar' }).first();
  await row.locator('.km-key').click();
  await expect(row.locator('.km-key')).toHaveValue('Press a key…');
  await page.keyboard.press('Shift+J');
  await expect(row.locator('.km-key')).toHaveValue('Shift J');
  await closePrefs(page);

  const shown = () => page.evaluate(async () => (await import('/src/editors/view3d/view3d.ts')).activeView3D()!.showSidebar);
  const before = await shown();
  await hoverViewport(page);
  await page.keyboard.press('n');
  expect(await shown()).toBe(before);
  await page.keyboard.press('Shift+J');
  expect(await shown()).toBe(!before);

  // stored and applied again after a reload
  await page.reload();
  await page.waitForFunction(() => !!(window as unknown as { app?: unknown }).app);
  await page.waitForTimeout(400);
  const key = await page.evaluate(async () => {
    const km = await import('/src/app/keymap.ts');
    return km.shortcutLabel('view3d.toggle_sidebar');
  });
  expect(key).toBe('Shift J');
  await expectNoErrors(errors);
});

test('keymap: search by key press, edit operator properties, add and remove items', async ({ page }) => {
  const errors = await openApp(page);
  await openPrefs(page, 'KEYMAP');
  await page.locator('.km-mode button', { hasText: 'Key-Binding' }).click();
  await page.locator('.km-record').click();
  await page.keyboard.press('Control+z');
  await expect(page.locator('.km-search input')).toHaveValue('Ctrl Z');
  await expect(page.locator('.km-item', { hasText: 'Undo' }).first()).toBeVisible();
  await expect(page.locator('.km-item', { hasText: 'Redo' })).toHaveCount(0);

  // add a new item to the Window keymap and point it at an operator
  await page.locator('.km-mode button', { hasText: 'Name' }).click();
  await page.locator('.km-search input').fill('');
  await page.locator('[data-panel="pf-km-Window"] > .panel-header').click();
  await page.locator('[data-panel="pf-km-Window"] .km-actions .btn', { hasText: 'Add New' }).click();
  const item = page.locator('[data-panel="pf-km-Window"] .km-item.open').first();
  await item.locator('.km-oppick').click();
  await page.keyboard.type('wm.search_menu');
  await page.keyboard.press('Enter');
  await item.locator('.km-key').click();
  await page.keyboard.press('Alt+K');
  const added = await page.evaluate(async () => {
    const km = await import('/src/app/keymap.ts');
    const k = km.keymaps.Window[0];
    return { key: k.key, alt: k.alt, op: k.op };
  });
  expect(added).toEqual({ key: 'K', alt: true, op: 'wm.search_menu' });
  await item.locator('.km-actions .btn', { hasText: 'Remove' }).click();
  expect(await page.evaluate(async () => (await import('/src/app/keymap.ts')).keymaps.Window.some((k) => k.key === 'K' && k.alt))).toBe(false);

  // operator properties are edited through the operator's own property list
  await page.locator('.km-search input').fill('Frame Jump');
  const jump = page.locator('.km-item', { hasText: 'Jump to Endpoint' }).first();
  await jump.locator('.km-expand').click();
  await expect(jump.locator('.km-props')).toBeVisible();
  await expectNoErrors(errors);
});

test('keymap: industry standard preset and spacebar option rebind keys; export/import round trip', async ({ page }) => {
  const errors = await openApp(page);
  await openPrefs(page, 'KEYMAP');
  await page.locator('.km-presets .enum-menu').dispatchEvent('pointerdown');
  await page.locator('.menu-item', { hasText: 'Industry Standard' }).click();
  const state = await page.evaluate(async () => {
    const km = await import('/src/app/keymap.ts');
    return { selectAll: km.shortcutLabel('object.select_all', { action: 'SELECT' }), dup: km.shortcutLabel('object.duplicate_move'), move: km.shortcutLabel('wm.tool_set_by_id', { name: 'builtin.move' }) };
  });
  expect(state).toEqual({ selectAll: 'Ctrl A', dup: 'Ctrl D', move: 'W' });
  await closePrefs(page);
  await hoverViewport(page);
  await page.keyboard.press('w');
  expect(await page.evaluate(async () => (await import('/src/app/prefs.ts')).activeTools.OBJECT)).toBe('builtin.move');

  const text = await page.evaluate(async () => (await import('/src/prefs/keyconfig.ts')).exportKeyconfigText('x'));
  await page.evaluate(async () => (await import('/src/prefs/keyconfig.ts')).choosePreset('DEFAULT'));
  expect(await page.evaluate(async () => (await import('/src/app/keymap.ts')).shortcutLabel('object.duplicate_move'))).toBe('Shift D');
  await page.evaluate(async (t) => (await import('/src/prefs/keyconfig.ts')).importKeyconfigText(t), text);
  expect(await page.evaluate(async () => (await import('/src/app/keymap.ts')).shortcutLabel('object.duplicate_move'))).toBe('Ctrl D');

  await page.evaluate(async () => (await import('/src/prefs/keyconfig.ts')).choosePreset('DEFAULT'));
  await openPrefs(page, 'KEYMAP');
  await page.locator('[data-panel="pf-km-options"] > .panel-header').click();
  await page.locator('[data-panel="pf-km-options"] button', { hasText: 'Search' }).click();
  expect(await page.evaluate(async () => (await import('/src/app/keymap.ts')).shortcutLabel('wm.search_menu'))).toContain('Space');
  await expectNoErrors(errors);
});

const rootVar = (page: Page, name: string) => page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);

test('themes: presets restyle the interface and canvases, edits persist, export/import, factory reset', async ({ page }) => {
  const errors = await openApp(page);
  expect(await rootVar(page, '--c-region')).toBe('#303030');
  await openPrefs(page, 'THEMES');
  await page.locator('.th-presets .enum-menu').dispatchEvent('pointerdown');
  await page.locator('.menu-item', { hasText: 'Light' }).click();
  expect(await rootVar(page, '--c-region')).toBe('#eef0f2');
  // style sheet greys follow the theme through the ramp
  expect(await rootVar(page, '--g-1d')).toBe('#ffffff');
  const canvas = await page.evaluate(async () => {
    const reg = await import('/src/nodes/registry.ts');
    const anim = await import('/src/animation/theme.ts');
    return { nodes: reg.NODE_EDITOR_COLORS.back, anim: anim.C.back };
  });
  expect(canvas).toEqual({ nodes: '#d7dade', anim: '#eef0f2' });

  // a colour edit on top of the preset
  await page.evaluate(async () => (await import('/src/prefs/theme_ui.ts')).setThemeColor('accent', '#aa00aa'));
  expect(await rootVar(page, '--accent')).toBe('#aa00aa');
  await expect(page.locator('.th-row.edited')).toHaveCount(1);
  const text = await page.evaluate(async () => (await import('/src/prefs/theme_ui.ts')).exportThemeText('Mine'));

  await page.reload();
  await page.waitForFunction(() => !!(window as unknown as { app?: unknown }).app);
  await page.waitForTimeout(400);
  expect(await rootVar(page, '--accent')).toBe('#aa00aa');
  expect(await rootVar(page, '--c-region')).toBe('#eef0f2');

  await page.evaluate(() => (window as unknown as { app: { run(id: string, p: object): void } }).app.run('wm.read_factory_userpref', { confirm: false }));
  expect(await rootVar(page, '--c-region')).toBe('#303030');
  expect(await rootVar(page, '--accent')).toBe('#4772b3');

  const name = await page.evaluate(async (t) => (await import('/src/prefs/theme_ui.ts')).importThemeText(t, 'x'), text);
  expect(name).toBe('Mine');
  expect(await rootVar(page, '--accent')).toBe('#aa00aa');
  await expectNoErrors(errors);
});

async function setPref(page: Page, key: string, value: unknown) {
  await page.evaluate(async ([k, v]) => (await import('/src/prefs/store.ts')).setPref(k as never, v as never), [key, value] as const);
}

test('interface preferences: factor display, header position, status bar, navigation controls, info overlay', async ({ page }) => {
  const errors = await openApp(page);
  await openPrefs(page, 'INTERFACE');
  // a real click on a preference control
  await page.locator('[data-id="pf-show_statusbar_version"]').dispatchEvent('pointerdown', { button: 0 });
  await expect(page.locator('.sb-version')).toHaveCount(0);
  await page.locator('.prefs-main .enum-row button', { hasText: 'Percentage' }).click();
  await closePrefs(page);
  // the Roughness factor of the default material shows as a percentage
  const pct = await page.evaluate(async () => {
    const w = await import('/src/ui/widgets.ts');
    const div = document.createElement('div');
    const { patch } = await import('/src/ui/h.ts');
    patch(div, [w.numberField({ id: 'x-test', value: 0.25, unit: 'factor', set: () => {} })]);
    return div.querySelector('.num-value')!.textContent;
  });
  expect(pct).toBe('25%');

  await setPref(page, 'header_align', 'BOTTOM');
  await expect(page.locator('.area[data-editor="VIEW_3D"]').first()).toHaveClass(/header-bottom/);
  await setPref(page, 'header_align', 'NONE');
  await expect(page.locator('.area[data-editor="VIEW_3D"]').first()).not.toHaveClass(/header-bottom/);

  await expect(page.locator('.nav-buttons').first()).toBeVisible();
  await setPref(page, 'show_navigate_ui', false);
  await expect(page.locator('.nav-buttons')).toHaveCount(0);

  await setPref(page, 'show_view_name', false);
  await expect(page.locator('.v3d-info-line', { hasText: 'Perspective' })).toHaveCount(0);
  await expect(page.locator('.v3d-info-line', { hasText: 'Cube' }).first()).toBeVisible();

  await setPref(page, 'show_statusbar_scene_duration', true);
  await expect(page.locator('.sb-duration')).toContainText('Frames 250');
  await expectNoErrors(errors);
});

test('editing and animation preferences change what operators do', async ({ page }) => {
  const errors = await openApp(page);
  await setPref(page, 'use_enter_edit_mode', true);
  await setPref(page, 'object_align', 'CURSOR');
  const added = await page.evaluate(() => {
    const a = (window as unknown as { app: { run(id: string, p?: object, o?: object): string; doc: { mode: string } } }).app;
    a.run('mesh.primitive_cube_add', {}, { invoke: true });
    return a.doc.mode;
  });
  expect(added).toBe('EDIT');
  const alignDefault = await page.evaluate(async () => (await import('/src/app/app.ts')).operators.get('mesh.primitive_cube_add')!.props!.find((p) => p.id === 'align')!.default);
  expect(alignDefault).toBe('CURSOR');

  // Copy on Duplicate: meshes stay shared when turned off
  await page.evaluate(() => (window as unknown as { app: { run(id: string, p?: object): string } }).app.run('object.mode_set', { mode: 'OBJECT' }));
  await page.evaluate(async () => (await import('/src/prefs/store.ts')).setPref('duplicate', { ...(await import('/src/app/prefs.ts')).prefs.duplicate, MESH: false }));
  const shared = await page.evaluate(async () => {
    const a = (window as unknown as { app: { run(id: string, p?: object): string; activeObject: { data: string } } }).app;
    const before = a.activeObject.data;
    const { duplicateSelected } = await import('/src/ops/object.ts');
    const copies = duplicateSelected((a as unknown as { doc: never }).doc, false);
    return copies[0].data === before;
  });
  expect(shared).toBe(true);

  // new keyframes use the default interpolation; negative frames can be blocked
  await setPref(page, 'keyframe_new_interpolation_type', 'LINEAR');
  await setPref(page, 'use_negative_frames', false);
  const anim = await page.evaluate(async () => {
    const a = (window as unknown as { app: { doc: any; activeObject: any; setFrame(f: number): void } }).app;
    const { keyProperty } = await import('/src/anim/keyframes.ts');
    keyProperty(a.doc, a.activeObject, 'location');
    const act = a.doc.actions[a.activeObject.animation_data.action];
    a.setFrame(-5);
    return { interp: act.fcurves[0].keyframe_points[0].interpolation, frame: a.doc.scene.frame_current };
  });
  expect(anim).toEqual({ interp: 'LINEAR', frame: 0 });
  await expectNoErrors(errors);
});

test('navigation preferences: numpad orbit step and smooth view', async ({ page }) => {
  const errors = await openApp(page);
  await setPref(page, 'rotation_angle', 90);
  await setPref(page, 'smooth_view', 0);
  await hoverViewport(page);
  const yaw = async () => page.evaluate(async () => {
    const v = (await import('/src/editors/view3d/view3d.ts')).activeView3D()!;
    const f = v.nav.forward;
    return (Math.atan2(f.y, f.x) * 180) / Math.PI;
  });
  const a0 = await yaw();
  await page.keyboard.press('Numpad4');
  const a1 = await yaw();
  expect(Math.abs((((a1 - a0 + 540) % 360) - 180))).toBeCloseTo(90, 0);
  await expectNoErrors(errors);
});

test('auto-save preferences off: changes wait for Save Preferences; revert restores them', async ({ page }) => {
  const errors = await openApp(page);
  await openPrefs(page, 'INTERFACE');
  await page.locator('.prefs-menu-btn').dispatchEvent('pointerdown');
  await page.locator('.menu-item', { hasText: 'Auto-Save Preferences' }).click();
  await setPref(page, 'show_splash', false);
  const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('p3d.preferences.v1') ?? '{}').show_splash);
  expect(await stored()).not.toBe(false);
  await expect(page.locator('.prefs-save')).toBeVisible();
  await page.locator('.prefs-menu-btn').dispatchEvent('pointerdown');
  await page.locator('.menu-item', { hasText: 'Revert to Saved Preferences' }).click();
  expect(await page.evaluate(async () => (await import('/src/app/prefs.ts')).prefs.show_splash)).toBe(true);
  await setPref(page, 'show_splash', false);
  await page.locator('.prefs-save').click();
  expect(await stored()).toBe(false);
  await expectNoErrors(errors);
});
