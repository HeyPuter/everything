import { test, expect } from '@playwright/test';

// Starting or stopping protection replaced the pane's button that opened the password dialog, and the dialog gave the
// keyboard back to that button: it was left on nothing, so the next key went nowhere.
test('the keyboard goes to the Restrict Editing pane\'s new button after starting or stopping protection', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await page.getByRole('textbox', { name: 'Document text' }).fill('Protected text.');
  await page.getByRole('tab', { name: 'Review' }).click();
  await page.locator('#ribbon-panel-review').getByRole('button', { name: 'Restrict Editing', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Restrict Editing pane' });
  await pane.getByRole('checkbox', { name: /Allow only this type of editing/ }).check();
  await pane.getByRole('button', { name: 'Yes, Start Enforcing Protection' }).click();
  const start = page.getByRole('dialog', { name: 'Start Enforcing Protection' });
  await start.getByLabel('Password', { exact: true }).fill('pass');
  await start.getByLabel('Reenter password').fill('pass');
  await start.getByLabel('Reenter password').press('Enter');
  await expect(start).toBeHidden();
  const stop = pane.getByRole('button', { name: 'Stop Protection' });
  await expect(stop).toBeFocused();
  // Stays there once the dialog's closing animation has ended.
  await page.waitForTimeout(400);
  await expect(stop).toBeFocused();
  await page.keyboard.press('Enter');
  const unprotect = page.getByRole('dialog', { name: 'Stop Protection' });
  await unprotect.getByLabel('Password', { exact: true }).fill('pass');
  await unprotect.getByLabel('Password', { exact: true }).press('Enter');
  await expect(unprotect).toBeHidden();
  await page.waitForTimeout(400);
  await expect(pane.getByRole('button', { name: 'Yes, Start Enforcing Protection' })).toBeFocused();
  expect(errors).toEqual([]);
});
