import { downloadDocx, onTab, showAllTools } from './helpers/editor-tools.js';
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { reopenDocx } from './helpers/reopen-docx.js';

const input = page => page.getByRole('textbox', { name: 'Document text' });
const button = (page, name) => page.getByRole('button', { name, exact: true });
async function blank(page) { await page.goto('/mock.html#/new'); await expect(button(page, 'Bold')).toBeEnabled(); }
async function select(page, text) {
  await input(page).evaluate((el, text) => { const at = el.value.indexOf(text); if (at < 0) throw Error(text); el.focus(); el.setSelectionRange(at, at + text.length); el.dispatchEvent(new Event('select')); }, text);
}
async function inspect(page) { const more = button(page, 'Formatting Pane'); if (await more.getAttribute('aria-expanded') !== 'true') await more.click(); }
async function save(page, info, name) {
  const event = page.waitForEvent('download'); await downloadDocx(page);
  const path = info.outputPath(name); await (await event).saveAs(path); return path;
}

test('quick actions preserve selection, apply links, shade and space paragraphs, and export a table', async ({ page }, info) => {
  await blank(page); await input(page).fill('Linked words\nA shaded paragraph'); await select(page, 'Linked words');
  await onTab(page, 'insert'); await button(page, 'Insert or edit link').click();
  const link = page.getByRole('dialog', { name: 'Insert link' });
  await expect(link).toBeVisible(); await expect(page.locator('.modal-root')).toHaveCount(0);
  await page.getByLabel('Link address', { exact: true }).fill('https://example.com/cancelled'); await page.keyboard.press('Escape');
  expect(await input(page).evaluate(el => [el.selectionStart, el.selectionEnd])).toEqual([0, 12]);
  await input(page).press('ControlOrMeta+k'); await page.getByLabel('Link address', { exact: true }).fill('https://example.com/guide');
  await link.getByRole('button', { name: 'Apply', exact: true }).click(); await expect(input(page)).toBeFocused();
  await select(page, 'A shaded paragraph'); await onTab(page, 'home'); await button(page, 'Line and Paragraph Spacing').click();
  await page.getByRole('menuitemradio', { name: '1.5×', exact: true }).click();
  await inspect(page); await button(page, 'Paragraph shading').click();
  const shade = page.getByRole('menu', { name: 'Paragraph shading' });
  await shade.getByRole('textbox', { name: 'Custom paragraph fill hex value' }).fill('#DDEEFF');
  await shade.getByRole('button', { name: 'Apply custom paragraph fill' }).click();
  await expect(button(page, 'Paragraph shading')).toHaveAttribute('title', 'Paragraph shading: #DDEEFF');
  await button(page, 'Undo').click(); await expect(button(page, 'Paragraph shading')).toHaveAttribute('title', 'Paragraph shading: No fill');
  await button(page, 'Redo').click();
  await input(page).press('ControlOrMeta+End'); await input(page).press('Enter'); await onTab(page, 'insert'); await button(page, 'Insert table').click();
  const grid = page.getByRole('menu', { name: 'Insert table' });
  await grid.getByRole('menuitem', { name: '3 columns, 2 rows' }).focus(); await page.keyboard.press('Enter');
  await expect(grid).toHaveCount(0); await expect(input(page)).toBeFocused();
  await expect(page.getByRole('heading', { name: 'Table formatting' })).toBeVisible();
  const saved = await save(page, info, 'quick-actions.docx');
  const parts = unzipSync(readFileSync(saved)), xml = strFromU8(parts['word/document.xml']);
  expect(xml).toContain('w:fill="DDEEFF"'); expect(xml).toContain('w:line="360"'); expect(xml).toContain('<w:tbl');
  expect(strFromU8(parts['word/_rels/document.xml.rels'])).toContain('https://example.com/guide');
  const text = await input(page).inputValue(); await reopenDocx(page, input(page), saved, text);
  await select(page, 'A shaded paragraph'); await expect(button(page, 'Paragraph shading')).toHaveAttribute('title', 'Paragraph shading: #DDEEFF');
});

