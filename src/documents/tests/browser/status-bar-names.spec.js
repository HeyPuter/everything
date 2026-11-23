import { test, expect } from '@playwright/test';

// The status bar's spelling button had no name until spelling first reported back: a screen reader that reached it
// while a document opened heard only "button".
test('the spelling button in the status bar is named from the moment it appears', async ({ page }) => {
  await page.addInitScript(() => {
    window.__proofingNames = [];
    new MutationObserver(() => {
      const button = document.querySelector('.ed-proofing');
      if (button && !window.__proofingNames.length) window.__proofingNames.push(button.getAttribute('aria-label'));
    }).observe(document, { childList: true, subtree: true });
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  const [first] = await page.evaluate(() => window.__proofingNames);
  expect(first).toMatch(/^(Checking spelling|Spelling: no errors|Spelling check is off)$/);
  await expect(page.locator('.ed-proofing')).toHaveAttribute('aria-label', /spelling/i);
});
