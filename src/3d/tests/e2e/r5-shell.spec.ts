// Shared UI shell: menus, popups and fields in narrow windows and with the keyboard.
import { test, expect, type Page } from '@playwright/test';
import { openApp, expectNoErrors } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
const menuBoxes = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.popup-layer > .menu')].map((e) => {
      const r = e.getBoundingClientRect();
      return { left: r.left, right: r.right, scrollW: e.scrollWidth, clientW: e.clientWidth };
    }),
  );

test('a phone-width window keeps the editor type menu and the search popup on screen', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  const errors = await openApp(page);
  await page.locator('.area .editor-type').first().click();
  // the columns don't fit: every editor is reachable in one list inside the window
  await expect(page.locator('.menu .menu-item', { hasText: 'Spreadsheet' })).toBeVisible();
  let boxes = await menuBoxes(page);
  expect(boxes).toHaveLength(1);
  expect(boxes[0].right).toBeLessThanOrEqual(320);
  expect(boxes[0].scrollW).toBeLessThanOrEqual(boxes[0].clientW);
  await page.locator('.menu .menu-item', { hasText: 'Spreadsheet' }).scrollIntoViewIfNeeded();
  await page.keyboard.press('Escape');
  await page.mouse.move(160, 300);
  await page.keyboard.press('F3');
  await expect(page.locator('.search-popup')).toBeVisible();
  boxes = await menuBoxes(page);
  expect(boxes[0].left).toBeGreaterThanOrEqual(0);
  expect(boxes[0].right).toBeLessThanOrEqual(320);
  await page.keyboard.press('Escape');
  await expectNoErrors(errors);
});

/** The keys an input method sends while composing text (Enter picks a candidate, Esc drops it). */
const composingKey = (page: Page, selector: string, key: string) =>
  page.evaluate(
    ([sel, k]) => document.querySelector(sel)!.dispatchEvent(new KeyboardEvent('keydown', { key: k, isComposing: true, bubbles: true, cancelable: true })),
    [selector, key] as const,
  );

test('Enter and Esc that end an input method composition leave rename fields open', async ({ page }) => {
  const errors = await openApp(page);
  const v = (await page.locator('.area[data-editor="VIEW_3D"]').first().boundingBox())!;
  await page.mouse.move(v.x + v.width / 2, v.y + v.height / 2);
  // F2 in the 3D view: the rename prompt
  await page.keyboard.press('F2');
  const prompt = page.locator('.prompt-popup .prompt-input');
  await expect(prompt).toBeFocused();
  await prompt.fill('箱');
  await composingKey(page, '.prompt-popup .prompt-input', 'Enter');
  await composingKey(page, '.prompt-popup .prompt-input', 'Escape');
  await expect(prompt).toBeVisible();
  await prompt.press('Enter');
  expect(await page.evaluate(() => (window as any).app.activeObject.name)).toBe('箱');
  // the outliner's rename field
  await page.locator('.outliner .ol-row .ol-name', { hasText: /^箱$/ }).dblclick();
  const ol = page.locator('.outliner .ol-rename');
  await expect(ol).toBeVisible();
  await ol.fill('立方体');
  await composingKey(page, '.outliner .ol-rename', 'Enter');
  await composingKey(page, '.outliner .ol-rename', 'Escape');
  await expect(ol).toBeVisible();
  await ol.press('Enter');
  expect(await page.evaluate(() => (window as any).app.activeObject.name)).toBe('立方体');
  // a number field being typed into
  const field = page.locator('.properties .num-field[data-id]').first();
  await field.click();
  const input = page.locator('.properties input.num-field.editing');
  await expect(input).toBeFocused();
  await composingKey(page, '.properties input.num-field.editing', 'Escape');
  await expect(input).toBeVisible();
  await input.press('Escape');
  await expect(input).toHaveCount(0);
  await expectNoErrors(errors);
});

test('a damaged screen layout in a file leaves the workspace usable', async ({ page }) => {
  const errors = await openApp(page);
  const r = await page.evaluate(async () => {
    const { projectUiState } = await import('/src/io/files.ts');
    const { shell } = await import('/src/ui/shell.ts');
    // a split with one child, a list entry that is not a workspace
    projectUiState.load({ workspace: 'Layout', workspaces: [null, { name: 'Layout' }], layouts: { Layout: { split: 'h', ratio: 0.5, a: { area: { id: 'x1', type: 'VIEW_3D' } } } } });
    return { areas: shell.screen.areas.length, active: shell.active };
  });
  expect(r.active).toBe('Layout');
  expect(r.areas).toBeGreaterThan(1);
  await expect(page.locator('.area[data-editor="VIEW_3D"]')).toHaveCount(1);
  await expectNoErrors(errors);
});

test('Enter over the 3D view does not click the last button clicked with the mouse again', async ({ page }) => {
  const errors = await openApp(page);
  await page.locator('.properties [data-tab="PHYSICS"]').first().click();
  await page.locator('.properties button', { hasText: 'Collision' }).click();
  const mods = () => page.evaluate(() => (window as any).app.activeObject.modifiers.map((m: { type: string }) => m.type));
  expect(await mods()).toEqual(['COLLISION']);
  const v = (await page.locator('.area[data-editor="VIEW_3D"]').first().boundingBox())!;
  await page.mouse.move(v.x + v.width / 2, v.y + v.height / 2);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(100);
  expect(await mods()).toEqual(['COLLISION']);
  // a button reached with the keyboard still takes Enter
  await page.locator('.properties button', { hasText: 'Cloth' }).focus();
  await page.keyboard.press('Enter');
  await expect.poll(mods).toContain('CLOTH');
  await expectNoErrors(errors);
});

test('Esc in a text field drops the typed text instead of committing it', async ({ page }) => {
  const errors = await openApp(page);
  await page.locator('.properties [data-tab="OBJECT"]').first().click();
  const name = page.locator('.properties .id-row .text-field input').first();
  await expect(name).toHaveValue('Cube');
  await name.click();
  await name.fill('Typo');
  await name.press('Escape');
  await expect(name).not.toBeFocused();
  expect(await page.evaluate(() => (window as any).app.activeObject.name)).toBe('Cube');
  await expect(name).toHaveValue('Cube');
  // Enter still commits
  await name.click();
  await name.fill('Box');
  await name.press('Enter');
  expect(await page.evaluate(() => (window as any).app.activeObject.name)).toBe('Box');
  await expectNoErrors(errors);
});