test('font picker searches available fonts, preserves script slots and theme parts, and round trips edits', async ({ page }, info) => {
  await page.goto('/playground.html'); await page.getByLabel('Open DOCX file').setInputFiles('public/fixtures/editor-ux.docx');
  await expect(input(page)).toHaveValue(/^Editor workspace/); await select(page, 'Choose this font éΩ');
  await button(page, 'Latin font family').click();
  const picker = page.getByRole('dialog', { name: 'Font', exact: true });
  await page.getByRole('searchbox', { name: 'Search fonts' }).fill('osw');
  await page.getByRole('searchbox', { name: 'Search fonts' }).press('ArrowDown');
  await expect(picker.getByRole('button', { name: /^Oswald/ })).toBeFocused();
  await page.keyboard.press('Enter'); await expect(input(page)).toBeFocused();
  await expect(button(page, 'Latin font family')).toHaveText('Oswald');
  await button(page, 'Undo').click(); await expect(button(page, 'Latin font family')).not.toHaveText('Oswald');
  await button(page, 'Redo').click();
  await select(page, 'Missing font example'); await button(page, 'Latin font family').click();
  await expect(picker).toContainText('is unavailable'); await page.keyboard.press('Escape');
  await select(page, 'Choose this font éΩ');
  const saved = await save(page, info, 'editor-fonts.docx');
  const original = unzipSync(readFileSync('public/fixtures/editor-ux.docx')), parts = unzipSync(readFileSync(saved));
  for (const [name, bytes] of Object.entries(original)) if (name !== 'word/document.xml') expect(Buffer.from(parts[name]).equals(Buffer.from(bytes)), name).toBe(true);
  const xml = strFromU8(parts['word/document.xml']);
  expect(xml).toContain('w:ascii="Oswald"'); expect(xml).toContain('w:hAnsi="Oswald"');
  expect(xml).toContain('w:eastAsia="Noto Sans"'); expect(xml).toContain('w:cs="Noto Sans"');
  await reopenDocx(page, input(page), saved, await input(page).inputValue()); await select(page, 'Choose this font éΩ');
  await expect(button(page, 'Latin font family')).toHaveText('Oswald');
  await button(page, 'Latin font family').click(); await expect(picker.getByRole('button', { name: 'Oswald Recent' })).toBeVisible();
  await picker.screenshot({ path: info.outputPath('font-picker.png'), animations: 'disabled' });
});

test('outline stays open after navigation, tracks the current heading and updates as headings change', async ({ page }, info) => {
  await blank(page); await showAllTools(page); await input(page).fill('First section\nBody text\nSecond section');
  await select(page, 'First section'); await page.getByRole('combobox', { name: 'Paragraph style' }).selectOption('Heading1');
  await select(page, 'Second section'); await page.getByRole('combobox', { name: 'Paragraph style' }).selectOption('Heading2');
  await (await onTab(page, 'view')).locator('.ribbon-card').getByRole('button', { name: 'Navigation Pane', exact: true }).click();
  const outline = page.getByRole('complementary', { name: 'Navigation' }), headings = outline.getByRole('tree', { name: 'Headings' });
  await headings.getByRole('treeitem', { name: /^Level 1: First/ }).click();
  await expect(outline).toBeVisible(); await expect(headings.getByRole('treeitem', { name: /^Level 1: First/ })).toHaveAttribute('aria-current', 'location');
  await input(page).press('ControlOrMeta+Home'); await page.keyboard.insertText('Updated ');
  await expect(headings.getByRole('treeitem', { name: /Updated First/ })).toBeVisible();
  await select(page, 'Body text'); await expect(headings.getByRole('treeitem', { name: /Updated First/ })).toHaveAttribute('aria-current', 'location');
  await select(page, 'Second section'); await page.getByRole('combobox', { name: 'Paragraph style' }).selectOption('Normal');
  await expect(headings.getByRole('treeitem')).toHaveCount(1);
  await page.screenshot({ path: info.outputPath('persistent-outline.png'), animations: 'disabled' });
});

