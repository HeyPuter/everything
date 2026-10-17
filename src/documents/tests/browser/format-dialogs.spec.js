import { test, expect } from '@playwright/test';
import { onTab, downloadDocx } from './helpers/editor-tools.js';
import { reopenDocx } from './helpers/reopen-docx.js';
import { unzipSync, strFromU8 } from 'fflate';
import { readFileSync } from 'node:fs';

test.setTimeout(120000);
const ribbon = (page, name) => page.locator('.ribbon-card').getByRole('button', { name, exact: true });
async function select(input, text) {
  await input.evaluate((el, text) => { const at = el.value.indexOf(text); el.setSelectionRange(at, at + text.length); el.dispatchEvent(new Event('select', { bubbles: true })); }, text);
}
async function caret(input, text) {
  await input.evaluate((el, text) => { const at = el.value.indexOf(text); el.setSelectionRange(at, at); el.dispatchEvent(new Event('select', { bubbles: true })); }, text);
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

test('Font dialog: hidden text, live preview, Set As Default and Text Effects', async ({ page }, info) => {
  const { input, errors } = await blank(page, 'Visible secret words\nSecond paragraph');
  await select(input, 'secret');
  await input.press('ControlOrMeta+d');
  const dialog = page.getByRole('dialog', { name: 'Font' });
  await dialog.getByLabel('Hidden').check();
  await expect(dialog.locator('.ed-font-preview span')).toHaveCSS('opacity', '0.55');
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect(dialog).toHaveCount(0);
  // Hidden text is kept in the text but takes no room until formatting marks are shown.
  await expect(input).toHaveValue('Visible secret words\nSecond paragraph');
  await ribbon(page, 'Show Formatting Marks').click();
  await expect(ribbon(page, 'Show Formatting Marks')).toHaveAttribute('aria-pressed', 'true');
  await ribbon(page, 'Show Formatting Marks').click();
  // Set As Default changes the Normal style's font size.
  await caret(input, 'Second');
  await ribbon(page, 'Font Settings').click();
  await dialog.getByLabel('Size', { exact: true }).fill('14');
  await dialog.getByRole('button', { name: 'Set As Default' }).click();
  await page.getByRole('dialog', { name: 'Set as default' }).getByRole('button', { name: 'Set As Default' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('spinbutton', { name: 'Font size (pt)', exact: true })).toHaveValue('14');
  // Text effects from the Font dialog.
  await select(input, 'Visible');
  await ribbon(page, 'Font Settings').click();
  await dialog.getByRole('button', { name: 'Text Effects…' }).click();
  const effects = page.getByRole('dialog', { name: 'Format Text Effects' });
  await effects.getByLabel('Text outline').selectOption('solid');
  await effects.getByRole('tab', { name: 'Shadow' }).click();
  await effects.getByLabel('Shadow type').selectOption('outer');
  await effects.getByRole('button', { name: 'OK' }).click();
  await expect(effects).toHaveCount(0);
  const saved = await save(page, info, 'font-dialog-extras.docx');
  const xml = saved.xml('word/document.xml');
  expect(xml).toMatch(/<w:vanish w:val="1"\/>[\s\S]*secret/);
  expect(xml).toMatch(/w14:textOutline[\s\S]*Visible/);
  expect(xml).toMatch(/w14:shadow[\s\S]*Visible/);
  expect(saved.xml('word/styles.xml')).toMatch(/w:styleId="Normal"[\s\S]*?<w:sz w:val="28"\/>/);
  await reopenDocx(page, input, saved.path, 'Visible secret words\nSecond paragraph');
  expect(errors).toEqual([]);
});

test('Paragraph dialog: indents, spacing, line and page breaks with preview, Tabs and undo', async ({ page }, info) => {
  const { input, errors } = await blank(page, 'First paragraph text\nSecond paragraph text');
  await caret(input, 'First');
  await ribbon(page, 'Paragraph Settings').click();
  const dialog = page.getByRole('dialog', { name: 'Paragraph' });
  await dialog.getByLabel('Alignment').selectOption('center');
  await dialog.getByLabel('Left indent (in)').fill('0.5');
  await dialog.getByLabel('Special indent', { exact: true }).selectOption('hanging');
  await dialog.getByLabel('Special indent by (in)').fill('0.25');
  await dialog.getByLabel('Mirror indents').check();
  await expect(dialog.getByText('Inside', { exact: true })).toBeVisible();
  await dialog.getByLabel('Spacing before (pt)').fill('12');
  await dialog.getByLabel('Line spacing', { exact: true }).selectOption('exact');
  await expect(dialog.getByLabel('Line spacing at')).toHaveValue('12');
  await dialog.getByLabel('Line spacing at').fill('18');
  await dialog.getByLabel('Don’t add space between paragraphs of the same style').check();
  await expect(dialog.locator('.fmt-preview-sample')).toHaveCSS('text-align', 'center');
  await dialog.getByRole('tab', { name: 'Line and Page Breaks' }).click();
  await dialog.getByLabel('Keep with next').check();
  await dialog.getByLabel('Suppress line numbers').check();
  await dialog.getByLabel('Don’t hyphenate').check();
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(input).toBeFocused();
  await expect(page.getByRole('button', { name: 'Align center', exact: true })).toHaveAttribute('aria-pressed', 'true');
  // Tabs… from the Paragraph dialog: a decimal stop with a dot leader.
  await ribbon(page, 'Paragraph Settings').click();
  await dialog.getByRole('button', { name: 'Tabs…' }).click();
  const tabs = page.getByRole('dialog', { name: 'Tabs' });
  await tabs.getByLabel('Tab stop position (in)').fill('3');
  await tabs.getByLabel('Decimal').check();
  await tabs.getByLabel('Dots', { exact: true }).check();
  await tabs.getByRole('button', { name: 'Set', exact: true }).click();
  await tabs.getByLabel('Tab stop position (in)').fill('4.5');
  await tabs.getByLabel('Right', { exact: true }).check();
  await tabs.getByRole('button', { name: 'Set', exact: true }).click();
  await expect(tabs.getByRole('option')).toHaveCount(2);
  await tabs.getByRole('option').first().click();
  await tabs.getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(tabs.getByRole('option')).toHaveCount(1);
  await expect(tabs.getByText(/Tab stops to be cleared: 3 in/)).toBeVisible();
  await tabs.getByLabel('Default tab stops (in)').fill('0.75');
  await tabs.getByRole('button', { name: 'OK' }).click();
  await expect(tabs).toHaveCount(0);
  const saved = await save(page, info, 'paragraph-dialog.docx');
  const xml = saved.xml('word/document.xml'), first = xml.slice(0, xml.indexOf('First paragraph'));
  expect(first).toMatch(/<w:keepNext w:val="1"\/>/);
  expect(first).toMatch(/<w:suppressLineNumbers w:val="1"\/>/);
  expect(first).toMatch(/<w:suppressAutoHyphens w:val="1"\/>/);
  expect(first).toMatch(/<w:mirrorIndents w:val="1"\/>/);
  expect(first).toMatch(/<w:contextualSpacing w:val="1"\/>/);
  expect(first).toMatch(/<w:tab w:val="right" w:pos="6480" w:leader="dot"\/>/);
  expect(first).toMatch(/w:line="360" w:lineRule="exact"/);
  expect(first).toMatch(/<w:jc w:val="center"\/>/);
  expect(saved.xml('word/settings.xml')).toMatch(/<w:defaultTabStop w:val="1080"\/>/);
  // Undo returns the paragraph to its previous look; redo brings it back.
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Align center', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Align center', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await reopenDocx(page, input, saved.path, 'First paragraph text\nSecond paragraph text');
  await caret(input, 'First');
  await ribbon(page, 'Paragraph Settings').click();
  await expect(dialog.getByLabel('Mirror indents')).toBeChecked();
  await expect(dialog.getByLabel('Left indent (in)')).toHaveValue('0.5');
  await dialog.getByRole('tab', { name: 'Line and Page Breaks' }).click();
  await expect(dialog.getByLabel('Keep with next')).toBeChecked();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  expect(errors).toEqual([]);
});

test('Format dialogs bring forward the tab holding an invalid value instead of ignoring OK', async ({ page }) => {
  const { input, errors } = await blank(page, 'First paragraph text');
  await select(input, 'First');
  await ribbon(page, 'Font Settings').click();
  const font = page.getByRole('dialog', { name: 'Font' });
  await font.getByRole('tab', { name: 'Advanced' }).click();
  await font.getByLabel('Scale (%)').fill('700');
  await font.getByRole('tab', { name: 'Font', exact: true }).click();
  await font.getByRole('button', { name: 'OK' }).click();
  // OK stays in the dialog and shows the field that needs fixing.
  await expect(font.getByRole('tab', { name: 'Advanced' })).toHaveAttribute('aria-selected', 'true');
  await expect(font.getByLabel('Scale (%)')).toBeFocused();
  await font.getByRole('button', { name: 'Cancel' }).click();
  await expect(font).toHaveCount(0);

  await ribbon(page, 'Paragraph Settings').click();
  const paragraph = page.getByRole('dialog', { name: 'Paragraph' });
  await paragraph.getByLabel('Left indent (in)').fill('99');
  await paragraph.getByRole('tab', { name: 'Line and Page Breaks' }).click();
  await paragraph.getByRole('button', { name: 'OK' }).click();
  await expect(paragraph.getByRole('tab', { name: 'Indents and Spacing' })).toHaveAttribute('aria-selected', 'true');
  await expect(paragraph.getByLabel('Left indent (in)')).toBeFocused();
  await paragraph.getByRole('button', { name: 'Cancel' }).click();

  await onTab(page, 'layout');
  await page.locator('.ribbon-card').getByRole('button', { name: 'Page setup', exact: true }).click();
  const setup = page.getByRole('dialog', { name: 'Page setup' });
  await setup.getByRole('tab', { name: 'Layout' }).click();
  await setup.getByLabel('Header (in)').fill('-3');
  await setup.getByRole('tab', { name: 'Page' }).click();
  await setup.getByRole('button', { name: 'Apply' }).click();
  await expect(setup.getByRole('alert')).toContainText('Enter a measurement');
  await expect(setup.getByLabel('Header (in)')).toBeFocused();
  expect(errors).toEqual([]);
});
