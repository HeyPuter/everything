import { test, expect } from '@playwright/test';
import { onTab } from './helpers/editor-tools.js';

// Opening the Reviewing Pane left the keyboard where it was. Tab from the ribbon reaches the rulers and then the
// document, where Tab types a tab, so the pane's entries could not be reached from the keyboard at all. It now takes
// the keyboard as the other panes do: its first entry, or its Close button when it lists nothing.
test('the Reviewing Pane takes the keyboard when it opens, and its entries go to their changes', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  const text = page.getByRole('textbox', { name: 'Document text' });
  await text.fill('A sentence to review. Another one.');
  await onTab(page, 'review');
  const reviewing = page.locator('#ribbon-panel-review').getByRole('button', { name: 'Reviewing Pane', exact: true });
  const pane = page.getByRole('complementary', { name: 'Reviewing Pane' });
  // Nothing to list: the Close button has the keyboard, and Escape returns to the document.
  await reviewing.focus();
  await page.keyboard.press('Enter');
  await expect(pane).toBeVisible();
  await expect(pane.getByRole('button', { name: 'Close Reviewing Pane' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(pane).toBeHidden();
  await expect(text).toBeFocused();
  // With a change, its entry has the keyboard; Enter selects the change in the document.
  await text.press('ControlOrMeta+Shift+e');
  await text.evaluate(el => { el.setSelectionRange(2, 11); el.dispatchEvent(new Event('select')); });
  await text.press('Backspace');
  await reviewing.focus();
  await page.keyboard.press('Enter');
  const entry = pane.getByRole('button', { name: /Deleted/ });
  await expect(entry).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(text).toBeFocused();
  expect(await text.evaluate(el => [el.selectionStart, el.selectionEnd])).toEqual([2, 11]);
  // The title bar's Comments button opens it the same way.
  await reviewing.focus(); await page.keyboard.press('Enter');
  await expect(pane).toBeHidden();
  await page.getByRole('button', { name: 'Comments', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(entry).toBeFocused();
  expect(errors).toEqual([]);
});
