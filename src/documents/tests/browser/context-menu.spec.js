import { test, expect } from '@playwright/test';
import { onTab } from './helpers/editor-tools.js';

const input = page => page.getByRole('textbox', { name: 'Document text' });

test('a right-click opens the document menu with no item chosen until the keyboard is used', async ({ page }) => {
  await page.goto('/mock.html#/new');
  await expect((await onTab(page, 'home')).getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  const canvas = page.locator('canvas.canvas-page').first();
  await canvas.click({ position: { x: 150, y: 110 } });
  await page.keyboard.type('Typed before the right-click');
  await canvas.click({ button: 'right', position: { x: 150, y: 110 } });
  const menu = page.getByRole('menu', { name: 'Document menu' });
  await expect(menu).toBeFocused();
  expect(await menu.evaluate(el => [...el.querySelectorAll('.menu-item')].some(item => getComputedStyle(item).outlineStyle !== 'none'))).toBe(false);
  // The pointer tints the item under it without a keyboard focus ring.
  await menu.getByRole('menuitem', { name: 'Paste', exact: true }).hover();
  expect(await menu.getByRole('menuitem', { name: 'Paste', exact: true }).evaluate(el => getComputedStyle(el).outlineStyle)).toBe('none');
  // The keyboard picks up from the menu: Down starts at the first item, with its ring.
  await page.keyboard.press('Escape');
  await expect(input(page)).toBeFocused();
  await canvas.click({ button: 'right', position: { x: 150, y: 110 } });
  await page.keyboard.press('ArrowDown');
  const undo = menu.getByRole('menuitem', { name: 'Undo', exact: true });
  await expect(undo).toBeFocused();
  expect(await undo.evaluate(el => getComputedStyle(el).outlineStyle)).toBe('solid');
  await page.keyboard.press('Enter');
  await expect(menu).toHaveCount(0);
  await expect(input(page)).toHaveValue('Typed before the ');
  // Up from a freshly opened menu goes to the last item.
  await canvas.click({ button: 'right', position: { x: 150, y: 110 } });
  await page.keyboard.press('ArrowUp');
  await expect(menu.getByRole('menuitem', { name: 'Print / Save as PDF', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
});

test('a right-click in a table offers its row and column commands', async ({ page }) => {
  await page.goto('/mock.html#/new');
  await expect((await onTab(page, 'home')).getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await (await onTab(page, 'insert')).getByRole('button', { name: 'Insert table', exact: true }).click();
  await page.getByRole('button', { name: 'Insert', exact: true }).click();
  await page.keyboard.type('A1');
  const shape = () => page.evaluate(() => window.__docs.current.view.engine.model.tables.map(t => [t.rows.length, t.rows[0].cells.length]));
  expect(await shape()).toEqual([[2, 2]]);
  const canvas = page.locator('canvas.canvas-page').first(), menu = page.getByRole('menu', { name: 'Document menu' });
  const choose = async (first, ...path) => { await canvas.click({ button: 'right', position: { x: 120, y: 150 } }); await menu.getByRole('menuitem', { name: first, exact: true }).click(); for (const name of path) await page.getByRole('menu').getByRole('menuitem', { name, exact: true }).click(); };
  await canvas.click({ button: 'right', position: { x: 120, y: 150 } });
  await expect(menu.getByRole('menuitem', { name: 'Merge Cells', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await choose('Insert', 'Insert Rows Below'); expect(await shape()).toEqual([[3, 2]]);
  await choose('Insert', 'Insert Columns to the Right'); expect(await shape()).toEqual([[3, 3]]);
  await choose('Delete', 'Delete Rows'); expect(await shape()).toEqual([[2, 3]]);
  await choose('Table Properties…'); await expect(page.getByRole('dialog', { name: 'Table properties' })).toBeVisible();
  await page.keyboard.press('Escape');
  await choose('Delete', 'Delete Table'); expect(await shape()).toEqual([]);
  // Outside a table the menu stays short.
  await canvas.click({ button: 'right', position: { x: 120, y: 110 } });
  await expect(menu.getByRole('menuitem', { name: 'Merge Cells', exact: true })).toHaveCount(0);
});

test('the document menu offers plain paste and links', async ({ page }) => {
  await page.goto('/mock.html#/new');
  await expect((await onTab(page, 'home')).getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await page.getByRole('textbox', { name: 'Document text' }).fill('Link me');
  const canvas = page.locator('canvas.canvas-page').first(), menu = page.getByRole('menu', { name: 'Document menu' });
  await page.getByRole('textbox', { name: 'Document text' }).evaluate(el => { el.setSelectionRange(0, 4); el.dispatchEvent(new Event('select')); });
  await canvas.click({ button: 'right', position: { x: 100, y: 108 } });
  await expect(menu.getByRole('menuitem', { name: 'Paste without formatting', exact: true })).toBeVisible();
  await menu.getByRole('menuitem', { name: 'Insert link…', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Insert link' })).toBeVisible();
});
