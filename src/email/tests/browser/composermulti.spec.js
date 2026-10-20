import { test, expect } from '@playwright/test';

// A minimized composer stays in the document; one opened beside it has fields,
// labels and error descriptions of its own.

const start = async (page) => {
  await page.goto('/tests/browser/composer.html');
  await page.getByRole('button', { name: 'Compose', exact: true }).click();
};

test('a second composer opened beside a minimized one keeps its own labels', async ({ page }) => {
  await start(page);
  await page.getByRole('textbox', { name: 'Subject', exact: true }).fill('First');
  await page.getByRole('button', { name: 'Minimize composer' }).click();
  await page.getByRole('button', { name: 'Compose', exact: true }).click();
  // Second composer is the visible dialog.
  const dialog = page.getByRole('dialog');
  await expect(dialog).toHaveCount(1);
  await expect(dialog.getByRole('combobox', { name: 'To', exact: true })).toHaveCount(1);
  await expect(dialog.getByRole('textbox', { name: 'Subject', exact: true })).toHaveCount(1);
  // Clicking the label "Subject" in the second composer focuses its own input.
  await dialog.locator('label', { hasText: 'Subject' }).click();
  const focusedInVisible = await page.evaluate(() => {
    const visible = [...document.querySelectorAll('.modal-root')].find((root) => !root.hidden);
    return visible.contains(document.activeElement) && document.activeElement.id.startsWith('compose-subject');
  });
  expect(focusedInVisible).toBe(true);
});

test('Send refused in the second composer describes its own error', async ({ page }) => {
  await start(page);
  await page.getByRole('textbox', { name: 'Subject', exact: true }).fill('First');
  await page.getByRole('button', { name: 'Minimize composer' }).click();
  await page.getByRole('button', { name: 'Compose', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Send', exact: true }).click();
  const described = await page.evaluate(() => {
    const visible = [...document.querySelectorAll('.modal-root')].find((root) => !root.hidden);
    const to = visible.querySelector('input[role=combobox]');
    const id = to.getAttribute('aria-describedby');
    const target = document.getElementById(id);
    return { id, inVisible: visible.contains(target), text: target?.textContent };
  });
  expect(described.inVisible).toBe(true);
});
