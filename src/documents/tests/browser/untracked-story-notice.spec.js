import { test, expect } from '@playwright/test';

const text = page => page.getByRole('textbox', { name: 'Document text' });

// Track Changes records changes in the main text only: typing in a header with it on says so, once, instead of
// leaving the reviewer to think the change was tracked.
test('typing in a header with Track Changes on says the change is not tracked', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await text(page).fill('Body text.');
  await text(page).press('ControlOrMeta+Shift+e');
  await page.getByRole('tab', { name: 'Insert' }).click();
  await page.locator('#ribbon-panel-insert').getByRole('button', { name: 'Header', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Edit Header' }).click();
  const header = page.getByRole('textbox', { name: 'Header text' });
  await expect(header).toBeFocused();
  const notice = page.getByRole('status').filter({ hasText: 'Changes to headers, footers and notes aren’t tracked' });
  await page.keyboard.type('Head');
  await expect(header).toHaveValue('Head');
  await expect(notice).toBeVisible();
  await expect(page.locator('.toast').filter({ hasText: 'aren’t tracked' })).toHaveCount(1);
  await page.keyboard.type(' note');
  await expect(header).toHaveValue('Head note');
  await expect(page.locator('.toast').filter({ hasText: 'aren’t tracked' })).toHaveCount(1);
});

test('typing in a header with Track Changes off says nothing', async ({ page }) => {
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await text(page).fill('Body text.');
  await page.getByRole('tab', { name: 'Insert' }).click();
  await page.locator('#ribbon-panel-insert').getByRole('button', { name: 'Header', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Edit Header' }).click();
  const header = page.getByRole('textbox', { name: 'Header text' });
  await expect(header).toBeFocused();
  await page.keyboard.type('Head note');
  await expect(header).toHaveValue('Head note');
  await page.waitForTimeout(300);
  await expect(page.locator('.toast').filter({ hasText: 'aren’t tracked' })).toHaveCount(0);
});
