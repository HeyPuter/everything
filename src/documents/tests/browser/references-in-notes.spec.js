import { test, expect } from '@playwright/test';
import { onTab } from './helpers/editor-tools.js';

// Citations, captions, bibliographies and tables of contents are inserted into the text of the document. While a
// footnote is being edited their commands are unavailable (as Cross-reference already was), rather than leaving
// the note and inserting at the caret's last place in the text.
test('body-only References commands are unavailable while a footnote is edited', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect((await onTab(page, 'home')).getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await page.locator('canvas.canvas-page').first().click({ position: { x: 150, y: 110 } });
  await page.keyboard.type('A claim.');
  await onTab(page, 'references');
  const ribbon = page.locator('#ribbon-panel-references');
  const button = name => ribbon.getByRole('button', { name, exact: true, includeHidden: true });
  const commands = ['Insert Citation', 'Bibliography', 'Insert Caption', 'Cross-reference'];
  for (const name of commands) await expect(button(name), name).toBeEnabled();
  await button('Insert Footnote').click();
  await expect(page.getByRole('textbox', { name: 'Footnote text' })).toBeFocused();
  await page.keyboard.type('Source');
  for (const name of commands) await expect(button(name), name).toBeDisabled();
  await ribbon.getByRole('button', { name: 'Table of Contents', exact: true }).first().click();
  await expect(page.getByRole('menuitem', { name: /^Classic/ })).toBeDisabled();
  await page.keyboard.press('Escape');
  const text = await page.evaluate(() => window.__docs.current.view.engine.session.body.text);
  expect(text).toBe('A claim.￼');
});
