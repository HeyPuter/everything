import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { onTab, downloadDocx } from './helpers/editor-tools.js';

// An equation of brackets nested 1,500 deep: generated, not typed. Every reader that walks the equation
// recursively (its display text, the preview, Edit Equation) used to exhaust the stack, so the whole
// document failed to open with "Maximum call stack size exceeded".
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main', M = 'http://schemas.openxmlformats.org/officeDocument/2006/math';
const DEPTH = 1500;
const equation = `<m:oMath>${'<m:d><m:e>'.repeat(DEPTH)}<m:r><m:t>x</m:t></m:r>${'</m:e></m:d>'.repeat(DEPTH)}</m:oMath>`;
const docx = () => zipSync(Object.fromEntries(Object.entries({
  '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  'word/_rels/document.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>',
  'word/document.xml': `<w:document xmlns:w="${W}" xmlns:m="${M}"><w:body><w:p><w:r><w:t>Before</w:t></w:r></w:p><w:p>${equation}</w:p><w:p><w:r><w:t>After</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`,
}).map(([name, xml]) => [name, strToU8(xml)])));

test('a document with an equation nested far too deeply opens, edits and saves it unchanged', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/playground.html');
  const input = page.getByRole('textbox', { name: 'Document text' });
  await expect(input).toBeVisible();
  await page.getByLabel('Open DOCX file').setInputFiles({ name: 'deep-equation.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from(docx()) });
  await expect(input).toHaveValue('Before\n￼\nAfter');
  await expect(page.locator('#playground-error')).toBeEmpty();
  await expect(input).toHaveJSProperty('readOnly', false);

  // Edit Equation reads the equation into its input box, its characters kept past the depth that is
  // read structurally, and previews it.
  await input.focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Shift+ArrowRight');
  await expect(input).toHaveJSProperty('selectionStart', 7);
  await expect(input).toHaveJSProperty('selectionEnd', 8);
  await onTab(page, 'insert');
  await page.getByRole('button', { name: 'Equation gallery' }).click();
  await page.getByRole('menuitem', { name: 'Edit Equation…' }).click();
  const edit = page.getByRole('dialog', { name: 'Edit Equation' });
  await expect(edit.getByRole('textbox', { name: 'Equation in linear format' })).toHaveValue(/^\(+x\)+$/);
  await expect(edit.locator('.insert-equation-preview math')).toHaveCount(1);
  await edit.getByRole('button', { name: 'Cancel' }).click();
  await expect(edit).toBeHidden();

  // Typing elsewhere leaves the equation's markup exactly as it was.
  await input.focus();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Home');
  await page.keyboard.type('Text ');
  const download = page.waitForEvent('download');
  await downloadDocx(page);
  const saved = strFromU8(unzipSync(readFileSync(await (await download).path()))['word/document.xml']);
  expect(saved).toContain('Text Before');
  expect(saved.split('<m:d>').length - 1).toBe(DEPTH);
  expect(saved).toContain(`${'<m:d><m:e>'.repeat(DEPTH)}<m:r><m:t>x</m:t></m:r>${'</m:e></m:d>'.repeat(DEPTH)}`);
  expect(errors).toEqual([]);
});
