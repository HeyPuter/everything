import { test, expect } from '@playwright/test';
import { onTab } from './helpers/editor-tools.js';

// A new caption label can be a word in any script (Рисунок, Abbildung, 図), as localized word processors use.
test('a caption label in another script can be made and numbered', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect((await onTab(page, 'home')).getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await page.locator('canvas.canvas-page').first().click({ position: { x: 150, y: 110 } });
  await page.keyboard.type('Схема сети');
  await onTab(page, 'references');
  await page.locator('#ribbon-panel-references').getByRole('button', { name: 'Insert Caption', exact: true }).click();
  const caption = page.getByRole('dialog', { name: 'Caption' });
  await caption.getByRole('button', { name: 'New Label…' }).click();
  const label = page.getByRole('dialog', { name: 'New Label' });
  await label.getByRole('textbox').fill('Рисунок');
  await label.getByRole('button', { name: 'OK', exact: true }).click();
  await expect(label).toBeHidden();
  await expect(caption.getByLabel('Label', { exact: true })).toHaveValue('Рисунок');
  await caption.getByLabel('Caption text').fill('Сеть');
  await caption.getByRole('button', { name: 'OK', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__docs.current.view.engine.session.body.text)).toBe('Схема сети\nРисунок 1: Сеть');
});
