import { test, expect } from '@playwright/test';
import { boot, menu, openImage, run, start } from './helpers';

test.beforeEach(async ({ page }) => {
  await boot(page);
  await openImage(page, 200, 150, '#808080', 'gray.png');
});

const tabsIn = (page: import('@playwright/test').Page, loc: string) => page.locator(`.panel-group[data-location="${loc}"] [data-panel-tab]`);

test('workspaces rearrange the dock, remember changes and reset', async ({ page }) => {
  await menu(page, 'Window', 'Workspace', 'Photography');
  await expect(tabsIn(page, 'dock-top')).toHaveText(['Histogram', 'Navigator', 'Info']);
  await expect(page.locator('[data-strip-panel="color"]')).toBeVisible();
  // A panel dragged into another group stays there for this workspace.
  await page.locator('[data-strip-panel="color"]').dragTo(page.locator('.panel-group[data-location="dock-top"] .panel-tabs'), { targetPosition: { x: 4, y: 8 } });
  await expect(tabsIn(page, 'dock-top')).toHaveText(['Color', 'Histogram', 'Navigator', 'Info']);
  await menu(page, 'Window', 'Workspace', 'Essentials');
  await expect(tabsIn(page, 'dock-top').first()).toHaveText('Color');
  await expect(page.locator('[data-strip-panel="histogram"]')).toBeVisible();
  await menu(page, 'Window', 'Workspace', 'Photography');
  await expect(tabsIn(page, 'dock-top')).toHaveText(['Color', 'Histogram', 'Navigator', 'Info']);
  await menu(page, 'Window', 'Workspace', 'Reset Photography');
  await expect(tabsIn(page, 'dock-top')).toHaveText(['Histogram', 'Navigator', 'Info']);
  // Locked workspaces keep their tabs in place.
  await run(page, 'window.workspace-lock');
  await expect(page.locator('[data-panel-tab="histogram"]')).toHaveAttribute('draggable', 'false');
  await run(page, 'window.workspace-lock');
  await expect(page.locator('[data-panel-tab="histogram"]')).toHaveAttribute('draggable', 'true');
});

test('the Motion workspace opens the Timeline under the canvas, never as an empty side-dock tab', async ({ page }) => {
  await menu(page, 'Window', 'Workspace', 'Motion');
  await expect(page.locator('.bottom-dock [data-bottom-tab="timeline"]')).toBeVisible();
  await expect(page.locator('.bottom-dock .timeline-empty')).toBeVisible();
  await expect(tabsIn(page, 'dock-bottom')).toHaveText(['Layers', 'History']);
  // No other workspace puts it in the icon strip either.
  await menu(page, 'Window', 'Workspace', 'Photography');
  await expect(page.locator('[data-strip-panel="timeline"], [data-panel-tab="timeline"]')).toHaveCount(0);
  // A layout stored by an earlier version that docked it at the side.
  await page.evaluate(() => {
    const d = window.photoStudio.dock;
    d.setLayout({ ...d.getLayout(), placement: { timeline: 'dock-bottom' }, active: { 'dock-bottom': 'timeline' } });
  });
  await expect(page.locator('[data-panel-tab="timeline"]')).toHaveCount(0);
  await expect(page.locator('.dock-column [data-panel="timeline"]')).toHaveCount(0);
});

test('saved workspaces appear in the menu and can be deleted', async ({ page }) => {
  await menu(page, 'Window', 'Workspace', 'Painting');
  await menu(page, 'Window', 'Workspace', 'New Workspace…');
  await page.locator('dialog[open] input[name="name"]').fill('Studio');
  await page.locator('dialog[open] button.primary').click();
  await menu(page, 'Window', 'Workspace', 'Essentials');
  await expect(tabsIn(page, 'dock-middle').first()).toHaveText('Properties');
  await menu(page, 'Window', 'Workspace', 'Studio');
  await expect(tabsIn(page, 'dock-middle').first()).toHaveText('Brush Settings');
  await menu(page, 'Window', 'Workspace', 'Delete Workspace…');
  await page.locator('dialog[open] button.primary').click();
  await page.getByRole('menubar').getByRole('menuitem', { name: 'Window', exact: true }).click();
  await page.locator('.menubar-entry.open .menu-item.has-submenu', { hasText: 'Workspace' }).hover();
  await expect(page.locator('.menubar-entry.open .menu-item[data-command^="window.workspace-user-"]')).toHaveCount(0);
  await expect(page.locator('.menubar-entry.open .menu-item[data-command="window.workspace-essentials"]')).toHaveAttribute('aria-checked', 'true');
});

test('options bar and tools panel toggle from the Window menu', async ({ page }) => {
  await menu(page, 'Window', 'Options');
  await expect(page.locator('.optionsbar')).toBeHidden();
  await menu(page, 'Window', 'Tools');
  await expect(page.locator('.toolbar')).toBeHidden();
  await expect(page.locator('#viewport')).toBeVisible();
  await menu(page, 'Window', 'Options');
  await menu(page, 'Window', 'Tools');
  await expect(page.locator('.optionsbar')).toBeVisible();
  await expect(page.locator('.toolbar')).toBeVisible();
});

