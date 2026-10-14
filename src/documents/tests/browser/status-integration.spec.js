import { test, expect } from '@playwright/test';

const text = page => page.getByRole('textbox', { name: 'Document text' });
const mac = process.platform === 'darwin';

async function openEditor(page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
}

test('the status bar reports accessibility and opens the Accessibility pane', async ({ page }) => {
  await openEditor(page);
  await text(page).fill('A short note.');
  const item = page.locator('.ed-statusbar .ed-status-accessibility');
  await expect(item).toBeVisible();
  await expect(item).toContainText('Accessibility');
  await item.click();
  await expect(page.getByRole('complementary', { name: 'Accessibility pane' })).toBeVisible();
  await expect(item).toContainText(/Accessibility: (good to go|worth a look|\d+ errors? to fix)/);
});

test('Find Next steps through matches, and Go To keeps its own chord', async ({ page }) => {
  await openEditor(page);
  await text(page).fill('cat dog cat dog cat');
  await text(page).evaluate(el => { el.focus(); el.setSelectionRange(0, 3); el.dispatchEvent(new Event('select')); });
  const selection = () => text(page).evaluate(el => [el.selectionStart, el.selectionEnd]);
  // Cmd+G on a Mac, Shift+F4 everywhere.
  await text(page).press(mac ? 'Meta+g' : 'Shift+F4');
  await expect.poll(selection).toEqual([8, 11]);
  await text(page).press(mac ? 'Meta+Shift+g' : 'ControlOrMeta+Shift+F4');
  await expect.poll(selection).toEqual([0, 3]);
  await expect(page.getByRole('dialog', { name: 'Go To' })).toHaveCount(0);
  await text(page).press(mac ? 'Meta+Alt+g' : 'Control+g');
  await expect(page.getByRole('dialog', { name: 'Go To' })).toBeVisible();
});
