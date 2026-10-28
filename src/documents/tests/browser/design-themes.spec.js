import { test, expect } from '@playwright/test';
import { readFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
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

test('the custom watermark dialog keeps the current picture when only its washout changes', async ({ page }, info) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await open(page);
  // An 8×6 red PNG.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAGCAIAAABxZ0isAAAAEUlEQVR4nGM4ISeHFTEMpAQAaYgwwWSFouIAAAAASUVORK5CYII=', 'base64');
  const custom = async () => {
    await ribbon(page).getByRole('button', { name: 'Watermark' }).click();
    await page.getByRole('menuitem', { name: 'Custom Watermark…' }).click();
    return page.getByRole('dialog', { name: 'Watermark' });
  };
  let dialog = await custom();
  await dialog.getByRole('radio', { name: 'Picture' }).click();
  await dialog.locator('input[type="file"]').setInputFiles({ name: 'stamp.png', mimeType: 'image/png', buffer: png });
  await expect(dialog.getByText('stamp.png')).toBeVisible();
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect(dialog).toBeHidden();
  dialog = await custom();
  await expect(dialog.getByRole('radio', { name: 'Picture' })).toHaveAttribute('aria-checked', 'true');
  await expect(dialog.locator('.design-watermark-preview img')).toHaveCount(1);
  await dialog.getByLabel('Washout').uncheck();
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect(dialog).toBeHidden();
  const { parts } = await saved(page, info, 'watermark-picture-kept.docx');
  const header = Object.keys(parts).find(name => /^word\/header\d+\.xml$/.test(name) && strFromU8(parts[name]).includes('Document Watermark'));
  expect(strFromU8(parts[header])).toContain('&quot;washout&quot;:false');
  expect(strFromU8(parts[header])).not.toContain('<a:lum');
  const embed = /r:embed="([^"]+)"/.exec(strFromU8(parts[header]))[1];
  const target = new RegExp(`Id="${embed}"[^>]*Target="([^"]+)"`).exec(strFromU8(parts[header.replace('word/', 'word/_rels/') + '.rels']))[1];
  expect(Buffer.from(parts[`word/${target}`]).equals(png)).toBe(true);
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

