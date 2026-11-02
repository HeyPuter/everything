import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { onTab } from './helpers/editor-tools.js';

// "Move with Text" is ticked only for an object placed from its paragraph or line, as in the Layout
// dialog: one measured from the margin stays where it is on the page as the text moves.
const PNG = readFileSync('icon-128.png');
const OBJECT = '￼';

test('the Move with Text tick follows the vertical reference of a picture in front of text', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/playground.html');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Document text' });
  await input.fill('Pictures sit beside this paragraph of text. '.repeat(6));
  await input.press('ControlOrMeta+Home');
  await onTab(page, 'insert');
  await page.getByLabel('Insert picture file').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: PNG });
  await expect.poll(async () => (await input.inputValue()).split(OBJECT).length - 1).toBe(1);
  const ribbon = page.locator('#ribbon-panel-picture');
  const wrapMenu = async () => { await onTab(page, 'picture'); await ribbon.getByRole('button', { name: 'Wrap Text', exact: true }).click(); };
  const ticks = async () => [await page.getByRole('menuitemradio', { name: 'Move with Text' }).getAttribute('aria-checked'), await page.getByRole('menuitemradio', { name: 'Fix Position on Page' }).getAttribute('aria-checked')];
  const layoutOptionsTicks = async () => { await page.getByRole('button', { name: 'Layout Options' }).click(); const result = await ticks(); await page.keyboard.press('Escape'); return result; };
  // In front of text, measured from its paragraph: it moves with the text.
  await wrapMenu();
  await page.getByRole('menuitemradio', { name: 'In Front of Text', exact: true }).click();
  await wrapMenu();
  expect(await ticks()).toEqual(['true', 'false']);
  await page.keyboard.press('Escape');
  // Measured from the margin in the Layout dialog, it is fixed on the page there too.
  await ribbon.getByRole('button', { name: 'Size and Position…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Layout' });
  await dialog.getByRole('tab', { name: 'Position' }).click();
  await dialog.getByRole('combobox', { name: 'Vertical position below' }).selectOption('margin');
  await expect(dialog.getByRole('checkbox', { name: 'Move object with text' })).not.toBeChecked();
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect(dialog).toBeHidden();
  await wrapMenu();
  expect(await ticks()).toEqual(['false', 'true']);
  await page.keyboard.press('Escape');
  expect(await layoutOptionsTicks()).toEqual(['false', 'true']);
  // Move with Text measures it from the paragraph again.
  await wrapMenu();
  await page.getByRole('menuitemradio', { name: 'Move with Text' }).click();
  await wrapMenu();
  expect(await ticks()).toEqual(['true', 'false']);
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});
