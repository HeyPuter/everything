import { test, expect } from '@playwright/test';
import { fileCommand, menuBarMenu } from './helpers/editor-tools.js';

const input = page => page.getByRole('textbox', { name: 'Document text' });

test('File > Save as template adds the document to the home screen templates', async ({ page }) => {
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await input(page).fill('Weekly status\nWins:\nRisks:');
  await (await fileCommand(page, 'Save as Template…')).click();
  const dialog = page.getByRole('dialog', { name: 'Save as template' });
  await dialog.getByRole('textbox', { name: 'Template name' }).fill('Status update');
  await dialog.getByRole('button', { name: 'Save template', exact: true }).click();
  await expect(page.getByText('Saved as template "Status update"')).toBeVisible();
  await expect(input(page)).toBeFocused();
  await expect(input(page)).toHaveValue('Weekly status\nWins:\nRisks:');

  // Saving under the same name asks before replacing it.
  await input(page).press('ControlOrMeta+End'); await page.keyboard.type(' none');
  await (await fileCommand(page, 'Save as Template…')).click();
  await dialog.getByRole('textbox', { name: 'Template name' }).fill('Status update');
  await dialog.getByRole('button', { name: 'Save template', exact: true }).click();
  await page.getByRole('dialog', { name: 'Replace template?' }).getByRole('button', { name: 'Replace', exact: true }).click();
  // The first save's notice may still be on screen: the newest one is this save's.
  await expect(page.getByText('Saved as template "Status update"').last()).toBeVisible();

  await page.getByRole('button', { name: 'All Documents', exact: true }).click();
  await page.getByRole('button', { name: 'Templates', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Status update', exact: true }).click();
  await expect(input(page)).toHaveValue('Weekly status\nWins:\nRisks: none');
  await expect(page.getByRole('textbox', { name: 'Document name' })).toHaveValue('Status update');
});

test('the local playground has no cloud template command', async ({ page }) => {
  await page.goto('/playground.html');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await menuBarMenu(page, 'File');
  await expect(page.getByRole('menuitem', { name: 'Save as Template…', exact: true })).toHaveCount(0);
});
