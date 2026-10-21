// Preferences: Get Extensions (offline packages), keymap operators, asset libraries, excluded
// auto-run paths, studio light and theme operators, section order.
import { test, expect, type Page } from '@playwright/test';
import { openApp, expectNoErrors } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
const run = (page: Page, op: string, props: Record<string, unknown> = {}) => page.evaluate(([o, p]) => (window as any).app.run(o, p), [op, props] as const);

test('Get Extensions: install a package, toggle, uninstall; themes too', async ({ page }) => {
  const errors = await openApp(page);
  await run(page, 'screen.userpref_show', { section: 'EXTENSIONS' });
  const prefs = page.locator('.prefs-editor');
  await expect(prefs.locator('.prefs-nav-btn.on')).toHaveText('Get Extensions');
  // install the example add-on package and a theme package built in the page
  const ids = await page.evaluate(async () => {
    const m = await import('/src/prefs/extensions.ts');
    const { zipSync, strToU8 } = await import('/node_modules/three/examples/jsm/libs/fflate.module.js' as string);
    const a = await m.installPackage(m.examplePackage(), {});
    const theme = { format: 'p3d-theme', version: 1, name: 'x', values: { accent: '#ff8800' } };
    const manifest = { schema: 1, id: 'orange_theme', name: 'Orange Accent', version: '0.2', type: 'theme', entry: 'theme.json', tags: ['Theme'] };
    const t = await m.installPackage(zipSync({ 'extension.json': strToU8(JSON.stringify(manifest)), 'theme.json': strToU8(JSON.stringify(theme)) }), { enable: false });
    return [a, t];
  });
  expect(ids).toEqual(['hello_extension', 'orange_theme']);
  await expect(prefs.locator('.ext-item')).toHaveCount(2);
  // the add-on is enabled and registered its operator
  expect(await page.evaluate(() => (window as any).app.run('wm.hello_extension_greet'))).toBe('FINISHED');
  // filter by type
  await prefs.locator('.ext-toolbar .enum-menu').click();
  await page.locator('.menu .menu-item', { hasText: 'Themes' }).click();
  await expect(prefs.locator('.ext-item')).toHaveCount(1);
  await expect(prefs.locator('.ext-item .ext-name')).toHaveText('Orange Accent');
  // enable the theme
  await prefs.locator('.ext-item .ext-toggle').click();
  await expect.poll(() => page.evaluate(async () => (await import('/src/prefs/theme_ui.ts')).themeState.preset)).toBe('user:Orange Accent');
  await run(page, 'extensions.package_theme_disable', { pkg_id: 'orange_theme' });
  await expect.poll(() => page.evaluate(async () => (await import('/src/prefs/theme_ui.ts')).themeState.preset)).toBe('DEFAULT');
  // a broken package reports why
  const err = await page.evaluate(async () => {
    const m = await import('/src/prefs/extensions.ts');
    const { zipSync, strToU8 } = await import('/node_modules/three/examples/jsm/libs/fflate.module.js' as string);
    try {
      await m.installPackage(zipSync({ 'extension.json': strToU8('{"schema":1,"id":"Bad Id"}') }));
      return '';
    } catch (e) {
      return (e as Error).message;
    }
  });
  expect(err).toMatch(/lowercase/);
  // uninstall the add-on: its operator goes away
  await run(page, 'extensions.package_uninstall', { pkg_id: 'hello_extension' });
  await expect.poll(() => page.evaluate(async () => (await import('/src/prefs/extensions.ts')).extensions.size)).toBe(1);
  await expect.poll(() => page.evaluate(async () => (await import('/src/app/app.ts')).operators.has('wm.hello_extension_greet'))).toBe(false);
  await expectNoErrors(errors);
});

