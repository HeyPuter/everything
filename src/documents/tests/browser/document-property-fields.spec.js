import { test, expect } from '@playwright/test';
import { onTab } from './helpers/editor-tools.js';

// A title set in File > Info is the document's title from then on: Quick Parts > Document Property
// inserts it, as TITLE fields show it, without saving and reopening the document first.
test('a title set in the File view is the one Document Property inserts', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  const input = page.getByRole('textbox', { name: 'Document text' });
  await input.fill('Report: ');
  await page.locator('.ribbon-file').click();
  const view = page.getByRole('dialog', { name: 'File' });
  await view.getByRole('textbox', { name: 'Title', exact: true }).fill('Harbour Report');
  await view.getByRole('button', { name: 'Save Properties' }).click();
  await expect(view.getByRole('status')).toContainText('Properties updated');
  await page.keyboard.press('Escape');
  await expect(view).toBeHidden();
  await input.press('ControlOrMeta+End');
  await onTab(page, 'insert');
  await page.locator('#ribbon-panel-insert').getByRole('button', { name: 'Quick Parts', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Document Property' }).click();
  await expect(page.getByRole('menuitem', { name: /^Title/ })).toContainText('Harbour Report');
  await page.getByRole('menuitem', { name: /^Title/ }).click();
  await expect.poll(() => input.inputValue()).toBe('Report: Harbour Report');
});
