import { test, expect } from '@playwright/test';

test('Enter that ends an input-method composition in Share’s people field does not send the invitation', async ({ page }) => {
  test.setTimeout(60000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html?user=ada#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await page.getByRole('textbox', { name: 'Document text' }).fill('Quarterly plan.');
  await page.getByRole('button', { name: 'Share', exact: true }).first().click();
  await page.getByRole('menuitem', { name: 'Invite People…' }).click();
  const dialog = page.getByRole('dialog', { name: /^Share/ });
  const people = dialog.getByRole('textbox', { name: 'People to invite' });
  await people.fill('bob');
  // A Japanese or Chinese input method confirms its conversion with Enter; that key belongs to the input method.
  for (const init of [{ isComposing: true }, { keyCode: 229 }]) {
    await people.evaluate((node, init) => node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init })), init);
  }
  await page.waitForTimeout(800);
  await expect(dialog.locator('.sh-status')).toHaveText('');
  await expect(people).toHaveValue('bob');
  // The Enter that follows, outside the composition, invites.
  await people.press('Enter');
  await expect(dialog.locator('.sh-status')).toContainText('bob can open the document');
});
