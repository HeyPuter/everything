import { test, expect } from '@playwright/test';
import { onTab } from './helpers/editor-tools.js';

// A diagram is rebuilt from the outline kept in its description, so its shapes' text is changed with Edit
// Diagram; typing into a shape through Edit Drawing Text would be lost at the next Edit Diagram.
test('a diagram\'s text frames point to Edit Diagram instead of opening the drawing text editor', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await page.getByRole('textbox', { name: 'Document text' }).fill('Body text.');
  await (await onTab(page, 'insert')).locator('.ribbon-card').getByRole('button', { name: 'Diagram', exact: true }).click();
  await page.locator('.menu [role=menuitem]').first().click();
  await page.getByRole('dialog', { name: 'Diagram' }).getByRole('button', { name: 'Insert', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const items = () => page.evaluate(() => { const view = window.__docs.current.view; return view.commands.drawingTextItems().map(item => ({ disabled: item.disabled, hint: item.hint })); });
  await expect.poll(async () => (await items()).length).toBeGreaterThan(0);
  for (const item of await items()) expect(item).toEqual({ disabled: true, hint: 'Use Edit Diagram to change a diagram’s text.' });
  // A text box still opens its text.
  await page.getByRole('textbox', { name: 'Document text' }).press('ControlOrMeta+End');
  await (await onTab(page, 'insert')).locator('.ribbon-card').getByRole('button', { name: 'Text Box', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Simple Text Box/ }).click();
  await expect(page.getByRole('dialog', { name: 'Edit drawing text' })).toBeVisible();
});
