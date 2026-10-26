import { test, expect } from '@playwright/test';
import { menuBarMenu, onTab } from './helpers/editor-tools.js';

const text = page => page.getByRole('textbox', { name: 'Document text' });
const state = page => page.evaluate(() => { const v = window.__docs.current.view, e = v.engine;
  return { same: e === window.__opened, viewOnly: !!e.viewOnly, text: e.model.text }; });

test('Viewing mode keeps themes, style sets and watermarks from changing the document', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await text(page).fill('Draft');
  const mode = page.getByRole('button', { name: /^Editing mode/ });
  await mode.click();
  await page.getByRole('menuitemradio', { name: /^Viewing/ }).click();
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeDisabled();
  await page.evaluate(() => { window.__opened = window.__docs.current.view.engine; });

  // The menu bar's design commands are unavailable, as the ribbon's are.
  const format = await menuBarMenu(page, 'Format');
  await expect(format.getByRole('menuitem', { name: 'Theme', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  const insert = await menuBarMenu(page, 'Insert');
  await expect(insert.getByRole('menuitem', { name: 'Watermark…', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await onTab(page, 'design');
  for (const name of ['Themes', 'Theme Colors', 'Watermark']) await expect(page.locator('.ribbon-card').getByRole('button', { name, exact: true })).toBeDisabled();
  await expect(page.getByRole('option', { name: 'Lines style set' }).or(page.getByRole('option', { name: /style set$/ }).nth(1))).toBeDisabled();

  // A change that still reaches the editor (a dialog opened before, a command search) leaves the package alone,
  // and the editor stays in Viewing mode.
  const applied = await page.evaluate(async () => {
    const commands = window.__docs.current.view.commands;
    return [await commands.changePackage(async blob => blob), await commands.applyTheme?.('Slate')];
  });
  expect(applied[0]).toBe(false);
  expect(applied[1]).toBeFalsy();
  expect(await state(page)).toEqual({ same: true, viewOnly: true, text: 'Draft' });
  await expect(mode).toHaveAccessibleName('Editing mode: Viewing');

  // Back in Editing mode, the theme applies.
  await mode.click();
  await page.getByRole('menuitemradio', { name: /^Editing/ }).click();
  const themes = page.locator('.ribbon-card').getByRole('button', { name: 'Themes', exact: true });
  await expect(themes).toBeEnabled();
  await themes.click();
  await page.getByRole('menuitemradio', { name: /theme$/ }).nth(3).click();
  await expect.poll(async () => (await state(page)).same).toBe(false);
  expect((await state(page)).viewOnly).toBe(false);
  expect(errors).toEqual([]);
});