test('inspector follows text, table and image selection without adding toolbar rows', async ({ page }, info) => {
  await blank(page); await input(page).fill('Text before table');
  const before = await page.locator('.ed-ribbon').boundingBox(); await inspect(page);
  const inspector = page.getByRole('complementary', { name: 'Formatting Pane' });
  await expect(inspector.getByRole('heading', { name: 'Paragraph formatting' })).toBeVisible();
  await expect(inspector.getByRole('heading', { name: 'Table', exact: true })).toBeHidden();
  await input(page).press('ControlOrMeta+End'); await input(page).press('Enter'); await onTab(page, 'insert'); await button(page, 'Insert table').click();
  await page.getByRole('menuitem', { name: '2 columns, 2 rows' }).click();
  await expect(inspector.getByRole('heading', { name: 'Table formatting' })).toBeVisible();
  await select(page, 'Text before table'); await expect(inspector.getByRole('heading', { name: 'Paragraph formatting' })).toBeVisible();
  const png = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = c.height = 48; const ctx = c.getContext('2d'); ctx.fillStyle = '#1267B0'; ctx.fillRect(0, 0, 48, 48); return c.toDataURL('image/png').split(',')[1]; });
  await input(page).press('ArrowRight');
  await page.getByLabel('Insert image file').setInputFiles({ name: 'blue-square.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  // Picture settings live on the Picture Format tab that the selection brings up; the pane keeps the page tools.
  await expect(inspector.getByRole('heading', { name: 'Formatting', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Picture Format' })).toHaveAttribute('aria-selected', 'true');
  await expect(button(page, 'Image properties')).toBeEnabled();
  await expect(inspector.getByRole('heading', { name: 'Paragraph', exact: true })).toBeHidden();
  const after = await page.locator('.ed-ribbon').boundingBox(); expect(after.height).toBe(before.height);
  await page.screenshot({ path: info.outputPath('contextual-inspector.png'), animations: 'disabled' });
});

test('mobile fits the page, keeps core touch targets visible and exposes secondary tools in a sheet', async ({ browser }, info) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 750 }, isMobile: true, hasTouch: true, colorScheme: 'dark' });
  const page = await context.newPage();
  try {
    await blank(page); await expect(page.getByRole('combobox', { name: 'Zoom', exact: true })).toHaveValue('fit');
    await expect.poll(() => page.locator('.canvas-host').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    for (const name of ['Bold', 'Italic', 'Underline', 'Text color', 'Text highlight', 'Formatting Pane']) {
      // The ribbon is one row that scrolls sideways at phone width (editor-chrome.spec.js); each target scrolls into view.
      const control = button(page, name); await control.scrollIntoViewIfNeeded(); await expect(control).toBeInViewport(); const bounds = await control.boundingBox(); expect(bounds.width).toBeGreaterThanOrEqual(44); expect(bounds.height).toBeGreaterThanOrEqual(44);
    }
    await input(page).fill(Array.from({ length: 16 }, (_, i) => `Writing line ${i + 1}`).join('\n'));
    await button(page, 'Formatting Pane').tap(); const inspector = page.getByRole('complementary', { name: 'Formatting Pane' });
    const bounds = await inspector.boundingBox(); expect(bounds.y).toBeGreaterThan(200); expect(bounds.height).toBeLessThanOrEqual(450);
    await expect.poll(() => input(page).evaluate(el => el.getBoundingClientRect().bottom <= el.closest('.canvas-host').getBoundingClientRect().bottom + 1)).toBe(true);
    await expect(button(page, 'Latin font family')).toBeVisible(); await page.screenshot({ path: info.outputPath('mobile-sheet.png'), animations: 'disabled' });
    await button(page, 'Close Formatting Pane').tap(); await page.setViewportSize({ width: 320, height: 680 });
    await expect.poll(() => page.locator('.canvas-host').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.getByRole('combobox', { name: 'Zoom', exact: true }).selectOption('1');
    await page.setViewportSize({ width: 390, height: 750 }); await expect(page.getByRole('combobox', { name: 'Zoom', exact: true })).toHaveValue('1');
    await page.getByRole('combobox', { name: 'Zoom', exact: true }).selectOption('fit');
    await page.screenshot({ path: info.outputPath('mobile-fit-width.png'), animations: 'disabled' });
  } finally { await context.close(); }
});
