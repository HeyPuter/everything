import { test, expect } from '@playwright/test';
import { onTab, downloadDocx } from './helpers/editor-tools.js';
import { reopenDocx } from './helpers/reopen-docx.js';
import { unzipSync, strFromU8 } from 'fflate';
import { readFileSync } from 'node:fs';

test.setTimeout(120000);
const ribbon = (page, name) => page.locator('.ribbon-card').getByRole('button', { name, exact: true });
async function select(input, text, end = text) {
  await input.evaluate((el, [text, end]) => { const at = el.value.indexOf(text), to = el.value.indexOf(end) + end.length; el.setSelectionRange(at, to); el.dispatchEvent(new Event('select', { bubbles: true })); }, [text, end]);
}
async function blank(page, text) {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/playground.html');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Document text' });
  await input.fill(text);
  await onTab(page, 'home');
  return { input, errors };
}
async function save(page, info, name) {
  const path = info.outputPath(name);
  const download = page.waitForEvent('download'); await downloadDocx(page); await (await download).saveAs(path);
  return { path, xml: part => strFromU8(unzipSync(readFileSync(path))[part]) };
}

test('Borders and Shading: presets, side toggles, page border and patterned shading in one step each', async ({ page }, info) => {
  const { input, errors } = await blank(page, 'Bordered one\nBordered two\nPlain');
  await select(input, 'Bordered one', 'Bordered two');
  // The ribbon Borders arrow: presets and the dialog.
  await page.getByRole('button', { name: 'Border options' }).click();
  await page.getByRole('menuitem', { name: 'Borders and Shading…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Borders and Shading' });
  await dialog.getByRole('button', { name: 'Box', exact: true }).click();
  await expect(dialog.getByRole('group', { name: 'Border sides' }).getByRole('button', { name: 'Top' })).toHaveAttribute('aria-pressed', 'true');
  await dialog.getByLabel('Border style', { exact: true }).selectOption('double');
  await dialog.getByLabel('Border width', { exact: true }).selectOption('12');
  await dialog.getByRole('group', { name: 'Border sides' }).getByRole('button', { name: 'Between paragraphs' }).click();
  await expect(dialog.getByRole('button', { name: 'All', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await dialog.getByRole('group', { name: 'Border sides' }).getByRole('button', { name: 'Left' }).click();
  await expect(dialog.getByRole('group', { name: 'Border sides' }).getByRole('button', { name: 'Left' })).toHaveAttribute('aria-pressed', 'false');
  // Page border.
  await dialog.getByRole('tab', { name: 'Page Border' }).click();
  await dialog.getByRole('button', { name: 'Box', exact: true }).click();
  await dialog.getByLabel('Measure from').selectOption('page');
  // Shading: a 25% pattern in black over a light fill paints as one flat color.
  await dialog.getByRole('tab', { name: 'Shading' }).click();
  await dialog.getByLabel('Pattern style').selectOption('pct25');
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(input).toBeFocused();
  let saved = await save(page, info, 'borders-shading.docx');
  let xml = saved.xml('word/document.xml');
  const first = xml.slice(0, xml.indexOf('Bordered one'));
  expect(first).toMatch(/<w:pBdr><w:top w:val="double" w:sz="12"[^>]*\/><w:left w:val="none"[\s\S]*<w:between w:val="double"/);
  expect(first).toMatch(/<w:shd w:val="clear" w:color="auto" w:fill="BFBFBF"\/>/);
  expect(xml).toMatch(/<w:pgBorders w:offsetFrom="page"[^>]*><w:top w:val="single" w:sz="4" w:space="24"/);
  // Undo the dialog's change in one step.
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  saved = await save(page, info, 'borders-shading-undone.docx');
  xml = saved.xml('word/document.xml');
  expect(xml).not.toMatch(/pBdr|pgBorders/);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  // The Borders button repeats the last preset; the menu toggles a side off again.
  await select(input, 'Plain');
  await page.getByRole('button', { name: 'Border options' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Bottom Border' }).click();
  await ribbon(page, 'Borders').click(); // same side again: stays on (repeat, not toggle)
  saved = await save(page, info, 'borders-menu.docx');
  xml = saved.xml('word/document.xml');
  expect(xml.slice(xml.indexOf('Bordered two'), xml.indexOf('Plain'))).toMatch(/<w:bottom w:val="single" w:sz="4"/);
  await reopenDocx(page, input, saved.path, 'Bordered one\nBordered two\nPlain');
  expect(errors).toEqual([]);
});

test('Borders and Shading: OK with only shading chosen leaves paragraph borders alone', async ({ page }, info) => {
  const { input, errors } = await blank(page, 'Bordered one\nPlain two');
  await select(input, 'Bordered one');
  await page.getByRole('button', { name: 'Border options' }).click();
  await page.getByRole('menuitem', { name: 'Borders and Shading…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Borders and Shading' });
  await dialog.getByRole('button', { name: 'Box', exact: true }).click();
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect(dialog).toHaveCount(0);
  // Both paragraphs, borders differing: change nothing about the borders.
  await select(input, 'Bordered one', 'Plain two');
  await page.getByRole('button', { name: 'Border options' }).click();
  await page.getByRole('menuitem', { name: 'Borders and Shading…' }).click();
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect(dialog).toHaveCount(0);
  const { xml } = await save(page, info, 'borders-kept.docx');
  const document = xml('word/document.xml');
  expect(document.match(/<w:pBdr>/g)).toHaveLength(1);
  expect(document).toMatch(/<w:pBdr><w:top w:val="single"[\s\S]*Bordered one/);
  expect(errors).toEqual([]);
});

test('Bullets and numbering: define a bullet and a number format, set the value, continue, adjust indents', async ({ page }, info) => {
  const { input, errors } = await blank(page, 'Alpha\nBeta\nGap\nGamma\nDelta');
  await select(input, 'Alpha', 'Beta');
  await page.getByRole('button', { name: 'Bullet Library' }).click();
  await page.getByRole('menuitem', { name: 'Define New Bullet…' }).click();
  const bullet = page.getByRole('dialog', { name: 'Define New Bullet' });
  await bullet.getByRole('radio', { name: 'Bullet ★' }).click();
  await bullet.getByLabel('Bullet alignment').selectOption('center');
  await expect(bullet.locator('.fmt-list-preview-label').first()).toHaveText('★');
  await bullet.getByRole('button', { name: 'OK' }).click();
  await expect(bullet).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Bulleted list', exact: true })).toHaveAttribute('aria-pressed', 'true');
  // A numbered list in two parts.
  await select(input, 'Gamma', 'Delta');
  await page.getByRole('button', { name: 'Numbering Library' }).click();
  await page.getByRole('menuitem', { name: 'Define New Number Format…' }).click();
  const number = page.getByRole('dialog', { name: 'Define New Number Format' });
  await number.getByLabel('Number style').selectOption('upperRoman');
  await number.getByLabel('Text before number').fill('Step ');
  await number.getByLabel('Text after number').fill(':');
  await expect(number.locator('.fmt-list-preview-label').nth(1)).toHaveText('Step II:');
  await number.getByRole('button', { name: 'OK' }).click();
  // Set numbering value from the list context menu.
  await select(input, 'Delta');
  await input.dispatchEvent('contextmenu');
  const menu = page.getByRole('menu', { name: 'Document menu' });
  await menu.getByRole('menuitem', { name: 'Set Numbering Value…' }).click();
  const value = page.getByRole('dialog', { name: 'Set Numbering Value' });
  await value.getByLabel('Set value to').fill('7');
  await value.getByRole('button', { name: 'OK' }).click();
  // Adjust indents from the Format dialog's list menu.
  await input.dispatchEvent('contextmenu');
  await menu.getByRole('menuitem', { name: 'Adjust List Indents…' }).click();
  const indents = page.getByRole('dialog', { name: 'Adjust List Indents' });
  await indents.getByLabel('Number position (in)').fill('0.25');
  await indents.getByLabel('Text indent (in)').fill('1');
  await indents.getByLabel('Follow number with').selectOption('space');
  await indents.getByRole('button', { name: 'OK' }).click();
  const saved = await save(page, info, 'bullets-numbering.docx');
  const numbering = saved.xml('word/numbering.xml');
  expect(numbering).toMatch(/<w:lvlText w:val="★"\/>/);
  expect(numbering).toMatch(/<w:lvlText w:val="Step %1:"\/>/);
  expect(numbering).toMatch(/<w:suff w:val="space"\/>/);
  expect(numbering).toMatch(/<w:startOverride w:val="7"\/>/);
  await reopenDocx(page, input, saved.path, 'Alpha\nBeta\nGap\nGamma\nDelta');
  expect(errors).toEqual([]);
});

test('Define New Multilevel List: per-level number format and style', async ({ page }, info) => {
  const { input, errors } = await blank(page, 'Top\nNested\nNext');
  await select(input, 'Top', 'Next');
  await page.getByRole('button', { name: 'Multilevel List', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Define New Multilevel List…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Define New Multilevel List' });
  await dialog.getByRole('listbox', { name: 'Level to modify' }).getByRole('option', { name: '2', exact: true }).click();
  await dialog.getByLabel('Level number style').selectOption('lowerLetter');
  await dialog.getByLabel('Level format text').fill('%1.%2)');
  await expect(dialog.locator('.fmt-list-preview-label').nth(1)).toHaveText('1.a)');
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect(dialog).toHaveCount(0);
  await select(input, 'Nested');
  await input.press(process.platform === 'darwin' ? 'Control+Shift+ArrowRight' : 'Alt+Shift+ArrowRight');
  await expect(page.getByRole('button', { name: 'Numbered list', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const saved = await save(page, info, 'multilevel.docx');
  expect(saved.xml('word/numbering.xml')).toMatch(/<w:lvl w:ilvl="1"><w:start w:val="1"\/><w:numFmt w:val="lowerLetter"\/><w:suff w:val="tab"\/><w:lvlText w:val="%1.%2\)"\/>/);
  await reopenDocx(page, input, saved.path, 'Top\nNested\nNext');
  expect(errors).toEqual([]);
});
