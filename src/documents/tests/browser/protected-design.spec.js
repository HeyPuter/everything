import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { onTab, downloadDocx } from './helpers/editor-tools.js';

test.describe.configure({ timeout: 90000 });
const ribbon = page => page.locator('.ribbon-card');
async function protect(page, mode) {
  await page.locator('#ribbon-tab-review').click();
  await page.locator('#ribbon-panel-review [aria-label="Restrict Editing"]').evaluate(b => b.click());
  const pane = page.getByRole('complementary', { name: 'Restrict Editing pane' });
  await pane.getByRole('checkbox', { name: 'Allow only this type of editing in the document:' }).check();
  await pane.getByRole('combobox', { name: 'Type of editing allowed' }).selectOption(mode);
  await pane.getByRole('button', { name: 'Yes, Start Enforcing Protection' }).click();
  await page.getByRole('dialog', { name: 'Start Enforcing Protection' }).getByRole('button', { name: 'OK', exact: true }).click();
  await expect(pane.getByRole('button', { name: 'Stop Protection' })).toBeVisible();
  return pane;
}
async function themeOf(page, info) {
  const path = info.outputPath('saved.docx'), download = page.waitForEvent('download');
  await downloadDocx(page); await (await download).saveAs(path);
  return strFromU8(unzipSync(readFileSync(path))['word/theme/theme1.xml'] || new Uint8Array());
}

// The Design tab rewrites the package and reopens it, which went around Restrict Editing: under read-only protection,
// or with tracking locked, a theme, style set, watermark or page color still changed the document, and Undo could
// take back a design change made before protection began.
for (const mode of ['readOnly', 'trackedChanges']) test(`the design cannot be changed while the document is protected (${mode})`, async ({ page }, info) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  const input = page.getByRole('textbox', { name: 'Document text' });
  await input.fill('Quarterly report\nThe body text of the report.');
  // A design change before protection: Undo must not take it back afterwards.
  await onTab(page, 'design');
  await ribbon(page).getByRole('button', { name: 'Themes' }).click();
  await page.getByRole('menu', { name: 'Themes' }).getByRole('menuitemradio', { name: 'Harbor theme' }).click();
  await expect.poll(() => page.evaluate(() => window.__docs.current.view.commands.packageHistory().undo)).toBe(true);
  const pane = await protect(page, mode);
  const before = await themeOf(page, info);
  expect(before).toContain('Harbor');
  await onTab(page, 'design');
  for (const name of ['Themes', 'Theme Colors', 'Theme Fonts', 'Theme Effects', 'Watermark']) await expect(ribbon(page).getByRole('button', { name, exact: true }).first(), name).toBeDisabled();
  // Commands reached another way (search, menus) are refused too.
  expect(await page.evaluate(() => window.__docs.current.view.commands.applyTheme('Office'))).toBe(false);
  await page.evaluate(() => window.__docs.current.view.commands.setWatermark({ kind: 'text', text: 'DRAFT', font: null, size: 'auto', color: 'C0C0C0', semitransparent: true, layout: 'diagonal', language: 'en-US' }));
  expect(await page.evaluate(() => window.__docs.current.view.commands.packageHistory())).toEqual({ undo: false, redo: false });
  await input.focus(); await input.press('ControlOrMeta+z');
  await page.waitForTimeout(500);
  expect(await themeOf(page, info)).toBe(before);
  // Stopping protection gives the design back.
  await page.locator('#ribbon-tab-review').click();
  await pane.getByRole('button', { name: 'Stop Protection' }).click();
  await page.getByRole('dialog', { name: 'Stop Protection' }).getByRole('button', { name: 'Stop Protection' }).click();
  await onTab(page, 'design');
  await expect(ribbon(page).getByRole('button', { name: 'Themes', exact: true })).toBeEnabled();
  expect(errors).toEqual([]);
});
