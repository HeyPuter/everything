import { test, expect } from '@playwright/test';
import { onTab } from './helpers/editor-tools.js';

// The chart types and diagram layouts are listboxes: one tab stop, chosen with the arrow keys, Home and End.
test('chart types and diagram layouts are chosen with the keyboard', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect((await onTab(page, 'home')).getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await page.getByRole('textbox', { name: 'Document text' }).focus();
  const insert = page.locator('#ribbon-panel-insert');

  await onTab(page, 'insert');
  await insert.getByRole('button', { name: 'Chart', exact: true }).click();
  const chart = page.getByRole('dialog', { name: 'Insert Chart' });
  const types = chart.getByRole('listbox', { name: 'Chart type' });
  await expect(types.getByRole('option', { name: 'Clustered column', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(types.getByRole('option', { name: 'Stacked column', exact: true })).toBeFocused();
  await expect(types.getByRole('option', { name: 'Stacked column', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('End');
  await expect(types.getByRole('option', { name: 'Scatter with lines', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Home');
  await expect(types.getByRole('option', { name: 'Clustered column', exact: true })).toHaveAttribute('aria-selected', 'true');
  // Tab leaves the list for the next field instead of walking through every type.
  await page.keyboard.press('Tab');
  await expect(chart.getByRole('textbox', { name: 'Chart title' })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(types.getByRole('option', { name: 'Clustered column', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');

  await onTab(page, 'insert');
  await insert.getByRole('button', { name: 'Diagram', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Basic Process/ }).click();
  const diagram = page.getByRole('dialog', { name: 'Diagram' });
  const layouts = diagram.getByRole('listbox', { name: 'Layouts' });
  await layouts.getByRole('option', { name: /^Basic Process/ }).focus();
  await page.keyboard.press('End');
  await expect(layouts.getByRole('option', { name: /^Basic Pyramid/ })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Tab');
  const text = diagram.getByRole('textbox', { name: 'Diagram text' });
  await expect(text).toBeFocused();
  // Tab at the start of a line indents it; Shift+Tab there outdents it.
  await text.fill('Plan\nBuild');
  const caret = at => text.evaluate((el, at) => el.setSelectionRange(at, at), at);
  await caret(5);
  await text.press('Tab');
  await expect(text).toHaveValue('Plan\n  Build');
  await expect(text).toBeFocused();
  await text.press('Shift+Tab');
  await expect(text).toHaveValue('Plan\nBuild');
  // After the line's text, Tab moves on, so the keyboard can reach the rest of the dialog.
  await caret(10);
  await text.press('Tab');
  await expect(text).not.toBeFocused();
  await expect(text).toHaveValue('Plan\nBuild');
  await text.focus(); await caret(0);
  await text.press('Shift+Tab');
  await expect(text).not.toBeFocused();
  expect(errors).toEqual([]);
});
