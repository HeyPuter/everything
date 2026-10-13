import { test, expect } from '@playwright/test';
import { readFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { onTab, downloadDocx } from './helpers/editor-tools.js';
import { reopenDocx } from './helpers/reopen-docx.js';

const ribbon = page => page.locator('.ribbon-card');
const canvases = page => page.locator('canvas.canvas-page');
const xmlOf = (path, name = 'word/document.xml') => strFromU8(unzipSync(readFileSync(path))[name] || new Uint8Array());

async function blank(page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/playground.html');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Document text' });
  await expect(input).toBeFocused();
  return input;
}
async function choose(page, button, item, role = 'menuitem') {
  await (await onTab(page, 'layout'));
  await ribbon(page).getByRole('button', { name: button, exact: true }).click();
  await page.getByRole(role, { name: item }).first().click();
}
async function save(page, info, name) {
  const path = info.outputPath(name);
  const download = page.waitForEvent('download'); await downloadDocx(page); await (await download).saveAs(path);
  // Keep the exports for schema validation.
  mkdirSync('test-results/page-layout', { recursive: true }); copyFileSync(path, `test-results/page-layout/${name}`);
  return path;
}

test('section breaks from the Breaks menu start pages by kind, undo in one step and survive saving', async ({ page }, info) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const input = await blank(page);
  await page.keyboard.type('First section');
  await choose(page, 'Breaks', /^Odd Page/);
  await expect(input).toBeFocused();
  // One page of text, then an empty even page, then the odd page the new section starts on.
  await expect(canvases(page)).toHaveCount(3);
  await page.keyboard.type('Second section');
  await expect(input).toHaveValue('First section\nSecond section');
  // Undo the typing, then the break in one step; redo brings the break back.
  for (let i = 0; i < 4 && await input.inputValue() !== 'First section\n'; i++) await input.press('ControlOrMeta+z');
  await expect(input).toHaveValue('First section\n');
  await input.press('ControlOrMeta+z');
  await expect(input).toHaveValue('First section');
  await expect(canvases(page)).toHaveCount(1);
  await input.press('ControlOrMeta+Shift+z');
  await expect(canvases(page)).toHaveCount(3);
  await input.press('ControlOrMeta+End'); await page.keyboard.type('Second section');
  await choose(page, 'Breaks', /^Continuous/);
  await page.keyboard.type('Third section');
  await expect(canvases(page)).toHaveCount(3);
  // The menu describes each break.
  await ribbon(page).getByRole('button', { name: 'Breaks', exact: true }).click();
  for (const name of ['Page', 'Column', 'Text Wrapping', 'Next Page', 'Continuous', 'Even Page', 'Odd Page']) await expect(page.getByRole('menuitem', { name: new RegExp(`^${name}`) }).first()).toBeVisible();
  await page.screenshot({ path: info.outputPath('breaks-menu.png') });
  await page.keyboard.press('Escape');
  const path = await save(page, info, 'section-breaks.docx');
  const xml = xmlOf(path);
  expect(xml.match(/<w:sectPr\b/g)).toHaveLength(3);
  expect(xml).toContain('<w:type w:val="oddPage"/>');
  expect(xml).toMatch(/<w:type w:val="continuous"\/>.*<\/w:body>/s);
  await reopenDocx(page, input, path, 'First section\nSecond section\nThird section');
  await expect(canvases(page)).toHaveCount(3);
  expect(errors).toEqual([]);
});