test('Preferences sections follow the reference order; keymap and path operators', async ({ page }) => {
  const errors = await openApp(page);
  await run(page, 'screen.userpref_show', { section: 'KEYMAP' });
  const labels = await page.locator('.prefs-nav-btn').allTextContents();
  expect(labels).toEqual(['Interface', 'Viewport', 'Lights', 'Editing', 'Animation', 'Get Extensions', 'Add-ons', 'Themes', 'Asset Libraries', 'Input', 'Navigation', 'Keymap', 'System', 'Save & Load', 'File Paths']);
  // keymap items: add one to a keymap, remove a default one and restore it
  const r = await page.evaluate(async () => {
    const a = (window as any).app;
    const km = (await import('/src/app/keymap.ts')).keymaps;
    const n0 = km['Info'].length;
    a.run('preferences.keyitem_add', { keymap: 'Info' });
    const n1 = km['Info'].length;
    const i = km['Info'].findIndex((k: any) => k.op === 'info.report_replay');
    a.run('preferences.keyitem_remove', { keymap: 'Info', item_id: i });
    const removed = !!km['Info'][i]?.inactive || !km['Info'].some((k: any) => k.op === 'info.report_replay' && !k.inactive);
    a.run('preferences.keymap_restore', { keymap: 'Info' });
    const back = km['Info'].some((k: any) => k.op === 'info.report_replay' && !k.inactive);
    const n2 = km['Info'].length;
    a.run('preferences.keyconfig_test');
    return { n0, n1, n2, removed, back, report: a.reports.at(-1).message };
  });
  expect(r.n1).toBe(r.n0 + 1);
  expect(r.removed).toBe(true);
  expect(r.back).toBe(true);
  expect(r.n2).toBe(r.n0);
  expect(r.report).toMatch(/key conflict|No key conflicts/);
  // excluded auto-run paths
  await run(page, 'screen.userpref_show', { section: 'SAVE_LOAD' });
  await page.locator('.btn', { hasText: 'Add Path' }).click();
  await expect(page.locator('.pl-item input')).toHaveCount(1);
  await page.locator('.pl-item input').fill('downloads_*');
  await page.locator('.pl-item input').press('Enter');
  expect(await page.evaluate(async () => (await import('/src/app/prefs.ts')).prefs.autoexec_paths)).toEqual(['downloads_*']);
  await run(page, 'preferences.autoexec_path_remove', { index: 0 });
  expect(await page.evaluate(async () => (await import('/src/app/prefs.ts')).prefs.autoexec_paths)).toEqual([]);
  // asset libraries: add one, it is listed, remove it
  await run(page, 'preferences.asset_library_add', { name: 'Props' });
  await run(page, 'screen.userpref_show', { section: 'ASSET_LIBRARIES' });
  await expect(page.locator('.pl-item input[value="Props"], .pl-item .text-field input').first()).toBeVisible();
  await expect.poll(() => page.evaluate(async () => (await import('/src/assets/library.ts')).userLibraries().map((l: any) => l.name))).toContain('Props');
  const idx = await page.evaluate(async () => (await import('/src/assets/library.ts')).userLibraries().findIndex((l: any) => l.name === 'Props'));
  await run(page, 'preferences.asset_library_remove', { index: idx });
  await expect.poll(() => page.evaluate(async () => (await import('/src/assets/library.ts')).userLibraries().map((l: any) => l.name))).not.toContain('Props');
  // studio lights: save a copy, copy settings, uninstall it; theme reset
  const sl = await page.evaluate(async () => {
    const a = (window as any).app;
    const { library } = await import('/src/render/studiolights.ts');
    const n = library.studio.length;
    a.run('preferences.studiolight_new', { filename: 'My Light' });
    const made = library.studio.length === n + 1 && library.studio.at(-1).name === 'My Light';
    a.run('preferences.studiolight_copy_settings', { index: 0 });
    a.run('preferences.studiolight_uninstall', { index: library.studio.length - 1, type: 'STUDIO' });
    a.run('preferences.reset_default_theme');
    return { made, after: library.studio.length === n };
  });
  expect(sl).toEqual({ made: true, after: true });
  await expectNoErrors(errors);
});

test('Reload Scripts runs the enabled add-ons again', async ({ page }) => {
  const errors = await openApp(page);
  await page.evaluate(async () => {
    const m = await import('/src/prefs/extensions.ts');
    await m.installPackage(m.examplePackage(), {});
  });
  await run(page, 'script.reload');
  await expect.poll(() => page.evaluate(() => (window as any).app.reports.at(-1)?.message)).toMatch(/Reloaded 1 add-on/);
  expect(await page.evaluate(() => (window as any).app.run('wm.hello_extension_greet'))).toBe('FINISHED');
  await expectNoErrors(errors);
});

test('workspace add-on filter hides the panels of add-ons not listed', async ({ page }) => {
  const errors = await openApp(page);
  await page.evaluate(async () => {
    const { installAddon } = await import('/src/prefs/addons.ts');
    const { EXAMPLE_ADDON } = await import('/src/prefs/addon_example.ts');
    await installAddon(EXAMPLE_ADDON.filename, EXAMPLE_ADDON.source);
  });
  const visible = () => page.evaluate(async () => (await import('/src/scripting/registry.ts')).panelVisibility.test([...(await import('/src/scripting/registry.ts')).scriptPanels.keys()][0]));
  expect(await visible()).toBe(true);
  // turn the filter on for the active workspace: the add-on's panel hides until listed
  await page.evaluate(async () => {
    const ws = (await import('/src/ui/shellref.ts')).shellRef.current!;
    ws.workspaces.find((w: any) => w.name === ws.active)!.use_filter_by_owner = true;
  });
  expect(await visible()).toBe(false);
  await run(page, 'wm.owner_enable', { owner_id: 'scatter_cubes' });
  expect(await visible()).toBe(true);
  await run(page, 'wm.owner_disable', { owner_id: 'scatter_cubes' });
  expect(await visible()).toBe(false);
  // the Workspace panel of the 3D view's Tool tab lists the add-on
  await page.locator('.area[data-editor="VIEW_3D"]').hover();
  await page.keyboard.press('n');
  await page.locator('.v3d-sidebar .sb-tab', { hasText: 'Tool' }).click();
  await expect(page.locator('.v3d-sidebar .panel.sub', { hasText: 'Filter Add-ons' })).toBeVisible();
  await expectNoErrors(errors);
});

test('dropping a package on Get Extensions installs it', async ({ page }) => {
  const errors = await openApp(page);
  await run(page, 'screen.userpref_show', { section: 'EXTENSIONS' });
  await expect(page.locator('.ext-drop')).toBeVisible();
  await page.evaluate(async () => {
    const m = await import('/src/prefs/extensions.ts');
    const bytes = m.examplePackage();
    const dt = new DataTransfer();
    dt.items.add(new File([bytes as BlobPart], 'hello_extension.zip', { type: 'application/zip' }));
    const el = document.querySelector('.ext-drop')!;
    el.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
    el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await expect(page.locator('.ext-item .ext-name')).toHaveText('Hello Extension');
  await expectNoErrors(errors);
});