test('theme files import, custom paragraph spacing applies, and Set as Default shapes new documents', async ({ page }, info) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const input = await open(page);
  // A theme package made here: a ZIP holding theme/theme/theme1.xml.
  const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
  const slots = ['dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'];
  const colors = ['000000', 'FFFFFF', '203040', 'F0F0E8', '6A4C93', '1982C4', '8AC926', 'FFCA3A', 'FF595E', '4D908E', '1982C4', '6A4C93'];
  const fills = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'.repeat(3);
  const lines = '<a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>'.repeat(3);
  const theme = `<?xml version="1.0" encoding="UTF-8"?><a:theme xmlns:a="${A}" name="Imported Grove"><a:themeElements><a:clrScheme name="Grove">${slots.map((s, i) => `<a:${s}><a:srgbClr val="${colors[i]}"/></a:${s}>`).join('')}</a:clrScheme>`
    + '<a:fontScheme name="Grove"><a:majorFont><a:latin typeface="Karla"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Karla"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>'
    + `<a:fmtScheme name="Grove"><a:fillStyleLst>${fills}</a:fillStyleLst><a:lnStyleLst>${lines}</a:lnStyleLst><a:effectStyleLst>${'<a:effectStyle><a:effectLst/></a:effectStyle>'.repeat(3)}</a:effectStyleLst><a:bgFillStyleLst>${fills}</a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;
  const thmx = info.outputPath('grove.thmx');
  (await import('node:fs')).writeFileSync(thmx, zipSync({ '[Content_Types].xml': strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'), 'theme/theme/theme1.xml': strToU8(theme) }));
  await ribbon(page).getByRole('button', { name: 'Themes' }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: 'Browse for Themes…' }).click();
  await (await chooser).setFiles(thmx);
  await expectFont(page, /Karla/);
  await ribbon(page).getByRole('button', { name: 'Themes' }).click();
  await expect(page.getByRole('menuitemradio', { name: 'Grove theme' })).toBeVisible();
  await page.keyboard.press('Escape');
  // Custom paragraph spacing edits the Normal style.
  await ribbon(page).getByRole('button', { name: 'Paragraph Spacing' }).click();
  await page.getByRole('menuitem', { name: 'Custom Paragraph Spacing…' }).click();
  const spacing = page.getByRole('dialog', { name: 'Custom Paragraph Spacing' });
  await spacing.getByLabel('After (pt)').fill('14');
  await spacing.getByLabel('Line spacing (multiple)').fill('1.3');
  await spacing.getByRole('button', { name: 'OK' }).click();
  await input.press('ControlOrMeta+End');
  const { parts } = await saved(page, info, 'imported-theme.docx');
  expect(strFromU8(parts['word/theme/theme1.xml'])).toContain('name="Imported Grove"');
  expect(strFromU8(parts['word/styles.xml'])).toMatch(/w:styleId="Normal"[\s\S]*?w:after="280"/);
  // New documents take the theme and style set saved as the default.
  await ribbon(page).getByRole('button', { name: 'Set as Default' }).click();
  await page.getByRole('dialog', { name: 'Set as Default' }).getByRole('button', { name: 'Set as Default' }).click();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Document text' })).toHaveValue('');
  await expectFont(page, /Karla/);
  await page.evaluate(() => localStorage.removeItem('documents.design.defaults'));
  expect(errors).toEqual([]);
});

test('a Word watermark shows as the current watermark, and a new one or Remove Watermark replaces it', async ({ page }, info) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const FIXTURE = 'tests/fixtures/vml-watermarks/watermarks.docx';
  const word = parts => ['word/header1.xml', 'word/header2.xml'].map(path => (strFromU8(parts[path]).match(/PowerPlusWaterMarkObject|WordPictureWatermark/g) || []).length);
  const ours = parts => ['word/header1.xml', 'word/header2.xml'].map(path => (strFromU8(parts[path]).match(/name="Document Watermark"/g) || []).length);
  const openFixture = async () => {
    await page.goto('/playground.html');
    await page.getByRole('button', { name: 'New', exact: true }).click();
    page.once('dialog', dialog => dialog.accept());
    await page.getByLabel('Open DOCX file').setInputFiles(FIXTURE);
    await expect(page.getByRole('textbox', { name: 'Document text' })).toHaveValue('Body text.');
    await onTab(page, 'design');
  };
  await openFixture();
  // The gallery and the dialog show Word's CONFIDENTIAL, diagonal, in Calibri.
  await ribbon(page).getByRole('button', { name: 'Watermark' }).click();
  await expect(page.getByRole('menuitemradio', { name: 'CONFIDENTIAL, diagonal' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('menuitem', { name: 'Remove Watermark' })).toBeEnabled();
  await page.getByRole('menuitem', { name: 'Custom Watermark…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Watermark' });
  await expect(dialog.getByLabel('Text')).toHaveValue('CONFIDENTIAL');
  await expect(dialog.getByRole('combobox', { name: 'Font' })).toHaveValue('Calibri');
  await expect(dialog.getByRole('radio', { name: 'Diagonal' })).toHaveAttribute('aria-checked', 'true');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  // Untouched, Word's watermark saves as it was.
  let { parts } = await saved(page, info, 'word-watermark-kept.docx');
  expect(word(parts)).toEqual([1, 1]);
  // A new watermark replaces Word's.
  await ribbon(page).getByRole('button', { name: 'Watermark' }).click();
  await page.getByRole('menuitemradio', { name: 'DRAFT, horizontal' }).click();
  ({ parts } = await saved(page, info, 'word-watermark-replaced.docx'));
  expect(word(parts)).toEqual([0, 0]);
  expect(ours(parts)).toEqual([1, 1]);
  // Remove Watermark removes Word's.
  await openFixture();
  await ribbon(page).getByRole('button', { name: 'Watermark' }).click();
  await page.getByRole('menuitem', { name: 'Remove Watermark' }).click();
  ({ parts } = await saved(page, info, 'word-watermark-removed.docx'));
  expect(word(parts)).toEqual([0, 0]);
  expect(ours(parts)).toEqual([0, 0]);
  expect(strFromU8(parts['word/header1.xml'])).toContain('Acme internal');
  expect(errors).toEqual([]);
});
