import { test, expect } from '@playwright/test';
import { readFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { onTab, downloadDocx } from './helpers/editor-tools.js';
import { reopenDocx } from './helpers/reopen-docx.js';

const SHOTS = process.env.DESIGN_SHOTS;
// Each change reopens the package; saving and reopening it again in one flow takes longer than a plain edit.
test.describe.configure({ timeout: 90000 });
const ribbon = page => page.locator('.ribbon-card');
async function open(page) {
  await page.goto('/playground.html');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Document text' });
  await input.fill('Quarterly report\nThe body text of the report.');
  await input.press('ControlOrMeta+Home');
  await onTab(page, 'home');
  await ribbon(page).getByRole('option', { name: 'Heading 1' }).click();
  await onTab(page, 'design');
  return input;
}
async function saved(page, info, name) {
  const path = info.outputPath(name);
  const download = page.waitForEvent('download'); await downloadDocx(page); await (await download).saveAs(path);
  mkdirSync('test-results/design-themes', { recursive: true }); copyFileSync(path, `test-results/design-themes/${name}`);
  return { path, parts: unzipSync(readFileSync(path)) };
}
/** The font the Home tab shows for the caret's text. */
async function expectFont(page, pattern) {
  await onTab(page, 'home');
  await expect(page.getByRole('button', { name: 'Latin font family' })).toHaveText(pattern);
  await onTab(page, 'design');
}

test('themes, colors and fonts rewrite the theme part, restyle a new document and undo', async ({ page }, info) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const input = await open(page);
  await ribbon(page).getByRole('button', { name: 'Themes' }).click();
  const menu = page.getByRole('menu', { name: 'Themes' });
  await expect(menu.getByRole('menuitemradio', { name: 'Harbor theme' })).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/themes-menu.png` });
  await menu.getByRole('menuitemradio', { name: 'Harbor theme' }).click();
  await expectFont(page, /Montserrat/);
  await input.press('ControlOrMeta+End');
  await expectFont(page, /Open Sans/);
  await ribbon(page).getByRole('button', { name: 'Themes' }).click();
  await expect(page.getByRole('menuitemradio', { name: 'Harbor theme' })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  // Fonts alone.
  await ribbon(page).getByRole('button', { name: 'Theme Fonts' }).click();
  await page.getByRole('menu', { name: 'Theme Fonts' }).getByRole('menuitemradio', { name: /^Bookish/ }).click();
  await expectFont(page, /Times New Roman/);
  // Colors alone.
  await ribbon(page).getByRole('button', { name: 'Theme Colors' }).click();
  await page.getByRole('menu', { name: 'Theme Colors' }).getByRole('menuitemradio', { name: 'Ember' }).click();
  const { parts } = await saved(page, info, 'theme-ember.docx');
  const theme = strFromU8(parts['word/theme/theme1.xml']);
  expect(theme).toContain('<a:clrScheme name="Ember">');
  expect(theme).toContain('<a:latin typeface="Cambria"/>');
  expect(strFromU8(parts['word/styles.xml'])).toContain('w:asciiTheme="minorHAnsi"');
  // Undo steps back through each design change, then Redo applies it again.
  await input.press('ControlOrMeta+z');
  await ribbon(page).getByRole('button', { name: 'Theme Colors' }).click();
  await expect(page.getByRole('menuitemradio', { name: 'Harbor' })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await input.press('ControlOrMeta+z');
  await expectFont(page, /Open Sans/);
  await input.press('ControlOrMeta+Shift+z');
  await expectFont(page, /Times New Roman/);
  await reopenDocx(page, input, info.outputPath('theme-ember.docx'), 'Quarterly report\nThe body text of the report.');
  await input.press('ControlOrMeta+End');
  await expectFont(page, /Times New Roman/);
  expect(errors).toEqual([]);
});

test('style sets restyle headings with undo, and custom colors are saved', async ({ page }, info) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const input = await open(page);
  const set = ribbon(page).getByRole('option', { name: 'Banner style set' });
  await set.click();
  await expect(set).toHaveAttribute('aria-selected', 'true');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/style-set.png` });
  let { parts } = await saved(page, info, 'style-set.docx');
  expect(strFromU8(parts['word/styles.xml'])).toMatch(/w:styleId="Title"[\s\S]*?<w:caps\/>/);
  // Undo returns to the document as it was: no theme and no style set yet.
  await input.press('ControlOrMeta+z');
  await expect(set).toHaveAttribute('aria-selected', 'false');
  await ribbon(page).getByRole('button', { name: 'More Style Sets' }).click();
  await page.getByRole('menuitem', { name: 'Reset to the Default Style Set' }).click();
  await ribbon(page).getByRole('button', { name: 'Theme Colors' }).click();
  await page.getByRole('menuitem', { name: 'Customize Colors…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Customize Colors' });
  await dialog.getByLabel('Accent 1').fill('#aa2244');
  await dialog.getByLabel('Name').fill('Wine');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/customize-colors.png` });
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
  ({ parts } = await saved(page, info, 'custom-colors.docx'));
  expect(strFromU8(parts['word/theme/theme1.xml'])).toContain('<a:accent1><a:srgbClr val="AA2244"/></a:accent1>');
  await ribbon(page).getByRole('button', { name: 'Theme Colors' }).click();
  await expect(page.getByRole('menuitemradio', { name: 'Wine' })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});

test('watermarks are written into headers, shown behind text and removed', async ({ page }, info) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const input = await open(page);
  await ribbon(page).getByRole('button', { name: 'Watermark' }).click();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/watermark-menu.png` });
  await page.getByRole('menuitemradio', { name: 'DRAFT, diagonal' }).click();
  await expect(input).toBeFocused();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/watermark-page.png` });
  let { parts } = await saved(page, info, 'watermark.docx');
  const header = Object.keys(parts).find(name => /^word\/header\d+\.xml$/.test(name));
  expect(strFromU8(parts[header])).toContain('name="Document Watermark"');
  // The custom dialog edits the text and layout.
  await ribbon(page).getByRole('button', { name: 'Watermark' }).click();
  await page.getByRole('menuitem', { name: 'Custom Watermark…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Watermark' });
  await dialog.getByLabel('Text').fill('FOR REVIEW');
  await dialog.getByRole('radio', { name: 'Horizontal' }).click();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/watermark-dialog.png` });
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect(dialog).toBeHidden();
  ({ parts } = await saved(page, info, 'watermark-custom.docx'));
  expect(strFromU8(parts[header])).toContain('FOR REVIEW');
  await reopenDocx(page, input, info.outputPath('watermark-custom.docx'), 'Quarterly report\nThe body text of the report.');
  await onTab(page, 'design');
  await ribbon(page).getByRole('button', { name: 'Watermark' }).click();
  await page.getByRole('menuitem', { name: 'Remove Watermark' }).click();
  ({ parts } = await saved(page, info, 'watermark-removed.docx'));
  expect(strFromU8(parts[header])).not.toContain('Document Watermark');
  expect(errors).toEqual([]);
});

test('fill effects store a picture page background and page borders offer the options dialog', async ({ page }, info) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await open(page);
  await ribbon(page).getByRole('button', { name: 'Page Color' }).click();
  await page.getByRole('menuitem', { name: 'Fill Effects…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Fill Effects' });
  await dialog.getByRole('radio', { name: 'From center' }).click();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/fill-effects.png` });
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect(dialog).toBeHidden();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/fill-page.png` });
  const { parts } = await saved(page, info, 'fill-effect.docx');
  expect(strFromU8(parts['word/document.xml'])).toMatch(/<w:background [^>]*><v:background [^>]*><v:fill [^>]*type="tile"/);
  expect(strFromU8(parts['word/settings.xml'])).toContain('displayBackgroundShape');
  await ribbon(page).getByRole('button', { name: 'Page Color' }).click();
  await page.getByRole('menuitem', { name: 'Remove Fill Effect' }).click();
  await ribbon(page).getByRole('button', { name: 'Page Borders' }).click();
  await expect(page.getByRole('menuitem', { name: 'Borders and Shading Options…' })).toBeVisible();
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});
