import { test, expect } from '@playwright/test';

const engine = 'window.__docs.current.view.engine';
const review = page => page.locator('#ribbon-panel-review');

// Lock Tracking turned Track Changes on before asking for the password: cancelling the dialog left the document
// tracking every change (and saved with Track Changes on), though nothing was locked.
test('cancelling Lock Tracking leaves Track Changes as it was', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  const input = page.getByRole('textbox', { name: 'Document text' });
  await input.fill('Alpha beta gamma.');
  await page.getByRole('tab', { name: 'Review' }).click();
  const track = review(page).getByRole('button', { name: 'Track Changes', exact: true });
  await expect(track).toHaveAttribute('aria-pressed', 'false');
  await review(page).locator('[aria-label="Track Changes options"]').evaluate(b => b.click());
  await page.getByRole('menuitem', { name: 'Lock Tracking…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Lock Tracking' });
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(track).toHaveAttribute('aria-pressed', 'false');
  expect(await page.evaluate(engine => !!eval(engine).session.body.trackChanges, engine)).toBe(false);
  // Typing is not tracked.
  await input.focus();
  await input.press('End');
  await page.keyboard.type(' More');
  expect(await page.evaluate(engine => eval(engine).session.body.revisions.length, engine)).toBe(0);
  // Escape cancels as well, and with Track Changes already on it stays on.
  await track.click();
  await expect(track).toHaveAttribute('aria-pressed', 'true');
  await review(page).locator('[aria-label="Track Changes options"]').evaluate(b => b.click());
  await page.getByRole('menuitem', { name: 'Lock Tracking…' }).click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(track).toHaveAttribute('aria-pressed', 'true');
  expect(errors).toEqual([]);
});
