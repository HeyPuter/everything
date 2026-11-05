import { expect, test, type Page } from '@playwright/test';
import { openApp, waitForFeature } from './helpers';

async function seriousViolations(page: Page) {
  // Playwright resolves the path from the project directory.
  await page.addScriptTag({ path: 'node_modules/axe-core/axe.min.js' });
  const result = await page.evaluate(async () => {
    // @ts-expect-error axe is injected above
    const r = await window.axe.run(document, { resultTypes: ['violations'] });
    return r.violations
      .filter((v: { impact: string }) => v.impact === 'serious' || v.impact === 'critical')
      .map((v: { id: string; nodes: { target: string[] }[] }) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(', ')}`);
  });
  return result as string[];
}

test.describe('accessibility', () => {
  test('start screen has no serious violations', async ({ page }) => {
    await openApp(page);
    await expect(page.getByRole('dialog', { name: 'Parametric' })).toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);
  });

  test('modeling workspace has no serious violations', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: /Mounting Bracket/ }).click();
    await waitForFeature(page, 'Fillet1');
    expect(await seriousViolations(page)).toEqual([]);
  });

  test('feature panels with selection boxes pass axe in the dark theme', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await openApp(page);
    await page.getByRole('button', { name: /Mounting Bracket/ }).click();
    await waitForFeature(page, 'Fillet1');
    await page.getByRole('button', { name: 'Hole', exact: true }).click();
    await expect(page.getByRole('group', { name: 'Positions' })).toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);
  });

  test('a section enabled by a checkbox keeps the checkbox outside its expand button', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: /Mounting Bracket/ }).click();
    await waitForFeature(page, 'Fillet1');
    await page.getByRole('button', { name: 'Linear Pattern', exact: true }).click();
    const head = page.getByRole('button', { name: 'Direction 2' });
    const enable = page.getByRole('checkbox', { name: 'Enable Direction 2' });
    await expect(head).toHaveAttribute('aria-expanded', 'false');
    await expect(head.getByRole('checkbox')).toHaveCount(0);
    await enable.check();
    await expect(head).toHaveAttribute('aria-expanded', 'true');
    await head.click();
    await expect(head).toHaveAttribute('aria-expanded', 'false');
    await expect(enable).toBeChecked();
    expect(await seriousViolations(page)).toEqual([]);
  });

  test('part lists pass axe when empty and when filled', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: /New part/ }).click();
    const run = (id: string) => page.evaluate((id) => (window as unknown as { __parametric: { commands: { run(id: string): void } } }).__parametric.commands.run(id), id);
    await run('open');
    await expect(page.getByRole('dialog', { name: 'Open' })).toContainText('No parts saved');
    expect(await seriousViolations(page)).toEqual([]);
    await page.keyboard.press('Escape');
    await run('saveAs');
    await page.getByRole('dialog', { name: 'Save As' }).getByRole('textbox').fill('Bracket');
    await page.getByRole('button', { name: 'OK' }).click();
    await expect(page).toHaveTitle('Bracket - Parametric');
    await page.getByRole('tab', { name: 'Parts' }).click();
    await expect(page.locator('.tp-panel').getByRole('listitem').getByRole('button', { name: /Bracket/ })).toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);
  });

  test('the panel tabs are one tab stop moved with the arrow keys', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: /New part/ }).click();
    const tree = page.getByRole('tab', { name: 'Design tree' });
    const pm = page.getByRole('tab', { name: 'PropertyManager' });
    await expect(tree).toHaveAttribute('tabindex', '0');
    await expect(pm).toHaveAttribute('tabindex', '-1');
    await tree.focus();
    await page.keyboard.press('ArrowRight');
    await expect(pm).toBeFocused();
    await expect(pm).toHaveAttribute('aria-selected', 'true');
    await expect(tree).toHaveAttribute('tabindex', '-1');
    await page.keyboard.press('Home');
    await expect(tree).toBeFocused();
    await expect(tree).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('End');
    await expect(pm).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(tree).toBeFocused();
    await expect(page.getByRole('treeitem', { name: 'Front Plane' })).toBeVisible();
  });

  test('the arrow keys skip the hidden Drawing ribbon tab in the model', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: /New part/ }).click();
    await page.getByRole('tab', { name: 'Features' }).focus();
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByRole('tab', { name: 'View' })).toBeFocused();
    await expect(page.getByRole('tab', { name: 'View' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.cm-tools [data-cmd^="drawing:"]')).toHaveCount(0);
    await page.keyboard.press('Home');
    await expect(page.getByRole('tab', { name: 'Features' })).toBeFocused();
  });

  test('the task pane and sheet tabs are one tab stop each', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: /New part/ }).click();
    const strip = page.getByRole('tablist', { name: 'Task pane' });
    await expect(strip.locator('[role="tab"][tabindex="0"]')).toHaveCount(1);
    await strip.getByRole('tab', { name: 'Assistant' }).focus();
    await page.keyboard.press('ArrowDown');
    const parts = strip.getByRole('tab', { name: 'Parts' });
    await expect(parts).toBeFocused();
    await expect(parts).toHaveAttribute('aria-selected', 'false');
    await page.keyboard.press('Enter');
    await expect(parts).toHaveAttribute('aria-selected', 'true');
    await expect(strip.locator('[role="tab"][tabindex="0"]')).toHaveCount(1);
    const sheets = page.getByRole('tablist', { name: 'Model or drawing' });
    await expect(sheets.getByRole('tab', { name: 'Drawing' })).toHaveAttribute('tabindex', '-1');
    await sheets.getByRole('tab', { name: 'Model' }).focus();
    await page.keyboard.press('End');
    await expect(sheets.getByRole('tab', { name: 'Drawing' })).toBeFocused();
  });

  test('menus are reachable from the keyboard', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: /New part/ }).click();
    await page.getByRole('menuitem', { name: 'File' }).focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('menu', { name: 'File' })).toBeVisible();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('menu', { name: 'Edit' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
  });

  test('the design tree keeps keyboard focus and a rename survives hovering the model', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: /Mounting Bracket/ }).click();
    await waitForFeature(page, 'Fillet1');
    const hole = page.getByRole('treeitem', { name: 'Hole1' });
    await hole.focus();
    // Space selects without opening the view orientation menu and keeps focus in the tree.
    await page.keyboard.press('Space');
    await expect(hole).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(hole).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('treeitem', { name: 'Fillet1' })).toBeFocused();
    await page.keyboard.press('ArrowUp');
    // Enter opens the feature for editing and leaves it open.
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Hole1' })).toBeVisible();
    await page.waitForTimeout(300);
    await expect(page.getByRole('heading', { name: 'Hole1' })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel', exact: true }).first().click();
    await page.getByRole('tab', { name: 'Design tree' }).click();
    await hole.focus();
    await page.keyboard.press('F2');
    const input = page.getByRole('textbox', { name: 'Feature name' });
    await expect(input).toBeFocused();
    await page.keyboard.type('Bolt holes');
    const box = (await page.locator('canvas.gl').boundingBox())!;
    for (let i = 0; i < 8; i++) await page.mouse.move(box.x + box.width * (0.3 + i * 0.05), box.y + box.height * (0.4 + i * 0.03));
    await page.waitForTimeout(300);
    await expect(input).toHaveValue('Bolt holes');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('treeitem', { name: 'Bolt holes' })).toBeFocused();
  });

  test('Enter and Space activate the focused button instead of global shortcuts', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: /Mounting Bracket/ }).click();
    await waitForFeature(page, 'Fillet1');
    // Something to repeat with Enter (Repeat Last Command).
    await page.getByRole('button', { name: 'Zoom to Fit' }).click();
    // After a click the focused button leaves Space to View Orientation.
    await page.keyboard.press('Space');
    await expect(page.getByRole('menu', { name: 'View orientation' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
    // Focus moved by the keyboard: the button wins.
    const perspective = page.getByRole('button', { name: 'Perspective' });
    await page.keyboard.press('Shift');
    await perspective.focus();
    await page.keyboard.press('Enter');
    await expect(perspective).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Section View' }).focus();
    await page.keyboard.press('Space');
    await expect(page.getByRole('heading', { name: 'Section View' })).toBeVisible();
    await expect(page.getByRole('menu')).toHaveCount(0);
  });

  test('command search reports its list state and platform shortcuts', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: /New part/ }).click();
    const search = page.getByRole('combobox', { name: 'Search commands' });
    await search.fill('save');
    await expect(search).toHaveAttribute('aria-expanded', 'true');
    const mac = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent));
    await expect(page.getByRole('option', { name: /^Save/ }).first()).toContainText(mac ? '⌘S' : 'Ctrl+S');
    await page.locator('canvas.gl').click({ position: { x: 40, y: 40 } });
    await expect(page.getByRole('listbox')).toBeHidden();
    await expect(search).toHaveAttribute('aria-expanded', 'false');
  });
});


test('focus returns to the re-rendered tree row after a dialog closes', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  await page.getByRole('treeitem', { name: 'Hole1' }).focus();
  await page.keyboard.press('Delete');
  await expect(page.getByRole('dialog', { name: 'Delete' })).toBeVisible();
  // A rebuild finishing while the dialog is open re-renders the tree rows.
  await page.evaluate(() => (window as unknown as { __parametric: { renderTrees(): void } }).__parametric.renderTrees());
  await page.keyboard.press('Escape');
  await expect(page.getByRole('treeitem', { name: 'Hole1' })).toBeFocused();
});

test('Shift+F10 opens the context menu of the focused tree row', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  const hole = page.getByRole('treeitem', { name: 'Hole1' });
  await hole.focus();
  await page.keyboard.press('Shift+F10');
  await expect(page.getByRole('menu', { name: 'Feature menu' })).toHaveCount(1);
  await expect(page.getByRole('menuitem', { name: 'Edit Feature' })).toBeFocused();
  await expect(hole).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(page.getByRole('treeitem', { name: 'Hole1' })).toBeFocused();
});

test('F6 and Shift+F6 move between the window regions', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  const canvas = page.locator('canvas.gl');
  await canvas.focus();
  // From the graphics area back to the design tree's current row in one press.
  await page.keyboard.press('Shift+F6');
  await expect(page.getByRole('treeitem', { name: 'Mounting Bracket' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  const row = page.locator('.leftpane .ti:focus');
  const name = await row.getAttribute('aria-label') ?? await row.innerText();
  await page.keyboard.press('F6');
  await expect(canvas).toBeFocused();
  // Around every region (task pane, status bar, title bar, CommandManager, left pane) and back.
  const regions: string[] = [];
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('F6');
    regions.push(await page.evaluate(() => document.activeElement?.closest('.titlebar, .cm, .leftpane, .viewport, .taskpane, .statusbar')?.classList[0] ?? 'none'));
  }
  expect(regions).toEqual(['taskpane', 'statusbar', 'titlebar', 'cm', 'leftpane', 'viewport']);
  // The left pane gives focus back to the row it had.
  await page.keyboard.press('Shift+F6');
  await expect(page.locator('.leftpane .ti:focus')).toHaveCount(1);
  expect(await page.locator('.leftpane .ti:focus').getAttribute('aria-label') ?? await page.locator('.leftpane .ti:focus').innerText()).toBe(name);
  // A text field cycles too, as in desktop apps.
  await page.getByRole('combobox', { name: 'Search commands' }).focus();
  await page.keyboard.press('F6');
  await expect(page.locator('.cm :focus')).toHaveCount(1);
  // Listed with the shortcuts.
  await canvas.focus();
  await page.keyboard.press('F1');
  await expect(page.getByRole('dialog', { name: 'Keyboard Shortcuts' })).toContainText('F6, Shift + F6');
});

test('Shift+Tab after clicking a dialog\'s text stays in the dialog', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  await page.evaluate(() => (window as unknown as { __parametric: { commands: { run(id: string): void } } }).__parametric.commands.run('about'));
  const dialog = page.getByRole('dialog');
  await dialog.locator('.dialog-body').click({ position: { x: 4, y: 4 } });
  await page.keyboard.press('Shift+Tab');
  expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true);
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true);
});

test('the shortcuts list names each command once with all its keys', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  await page.locator('canvas.gl').focus();
  await page.keyboard.press('F1');
  const dialog = page.getByRole('dialog', { name: 'Keyboard Shortcuts' });
  await expect(dialog.locator('.shortcut-grid').getByText('Redo', { exact: true })).toHaveCount(1);
  await expect(dialog.locator('.shortcut-grid').getByText('Keyboard Shortcuts', { exact: true })).toHaveCount(1);
  await expect(dialog).toContainText('F2');
  await expect(dialog).toContainText('Shift + F10');
});

test('editing and deleting equations keeps keyboard focus in the table', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  await page.evaluate(() => (window as unknown as { __parametric: { commands: { run(id: string): void } } }).__parametric.commands.run('equations'));
  const dialog = page.getByRole('dialog', { name: 'Equations and Global Variables' });
  await dialog.getByRole('button', { name: 'Add variable' }).click();
  await dialog.getByRole('button', { name: 'Add variable' }).click();
  const name = dialog.getByRole('textbox', { name: 'Name of variable 1' });
  await name.fill('Width');
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('textbox', { name: 'Value or expression of Width' })).toBeFocused();
  await dialog.getByRole('button', { name: 'Delete Width' }).click();
  await expect(dialog.getByRole('button', { name: 'Delete Var2' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog.getByRole('button', { name: 'Add variable' })).toBeFocused();
});

test('picking a colour and closing the task pane keep keyboard focus', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  await page.getByRole('tab', { name: 'Appearance' }).click();
  const swatch = page.getByRole('button', { name: 'Colour #4f8fc0' });
  await swatch.focus();
  await page.keyboard.press('Enter');
  await expect(swatch).toHaveAttribute('aria-pressed', 'true');
  await expect(swatch).toBeFocused();
  await page.getByRole('button', { name: 'Close task pane' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('tab', { name: 'Appearance' })).toBeFocused();
});

test('Esc pressed straight after a dialog opens closes it', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  await page.getByRole('treeitem', { name: 'Hole1' }).focus();
  // Both keys in one task: no frame passes between them.
  await page.evaluate(() => {
    const row = document.activeElement!;
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }));
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('treeitem', { name: 'Hole1' })).toBeFocused();
});

test('a submenu with no room on the right opens beside its parent menu, not over it', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  await page.evaluate(async () => {
    // The dev server serves the app's modules; this is the instance the app uses.
    const url = '/src/ui/menu.ts';
    const m = await import(/* @vite-ignore */ url) as typeof import('../../src/ui/menu');
    m.openMenu([{ label: 'Edit Extrude1 with a rather long descriptive name' }, { label: 'View Orientation', submenu: () => [{ label: 'Front' }] }], 1270, 300);
  });
  await page.getByRole('menuitem', { name: 'View Orientation' }).hover();
  await expect(page.locator('.menu')).toHaveCount(2);
  const parent = (await page.locator('.menu').nth(0).boundingBox())!;
  const sub = (await page.locator('.menu').nth(1).boundingBox())!;
  expect(sub.x + sub.width).toBeLessThanOrEqual(parent.x + 4);
});
