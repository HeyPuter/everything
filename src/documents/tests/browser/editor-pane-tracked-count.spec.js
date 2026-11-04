import { test, expect } from '@playwright/test';
import { menuBarMenu, onTab } from './helpers/editor-tools.js';

const input = page => page.getByRole('textbox', { name: 'Document text' });
async function markup(page, label) {
  await (await menuBarMenu(page, 'View')).getByRole('menuitem', { name: 'Markup', exact: true }).click();
  await page.getByRole('menuitemradio', { name: label, exact: true }).click();
  await input(page).focus();
}

// The Editor pane counted and measured the document's text with its tracked deletions in every view, so with
// deletions hidden it gave more words than the status bar and Word Count, and judged sentences that were deleted.
test('the Editor pane counts the words the view shows, as the status bar does', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await input(page).fill('Alpha beta gamma delta.');
  await input(page).press('ControlOrMeta+Shift+e');
  await input(page).evaluate(el => { el.setSelectionRange(6, 17); el.dispatchEvent(new Event('select')); });
  await input(page).press('Backspace');
  await expect.poll(() => page.evaluate(() => window.__docs.current.view.engine.model.paragraphs[0].runs.map(r => [r.text, r.revision?.type || '']))).toEqual([['Alpha ', ''], ['beta gamma ', 'del'], ['delta.', '']]);
  await markup(page, 'No Markup');
  const status = page.locator('.ed-statusbar .ed-word-count');
  await expect(status).toHaveText('2 words');
  await onTab(page, 'review');
  await page.locator('#ribbon-panel-review').getByRole('button', { name: 'Editor', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Editor pane' });
  const words = pane.locator('.rv-stats dt', { hasText: /^Words$/ }).locator('xpath=following-sibling::dd[1]');
  await expect(words).toHaveText('2');
  await expect(pane.locator('.rv-score')).toContainText('· 2 words');
  // A selection across the deletion counts the words shown in it.
  await input(page).evaluate(el => { el.focus(); el.setSelectionRange(0, 23); el.dispatchEvent(new Event('select')); });
  await expect(status).toHaveText('2 of 2 words');
  await expect(words).toHaveText('2');
  // With every change shown the deleted words count again, in both places.
  await markup(page, 'All Markup');
  await input(page).evaluate(el => { el.setSelectionRange(23, 23); el.dispatchEvent(new Event('select')); });
  await expect(status).toHaveText('4 words');
  await expect(words).toHaveText('4');
  expect(errors).toEqual([]);
});