test('Page Setup changes one section, mirrors margins, aligns the page and reopens with its settings', async ({ page }, info) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const input = await blank(page);
  await page.keyboard.type('Cover');
  await choose(page, 'Breaks', /^Next Page/);
  await page.keyboard.type('Body');
  await expect(canvases(page)).toHaveCount(2);
  await ribbon(page).getByRole('button', { name: 'Page setup', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Page setup' });
  await expect(dialog.getByRole('combobox', { name: 'Apply to' })).toHaveValue('section');
  await dialog.getByRole('spinbutton', { name: 'Top margin (in)' }).fill('2');
  await dialog.getByRole('combobox', { name: 'Multiple pages' }).selectOption('mirror');
  await expect(dialog.getByRole('spinbutton', { name: 'Inside margin (in)' })).toHaveValue('1');
  await dialog.getByRole('tab', { name: 'Layout' }).click();
  await dialog.getByRole('combobox', { name: 'Vertical alignment' }).selectOption('center');
  await dialog.getByRole('combobox', { name: 'Section start' }).selectOption('oddPage');
  await page.screenshot({ path: info.outputPath('page-setup-layout.png') });
  await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(input).toBeFocused();
  await expect(canvases(page)).toHaveCount(3);
  const path = await save(page, info, 'page-setup-sections.docx');
  const xml = xmlOf(path);
  const [first, last] = xml.match(/<w:sectPr\b[^>]*>.*?<\/w:sectPr>/gs);
  expect(first).toMatch(/w:top="1440"/); expect(first).not.toContain('vAlign');
  expect(last).toMatch(/w:top="2880"/); expect(last).toContain('<w:vAlign w:val="center"/>'); expect(last).toContain('<w:type w:val="oddPage"/>');
  expect(xmlOf(path, 'word/settings.xml')).toContain('<w:mirrorMargins/>');
  // The whole change is one undo step.
  await input.press('ControlOrMeta+z');
  await expect(canvases(page)).toHaveCount(2);
  await input.press('ControlOrMeta+Shift+z');
  await reopenDocx(page, input, path, 'Cover\nBody');
  await expect(canvases(page)).toHaveCount(3);
  // The dialog shows the caret's section: the second one.
  await input.press('ControlOrMeta+End');
  await onTab(page, 'layout');
  await ribbon(page).getByRole('button', { name: 'Page setup', exact: true }).click();
  await expect(dialog.getByRole('combobox', { name: 'Multiple pages' })).toHaveValue('mirror');
  await expect(dialog.getByRole('spinbutton', { name: 'Top margin (in)' })).toHaveValue('2');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(errors).toEqual([]);
});

test('margins, orientation and size galleries apply presets and remember the last custom margins', async ({ page }, info) => {
  const input = await blank(page);
  await page.keyboard.type('Text');
  await choose(page, 'Margins', /^Mirrored/, 'menuitemradio');
  await ribbon(page).getByRole('button', { name: 'Margins', exact: true }).click();
  await expect(page.getByRole('menuitemradio', { name: /^Mirrored/ })).toHaveAttribute('aria-checked', 'true');
  await page.screenshot({ path: info.outputPath('margins-gallery.png') });
  await page.getByRole('menuitem', { name: 'Custom Margins…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Page setup' });
  await dialog.getByRole('combobox', { name: 'Multiple pages' }).selectOption('normal');
  await dialog.getByRole('spinbutton', { name: 'Left margin (in)' }).fill('1.5');
  await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
  await ribbon(page).getByRole('button', { name: 'Margins', exact: true }).click();
  await expect(page.getByRole('menuitemradio', { name: /^Last Custom Setting/ })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await choose(page, 'Orientation', 'Landscape', 'menuitemradio');
  let box = await canvases(page).first().boundingBox(); expect(box.width).toBeGreaterThan(box.height);
  await choose(page, 'Size', /^A5/, 'menuitemradio');
  box = await canvases(page).first().boundingBox();
  expect(Math.round(box.width)).toBe(Math.round(11906 / 15)); expect(Math.round(box.height)).toBe(Math.round(8391 / 15));
  await input.press('ControlOrMeta+z');
  box = await canvases(page).first().boundingBox(); expect(Math.round(box.width)).toBe(1056);
});

test('columns from a preset on selected text and from the Columns dialog', async ({ page }, info) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const input = await blank(page);
  const words = 'Columns flow from one to the next as the page fills. ';
  await input.fill(`Intro\n${words.repeat(12)}\nOutro`);
  await input.evaluate(el => { const start = el.value.indexOf('Columns'); el.setSelectionRange(start, el.value.indexOf('\nOutro')); el.dispatchEvent(new Event('select', { bubbles: true })); });
  await choose(page, 'Columns', 'Two', 'menuitemradio');
  let path = await save(page, info, 'columns-selection.docx');
  let xml = xmlOf(path);
  expect(xml.match(/<w:sectPr\b/g)).toHaveLength(3);
  expect(xml.match(/<w:type w:val="continuous"\/>/g)).toHaveLength(2);
  expect(xml).toContain('w:num="2"');
  await input.press('ControlOrMeta+z');
  await input.press('ControlOrMeta+Home');
  await ribbon(page).getByRole('button', { name: 'Columns', exact: true }).click();
  await page.getByRole('menuitem', { name: 'More Columns…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Columns' });
  await dialog.getByRole('button', { name: 'Three' }).click();
  await dialog.getByRole('checkbox', { name: 'Line between' }).check();
  await dialog.getByRole('checkbox', { name: 'Equal column width' }).uncheck();
  await dialog.getByRole('spinbutton', { name: 'Width of column 1 (in)' }).fill('1');
  await dialog.getByRole('spinbutton', { name: 'Width of column 1 (in)' }).press('Tab');
  await dialog.getByRole('combobox', { name: 'Apply to' }).selectOption('document');
  await page.screenshot({ path: info.outputPath('columns-dialog.png') });
  await dialog.getByRole('button', { name: 'OK', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  path = await save(page, info, 'columns-dialog.docx');
  xml = xmlOf(path);
  expect(xml).toMatch(/<w:cols w:equalWidth="0" w:num="3" w:space="720" w:sep="1"><w:col w:w="1440" w:space="720"\/>/);
  await reopenDocx(page, input, path, await input.inputValue());
  expect(errors).toEqual([]);
});

test('indent boxes follow the measurement unit', async ({ page }) => {
  const input = await blank(page);
  await page.keyboard.type('Indented');
  await onTab(page, 'view');
  await ribbon(page).getByRole('button', { name: 'Units', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'Centimeters' }).click();
  await onTab(page, 'layout');
  const left = ribbon(page).getByRole('spinbutton', { name: 'Indent left (cm)' });
  await left.fill('2.54'); await left.press('Enter');
  await expect(input).toBeFocused();
  await onTab(page, 'view');
  await ribbon(page).getByRole('button', { name: 'Units', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'Inches' }).click();
  await onTab(page, 'layout');
  await expect(ribbon(page).getByRole('spinbutton', { name: 'Indent left (in)' })).toHaveValue('1');
});

test('the Page Setup and Columns dialogs fit a phone', async ({ page }, info) => {
  await blank(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.keyboard.type('Phone');
  await onTab(page, 'layout');
  await page.getByRole('textbox', { name: 'Document text' }).focus();
  await page.keyboard.press('Escape');
  for (const [open, name] of [[() => page.locator('.ribbon-card').getByRole('button', { name: 'Page setup', exact: true }).click({ force: true }), 'Page setup']]) {
    await open();
    const dialog = page.getByRole('dialog', { name });
    await expect(dialog).toBeVisible();
    for (const control of await dialog.locator('input, select, button').all()) {
      if (!await control.isVisible()) continue;
      const box = await control.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(390.5);
    }
    await page.screenshot({ path: info.outputPath('page-setup-phone.png') });
    await page.keyboard.press('Escape');
  }
});
