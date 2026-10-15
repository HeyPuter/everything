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