test('toolbar and menu customization', async ({ page }) => {
  await menu(page, 'Edit', 'Toolbar…');
  await page.locator('dialog.toolbar-editor [data-move-tool="zoom"]').click();
  await page.locator('dialog.toolbar-editor button.primary').click();
  await expect(page.locator('[data-slot="zoom"]')).toHaveCount(0);
  await page.locator('[data-slot="extra"]').click();
  await page.getByRole('menuitemradio', { name: /Zoom Tool/ }).click();
  await expect.poll(() => page.evaluate(() => window.photoStudio.tool)).toBe('zoom');
  await expect(page.locator('[data-slot="extra"]')).toHaveAttribute('aria-pressed', 'true');
  await menu(page, 'Edit', 'Toolbar…');
  await page.locator('dialog.toolbar-editor [data-tbe-reset]').click();
  await page.locator('dialog.toolbar-editor button.primary').click();
  await expect(page.locator('[data-slot="zoom"]')).toHaveCount(1);
  await expect(page.locator('[data-slot="extra"]')).toHaveCount(0);

  await menu(page, 'Edit', 'Menus…');
  await page.locator('dialog.menu-editor [data-menu-tab="1"]').click();
  await page.locator('dialog.menu-editor [data-toggle-visible="edit.copy-merged"]').click();
  await page.locator('dialog.menu-editor select[data-menu-color="edit.copy"]').selectOption('blue');
  await page.locator('dialog.menu-editor button.primary').click();
  await page.getByRole('menubar').getByRole('menuitem', { name: 'Edit', exact: true }).click();
  await expect(page.locator('.menubar-entry.open .menu-item[data-command="edit.copy-merged"]')).toHaveCount(0);
  await expect(page.locator('.menubar-entry.open .menu-item[data-command="edit.copy"]')).toHaveClass(/menu-tag-blue/);
  await page.keyboard.press('Escape');
  // Hidden commands keep their shortcuts.
  const merged = await page.evaluate(async () => {
    const { commands } = await import('/src/app/registry.ts');
    return commands.get('edit.copy-merged')?.shortcut;
  });
  expect(merged).toBeTruthy();
});

test('tool presets save and restore tool options', async ({ page }) => {
  await page.locator('#viewport').focus();
  await page.keyboard.press('b');
  const size = page.locator('#tool-options input').first();
  await size.fill('77');
  await size.press('Enter');
  await start(page, 'tool.preset-new');
  await page.locator('dialog[open] input[name="name"]').fill('Big Brush');
  await page.locator('dialog[open] button.primary').click();
  await size.fill('5');
  await size.press('Enter');
  await page.locator('#tool-icon').click();
  await expect(page.locator('.tool-preset-picker [data-tool-preset]')).toHaveText(['Big Brush']);
  await page.locator('.tool-preset-picker [data-tool-preset]').click();
  await expect(size).toHaveValue('77');
  // The Tool Presets panel lists it and filters to the current tool.
  await page.evaluate(() => window.photoStudio.dock.show('tool-presets'));
  await expect(page.locator('.tool-presets-panel [data-tool-preset]')).toHaveCount(1);
  await page.keyboard.press('v');
  await expect(page.locator('.tool-presets-panel [data-tool-preset]')).toHaveCount(0);
  await page.locator('[data-current-tool-only]').uncheck();
  await expect(page.locator('.tool-presets-panel [data-tool-preset]')).toHaveCount(1);
});

test('preset manager reorders and deletes presets, and system info opens', async ({ page }) => {
  const swatches = () => page.evaluate(() => JSON.parse(localStorage.getItem('photo-studio-swatches') ?? '[]') as string[]);
  await menu(page, 'Edit', 'Presets', 'Preset Manager…');
  await page.locator('dialog.preset-manager [data-kind="swatches"]').click();
  const first = await page.locator('dialog.preset-manager .pm-row[data-index="0"] .pm-name').textContent();
  const second = await page.locator('dialog.preset-manager .pm-row[data-index="1"] .pm-name').textContent();
  await page.locator('dialog.preset-manager .pm-row[data-index="1"]').click();
  await page.locator('dialog.preset-manager [data-pm="up"]').click();
  expect((await swatches()).slice(0, 2)).toEqual([second!.toLowerCase(), first!.toLowerCase()]);
  const count = (await swatches()).length;
  await page.locator('dialog.preset-manager [data-pm="delete"]').click();
  expect(await swatches()).toHaveLength(count - 1);
  await page.locator('dialog.preset-manager button.primary').click();

  await menu(page, 'Help', 'System Info…');
  await expect(page.locator('dialog[open] .system-info')).toContainText(/WebGPU|WebGL2/);
  await expect(page.locator('dialog[open] [data-copy-info]')).toBeVisible();
});

test('the Delete button of a tool preset row works from the keyboard instead of applying the preset', async ({ page }) => {
  await page.evaluate(() => window.photoStudio.setTool('brush'));
  for (const name of ['Keep', 'Remove Me']) {
    await start(page, 'tool.preset-new');
    await page.locator('dialog[open] input[name="name"]').fill(name);
    await page.locator('dialog[open] button.primary').click();
  }
  await page.evaluate(() => {
    window.photoStudio.setTool('move');
    window.photoStudio.dock.show('tool-presets');
  });
  const panel = page.locator('.tool-presets-panel');
  await page.locator('[data-current-tool-only]').uncheck();
  await expect(panel.locator('[data-tool-preset]')).toHaveCount(2);
  await panel.getByRole('button', { name: 'Delete Remove Me' }).focus();
  await page.keyboard.press('Enter');
  await expect(panel.locator('[data-tool-preset]')).toHaveText(['Keep']);
  // Nothing was applied: the Move tool is still the current tool.
  expect(await page.evaluate(() => window.photoStudio.tool)).toBe('move');
  // Enter on the row itself still applies the preset.
  await panel.locator('[data-tool-preset]').focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => window.photoStudio.tool)).toBe('brush');
});
