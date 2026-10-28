import { test, expect } from '@playwright/test';
import { onTab, downloadDocx } from './helpers/editor-tools.js';
import { unzipSync, strFromU8 } from 'fflate';
import { readFileSync } from 'node:fs';

test.setTimeout(150000);
const ribbon = (page, name) => page.locator('.ribbon-card').getByRole('button', { name, exact: true });
async function select(input, text, end = text, from = 0) {
  await input.evaluate((el, [text, end, from]) => { const at = el.value.indexOf(text, from), to = el.value.indexOf(end, at) + end.length; el.setSelectionRange(at, to); el.dispatchEvent(new Event('select', { bubbles: true })); }, [text, end, from]);
}
async function caretAtEnd(input) { await input.evaluate(el => { el.setSelectionRange(el.value.length, el.value.length); el.dispatchEvent(new Event('select', { bubbles: true })); }); }
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

test('Paste options: merge formatting, switch mode from the paste chip, and Paste Special', async ({ page, context, baseURL }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseURL });
  const { input, errors } = await blank(page, 'Big red words\nTarget: ');
  await select(input, 'Big red words');
  await page.getByRole('spinbutton', { name: 'Font size (pt)', exact: true }).fill('20');
  await page.getByRole('spinbutton', { name: 'Font size (pt)', exact: true }).press('Enter');
  await select(input, 'red');
  await ribbon(page, 'Bold').click();
  await select(input, 'Big red words');
  await ribbon(page, 'Copy').click();
  await caretAtEnd(input);
  await page.getByRole('button', { name: 'Paste options', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Merge Formatting' }).click();
  await expect(input).toHaveValue('Big red words\nTarget: Big red words');
  // Merged: the destination's 12 pt, with the source's bold kept.
  await select(input, 'red', 'red', 20);
  await expect(page.getByRole('spinbutton', { name: 'Font size (pt)', exact: true })).toHaveValue('12');
  await expect(ribbon(page, 'Bold')).toHaveAttribute('aria-pressed', 'true');
  // Paste with the source formatting, then switch to text only from the chip.
  await caretAtEnd(input);
  await page.getByRole('button', { name: 'Paste options', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Keep Source Formatting' }).click();
  const chip = page.getByRole('button', { name: 'Pasted text options' });
  await expect(chip).toBeVisible();
  await chip.click();
  await page.getByRole('menuitemradio', { name: 'Keep Text Only' }).click();
  await expect(input).toHaveValue('Big red words\nTarget: Big red wordsBig red words');
  await select(input, 'red', 'red', 34);
  await expect(ribbon(page, 'Bold')).toHaveAttribute('aria-pressed', 'false');
  // One undo removes the whole paste.
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(input).toHaveValue('Big red words\nTarget: Big red words');
  // Paste Special offers the clipboard's forms.
  await caretAtEnd(input);
  await page.getByRole('button', { name: 'Paste options', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Paste Special…' }).click();
  const special = page.getByRole('dialog', { name: 'Paste Special' });
  await expect(special.getByText('Source: Big red words')).toBeVisible();
  await special.getByLabel(/Unformatted text/).check();
  await special.getByRole('button', { name: 'OK' }).click();
  await expect(input).toHaveValue('Big red words\nTarget: Big red wordsBig red words');
  expect(errors).toEqual([]);
});

test('Advanced Find and Replace: wildcards, special characters, formatting and selection scope', async ({ page }, info) => {
  const { input, errors } = await blank(page, 'Smith, John; Doe, Jane\nplain bold plain bold\nnext\tcolumn');
  await select(input, 'bold');
  await ribbon(page, 'Bold').click();
  await select(input, 'bold', 'bold', 33);
  await ribbon(page, 'Bold').click();
  await page.getByRole('button', { name: 'Find options' }).click();
  await page.getByRole('menuitem', { name: 'Advanced Find…' }).click();
  const panel = page.getByRole('search', { name: 'Find and replace' });
  await expect(panel.getByRole('button', { name: 'Fewer options' })).toBeVisible();
  const query = panel.getByRole('textbox', { name: 'Find text', exact: true }), replacement = panel.getByRole('textbox', { name: 'Replace with', exact: true });
  await panel.getByLabel('Use wildcards').check();
  await query.fill('([A-Z][a-z]@), ([A-Z][a-z]@)');
  await expect(panel.locator('.canvas-find-count')).toHaveText(/2 matches|1 of 2/);
  await replacement.fill('\\2 \\1');
  await panel.getByRole('button', { name: 'Replace all', exact: true }).click();
  await expect(input).toHaveValue('John Smith; Jane Doe\nplain bold plain bold\nnext\tcolumn');
  await panel.getByLabel('Use wildcards').uncheck();
  // Special characters from the Special menu.
  await query.fill('');
  await query.focus();
  await panel.getByRole('button', { name: 'Special' }).click();
  await page.getByRole('menuitem', { name: /Tab character/ }).click();
  await expect(query).toHaveValue('^t');
  await expect(panel.locator('.canvas-find-count')).toHaveText(/1 match|1 of 1/);
  await replacement.fill(' | ');
  await panel.getByRole('button', { name: 'Replace all', exact: true }).click();
  await expect(input).toHaveValue('John Smith; Jane Doe\nplain bold plain bold\nnext | column');
  // Find bold text (formatting only) and replace it with italic formatting.
  await query.fill('');
  await query.focus();
  await panel.getByRole('button', { name: 'Format', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Font…' }).click();
  const font = page.getByRole('dialog', { name: 'Find Font' });
  await font.getByLabel('Font style').selectOption('bold');
  await font.getByRole('button', { name: 'OK' }).click();
  await expect(panel.getByText('Find formatting: Bold')).toBeVisible();
  await expect(panel.locator('.canvas-find-count')).toHaveText(/2 matches|1 of 2/);
  await replacement.fill('');
  await replacement.focus();
  await panel.getByRole('button', { name: 'Format', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Font…' }).click();
  await page.getByRole('dialog', { name: 'Find Font' }).getByLabel('Font style').selectOption('italic');
  await page.getByRole('dialog', { name: 'Find Font' }).getByRole('button', { name: 'OK' }).click();
  await expect(panel.getByText(/Replace formatting: Not bold, Italic/)).toBeVisible();
  await panel.getByRole('button', { name: 'Replace all', exact: true }).click();
  await expect(panel.locator('.canvas-find-notice')).toHaveText('Replaced 2 matches.');
  await expect(input).toHaveValue('John Smith; Jane Doe\nplain bold plain bold\nnext | column');
  const saved = await save(page, info, 'advanced-find.docx');
  const xml = saved.xml('word/document.xml');
  expect(xml).toMatch(/<w:i w:val="1"\/>[\s\S]*bold/);
  expect(xml).not.toMatch(/<w:b w:val="1"\/>/);
  // Undo restores the bold text in one step.
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(panel.locator('.canvas-find-count')).toHaveText(/2 matches|of 2/);
  expect(errors).toEqual([]);
});

test('Advanced Find searches headers and footers and a selection', async ({ page }, info) => {
  const { input, errors } = await blank(page, 'Report body one report body two report');
  await (await onTab(page, 'insert')).locator('#ribbon-panel-insert').getByRole('button', { name: 'Header', exact: true }).click();
  // The Header gallery: a blank header whose placeholder is selected; typing replaces it.
  await page.getByRole('menuitem', { name: 'Edit Header' }).click();
  await expect(page.locator('#ribbon-tab-headerFooter')).toHaveAttribute('aria-selected', 'true');
  await page.waitForTimeout(1500);
  await page.locator('.canvas-input').focus();
  await page.keyboard.type('Quarterly report header');
  await page.getByRole('button', { name: 'Close Header and Footer' }).click();
  await onTab(page, 'home');
  await page.getByRole('button', { name: 'Find options' }).click();
  await page.getByRole('menuitem', { name: 'Advanced Find…' }).click();
  const panel = page.getByRole('search', { name: 'Find and replace' });
  const query = panel.getByRole('textbox', { name: 'Find text', exact: true });
  await query.fill('report');
  await expect(panel.locator('.canvas-find-count')).toHaveText(/3 matches|of 3/);
  await panel.getByLabel('Search in').selectOption('headers');
  await expect(panel.locator('.canvas-find-count')).toHaveText(/1 match|1 of 1/);
  await panel.getByRole('textbox', { name: 'Replace with', exact: true }).fill('summary');
  await panel.getByRole('button', { name: 'Replace all', exact: true }).click();
  await expect(panel.locator('.canvas-find-notice')).toHaveText('Replaced 1 match.');
  // The main document is the body, also from the header just edited: its three matches, one of them chosen in the body.
  await panel.getByLabel('Search in').selectOption('document');
  await expect(panel.locator('.canvas-find-count')).toHaveText(/of 3$/);
  await expect(page.getByRole('button', { name: 'Close Header and Footer' })).toHaveCount(0);
  // A selection scope counts only matches inside the selection.
  await input.evaluate(el => { el.setSelectionRange(0, 15); el.dispatchEvent(new Event('select', { bubbles: true })); });
  await panel.getByLabel('Search in').selectOption('selection');
  await expect(panel.locator('.canvas-find-count')).toHaveText(/1 match|1 of 1/);
  const saved = await save(page, info, 'find-headers.docx');
  const files = unzipSync(readFileSync(saved.path)), header = Object.keys(files).find(name => /^word\/header\d*\.xml$/.test(name));
  expect(strFromU8(files[header])).toMatch(/Quarterly summary header|summary/);
  expect(saved.xml('word/document.xml')).toContain('Report body one report body two report');
  expect(errors).toEqual([]);
});
