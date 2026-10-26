import { test, expect } from '@playwright/test';
import { onTab } from './helpers/editor-tools.js';

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

// On a phone the comment cards run along the bottom of the screen, where the Assistant button floats.
test('the Assistant button leaves a comment card and its Post button uncovered on a phone', async ({ page }) => {
  await page.goto('/mock.html#/new');
  const input = page.getByRole('textbox', { name: 'Document text' });
  await expect(input).toBeEditable({ timeout: 20000 });
  await input.fill('Some text to comment on.');
  await input.evaluate(el => { el.focus(); el.setSelectionRange(0, 4); el.dispatchEvent(new Event('select', { bubbles: true })); });
  await onTab(page, 'review');
  await page.locator('#ribbon-panel-review [aria-label="New Comment"]').first().evaluate(b => b.click());
  const card = page.locator('.ed-comment-draft');
  await card.locator('textarea').fill('Looks good');
  const fab = page.getByRole('button', { name: 'Assistant', exact: true });
  await expect(fab).toBeVisible();
  await expect.poll(async () => {
    const [a, b] = [await fab.boundingBox(), await card.boundingBox()];
    return a.x >= b.x + b.width || b.x >= a.x + a.width || a.y >= b.y + b.height || b.y >= a.y + a.height;
  }).toBe(true);
  await card.getByRole('button', { name: 'Post' }).click();
  await expect(page.locator('.ed-comment-card').first()).toContainText('Looks good');
});
