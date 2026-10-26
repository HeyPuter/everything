import { test, expect } from '@playwright/test';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { readFileSync } from 'node:fs';
import { downloadDocx, onTab, showAllTools } from './helpers/editor-tools.js';
import { reopenDocx } from './helpers/reopen-docx.js';

const input = page => page.getByRole('textbox', { name: 'Document text' });

test('a plain-text file opens as one paragraph per line and saves as a document', async ({ page }, info) => {
  await page.goto('/mock.html#/home');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Import', exact: true }).first().click();
  await (await chooser).setFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Shopping list\r\n\r\nApples\tRed\r\nPears\r\n') });
  const text = 'Shopping list\n\nApples\tRed\nPears';
  await expect(input(page)).toHaveValue(text);
  await expect(page.locator('.editor-error')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Document name' })).toHaveValue('notes');
  expect(await input(page).evaluate(el => [el.selectionStart, el.selectionEnd])).toEqual([0, 0]);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await expect(page.locator('.canvas-save-status')).toHaveText('Saved to Puter', { timeout: 10000 });
  await input(page).press('ControlOrMeta+End'); await page.keyboard.type(' and plums');
  const download = page.waitForEvent('download'); await downloadDocx(page);
  const path = info.outputPath('notes.docx'); await (await download).saveAs(path);
  const xml = strFromU8(unzipSync(readFileSync(path))['word/document.xml']);
  expect(xml.match(/<w:p[ >]/g)).toHaveLength(4);
  expect(xml).toContain('<w:tab/>');
  await reopenDocx(page, input(page), path, `${text} and plums`);
});

const style = page => page.getByRole('combobox', { name: 'Paragraph style', exact: true });
async function state(page, text) {
  await input(page).evaluate((el, text) => { const at = el.value.indexOf(text); el.focus(); el.setSelectionRange(at, at + text.length); el.dispatchEvent(new Event('select')); }, text);
  await onTab(page, 'home');
  const pressed = name => page.getByRole('button', { name, exact: true }).getAttribute('aria-pressed');
  return { style: await style(page).inputValue(), bold: await pressed('Bold'), italic: await pressed('Italic'), bullets: await pressed('Bulleted list'), numbers: await pressed('Numbered list') };
}
async function importFile(page, name, mimeType, source) {
  await page.goto('/mock.html#/new');
  await expect((await onTab(page, 'home')).getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await page.locator('input[type=file][aria-label="Open DOCX file"]').setInputFiles({ name, mimeType, buffer: Buffer.from(source) });
  await expect(page.getByRole('textbox', { name: 'Document name' })).toHaveValue(name.replace(/\.\w+$/, ''));
  await showAllTools(page); // the Paragraph style list is in the Formatting Pane
}

test('a Markdown file opens with its headings, lists, emphasis and table text', async ({ page }, info) => {
  await importFile(page, 'notes.md', 'text/markdown', '# Release notes\n\nVersion **2.1** adds *faster* exports and [a guide](https://example.com/guide).\n\n## Changes\n\n- Faster save\n- New templates\n  - Letter\n\n1. Install\n2. Restart\n\n| Name | Value |\n| --- | --- |\n| Size | 12 |\n\n```\nline 1\nline 2\n```\n\n> Quoted.\n\n<script>alert(1)</script>\n');
  const text = 'Release notes\nVersion 2.1 adds faster exports and a guide.\nChanges\nFaster save\nNew templates\nLetter\nInstall\nRestart\nName\tValue\nSize\t12\nline 1\nline 2\nQuoted.';
  await expect(input(page)).toHaveValue(text);
  await expect(page.locator('.editor-error')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  expect(await state(page, 'Release notes')).toMatchObject({ style: 'Heading1' });
  expect(await state(page, 'Changes')).toMatchObject({ style: 'Heading2' });
  expect(await state(page, '2.1')).toMatchObject({ style: 'Normal', bold: 'true' });
  expect(await state(page, 'faster')).toMatchObject({ italic: 'true', bold: 'false' });
  expect(await state(page, 'Letter')).toMatchObject({ bullets: 'true' });
  expect(await state(page, 'Restart')).toMatchObject({ numbers: 'true' });
  await state(page, 'a guide'); await expect((await onTab(page, 'insert')).getByRole('button', { name: 'Insert or edit link', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.canvas-save-status')).toHaveText('Saved to Puter', { timeout: 10000 });
  const download = page.waitForEvent('download'); await downloadDocx(page);
  const path = info.outputPath('notes.docx'); await (await download).saveAs(path);
  const xml = strFromU8(unzipSync(readFileSync(path))['word/document.xml']);
  expect(xml).toContain('<w:pStyle w:val="Heading1"/>'); expect(xml).toContain('<w:numPr>'); expect(xml).not.toContain('alert');
  await reopenDocx(page, input(page), path, text);
});

test('an HTML file opens with its structure', async ({ page }) => {
  await importFile(page, 'page.html', 'text/html', '<!doctype html><html><head><title>T</title><style>p{color:red}</style></head><body><h2>Section</h2><p>Some <strong>strong</strong> text.</p><ol><li>One</li><li>Two</li></ol></body></html>');
  await expect(input(page)).toHaveValue('Section\nSome strong text.\nOne\nTwo');
  expect(await state(page, 'Section')).toMatchObject({ style: 'Heading2' });
  expect(await state(page, 'strong')).toMatchObject({ bold: 'true' });
  expect(await state(page, 'Two')).toMatchObject({ numbers: 'true' });
});

test('an HTML file keeps the bold, italics and alignment its style sheet gives (as Google Docs exports write them)', async ({ page }) => {
  await importFile(page, 'plan.html', 'text/html', '<html><head><style>.c1{color:#000000;font-weight:400}.c3{font-weight:700}.c4{font-style:italic}.c5{text-align:center}</style></head><body><p class="c5"><span class="c1">Centered</span></p><p><span class="c1">We will </span><span class="c1 c3">ship</span><span class="c1"> the </span><span class="c4 c1">first</span><span class="c1"> version, </span><span class="c3" style="font-weight:400">not this</span>.</p></body></html>');
  await expect(input(page)).toHaveValue('Centered\nWe will ship the first version, not this.');
  expect(await state(page, 'ship')).toMatchObject({ bold: 'true', italic: 'false' });
  expect(await state(page, 'first')).toMatchObject({ bold: 'false', italic: 'true' });
  // A rule never overrides the element's own style attribute.
  expect(await state(page, 'not this')).toMatchObject({ bold: 'false' });
  await state(page, 'Centered');
  await expect(page.getByRole('button', { name: 'Align center', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('a Word template opens for editing and saves as a document', async ({ page }, info) => {
  // A .dotx differs from a .docx in its main part's content type.
  const parts = unzipSync(readFileSync(new URL('../../public/fixtures/two-paragraphs.docx', import.meta.url)));
  parts['[Content_Types].xml'] = strToU8(strFromU8(parts['[Content_Types].xml']).replace('wordprocessingml.document.main+xml', 'wordprocessingml.template.main+xml'));
  await page.goto('/mock.html#/home');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Import', exact: true }).first().click();
  await (await chooser).setFiles({ name: 'Letter.dotx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.template', buffer: Buffer.from(zipSync(parts)) });
  await expect(page.getByRole('textbox', { name: 'Document name' })).toHaveValue('Letter');
  await expect(page.locator('.editor-error')).toHaveCount(0);
  const original = await input(page).inputValue();
  expect(original.length).toBeGreaterThan(0);
  await input(page).press('ControlOrMeta+Home'); await page.keyboard.type('Dear Rosa, ');
  await expect(input(page)).toHaveValue(`Dear Rosa, ${original}`);
  const download = page.waitForEvent('download'); await downloadDocx(page);
  const path = info.outputPath('letter.docx'); await (await download).saveAs(path);
  const types = strFromU8(unzipSync(readFileSync(path))['[Content_Types].xml']);
  expect(types).toContain('wordprocessingml.document.main+xml');
  expect(types).not.toContain('template.main+xml');
  await reopenDocx(page, input(page), path, `Dear Rosa, ${original}`);
});

test('a text file too long to open shows why, with ways forward', async ({ page }) => {
  await page.goto('/mock.html#/home');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Import', exact: true }).first().click();
  // Past the editor's page limit: the import fails once the editor is already showing.
  const lines = Array.from({ length: 9000 }, (_, i) => `Line ${i + 1}`).join('\n');
  await (await chooser).setFiles({ name: 'long.txt', mimeType: 'text/plain', buffer: Buffer.from(lines) });
  const message = page.locator('.canvas-message.editor-error');
  await expect(message).toBeVisible({ timeout: 15000 });
  await expect(message).toContainText('up to 200 pages');
  await expect(message.getByRole('button', { name: 'Back to documents', exact: true })).toBeInViewport();
});

test('a Markdown file or web page says how many of its pictures were left out', async ({ page }) => {
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  await importFile(page, 'pictures.md', 'text/markdown', `# Trip\n\n![Beach](${png}) and ![Hill](https://example.com/hill.jpg)\n`);
  await expect(input(page)).toHaveValue('Trip\nand');
  await expect(page.locator('[data-omitted-pictures]')).toHaveText('The 2 pictures in this file were not imported: pictures in Markdown and web pages are left out. Add them with Insert > Pictures.');
  await importFile(page, 'page.html', 'text/html', `<p>One <img src="${png}" alt="dot"> picture</p>`);
  await expect(input(page)).toHaveValue('One picture');
  await expect(page.locator('[data-omitted-pictures]')).toHaveText(/^The picture in this file was not imported/);
  await importFile(page, 'plain.md', 'text/markdown', '# No pictures\n');
  await expect(input(page)).toHaveValue('No pictures');
  await expect(page.locator('[data-omitted-pictures]')).toHaveCount(0);
});
