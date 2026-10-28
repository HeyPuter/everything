import { test, expect } from '@playwright/test';

const input = page => page.locator('.canvas-input');
const engine = 'window.__docs.current.view.engine';

async function trackedDocument(page) {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await page.getByRole('textbox', { name: 'Document text' }).fill('Alpha beta gamma.\nSecond paragraph.');
  await page.evaluate(engine => {
    const e = eval(engine), m = e.model;
    e.execute(() => { m.trackChanges = true; m.select(6); m.replace('new '); m.trackChanges = false; });
  }, engine);
  // Edit the header, and type in it.
  await page.getByRole('tab', { name: 'Insert' }).click();
  await page.locator('#ribbon-panel-insert').getByRole('button', { name: 'Header', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Edit Header' }).click();
  await expect(input(page)).toHaveAttribute('aria-label', 'Header text');
  await page.keyboard.type('Head');
  await page.getByRole('tab', { name: 'Review' }).click();
  return errors;
}

test('choosing a change in the Reviewing Pane while editing the header goes to the change in the body', async ({ page }) => {
  const errors = await trackedDocument(page);
  await page.getByRole('button', { name: 'Reviewing Pane', exact: true }).filter({ visible: true }).first().click();
  const items = page.getByRole('complementary', { name: 'Reviewing Pane' }).locator('.review-pane-item');
  await expect(items).toHaveCount(1);
  await items.first().click();
  await expect(input(page)).toHaveAttribute('aria-label', 'Document text');
  await expect.poll(() => input(page).evaluate(el => el.value.slice(el.selectionStart, el.selectionEnd))).toBe('new ');
  expect(errors).toEqual([]);
});
