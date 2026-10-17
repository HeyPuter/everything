import { test, expect } from '@playwright/test';

const input = page => page.getByRole('textbox', { name: 'Document text' });

test('the view scrolls sideways to keep the caret in sight when the page is wider than it', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 800 });
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await input(page).fill('This is a fairly long first line of text that should reach the right margin of the page when typed out fully.');
  await page.getByRole('combobox', { name: 'Zoom' }).first().selectOption('2');
  await page.evaluate(() => { const e = window.__docs.current.view.engine; e.host.scrollLeft = 0; e.model.select(0); e.syncInput(); e.focus(); });
  // The hidden input follows the drawn caret, so its offset is the caret's place in the scrolled content.
  const view = () => page.evaluate(() => { const e = window.__docs.current.view.engine; return { caret: parseFloat(e.input.style.left), left: e.host.scrollLeft, width: e.host.clientWidth }; });
  const inSight = ({ caret, left, width }) => caret >= left && caret <= left + width;
  await input(page).press('End');
  const end = await view();
  expect(end.caret).toBeGreaterThan(end.width);
  expect(inSight(end)).toBe(true);
  await input(page).press('Home');
  const home = await view();
  expect(inSight(home)).toBe(true);
  expect(home.left).toBeLessThan(end.left);
});
