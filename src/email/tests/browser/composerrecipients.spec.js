import { test, expect } from '@playwright/test';

// A list of addresses pasted into To or Cc becomes chips, and replaces what
// was selected in the field the way any paste does.

const start = async (page) => {
  await page.goto('/tests/browser/composer.html');
  await page.getByRole('button', { name: 'Compose', exact: true }).click();
};

test('pasting a list over a selected half-typed address replaces it', async ({ page }) => {
  await start(page);
  const to = page.getByRole('combobox', { name: 'To', exact: true });
  await to.fill('wrong@exa');
  await to.press('ControlOrMeta+a');
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData('text/plain', 'ana@example.com, bo@example.com');
    document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  const chips = await page.locator('.recipient-chip .chip-name').allTextContents();
  expect(chips).toEqual(['ana@example.com', 'bo@example.com']);
});

test('pasting a list with nothing selected adds to what was typed', async ({ page }) => {
  await start(page);
  const to = page.getByRole('combobox', { name: 'To', exact: true });
  await to.fill('cy@example.com');
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData('text/plain', ', ana@example.com; bo@example.com');
    document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  const chips = await page.locator('.recipient-chip .chip-name').allTextContents();
  expect(chips).toEqual(['cy@example.com', 'ana@example.com', 'bo@example.com']);
});
