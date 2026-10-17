import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { reopenDocx } from './helpers/reopen-docx.js';
const source = 'tests/fixtures/glossary-bookmarks/control.docx';
const sameParts = (a, b) => { expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort()); for (const [n, v] of Object.entries(b)) expect(Buffer.from(a[n]).equals(Buffer.from(v)), n).toBe(true); };
test('restores inline and block glossary bookmarks, preserves undo and replaces restored prompts', async ({ page }, info) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/playground.html'); await page.getByLabel('Open DOCX file').setInputFiles(source);
  const input = page.getByRole('textbox', { name: 'Document text' });
  await expect(input).toHaveValue(/^Outside bookmark\nwhole: Existing value/); await expect(input).toBeEditable();
  const original = await input.inputValue(), parts = unzipSync(readFileSync(source));
  const save = async name => { const pending = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download .docx', exact: true }).click(); const path = info.outputPath(name + '.docx'); await (await pending).saveAs(path); return path; };
  const select = async text => input.evaluate((el, text) => { const at = el.value.indexOf(text); if (at < 0) throw new Error('Missing selection: ' + text); el.focus(); el.setSelectionRange(at, at + text.length); el.dispatchEvent(new Event('select', { bubbles: true })); }, text);
  sameParts(unzipSync(readFileSync(await save('noedit'))), parts);
  // Deleting a selected inline value leaves an empty control; its prompt is restored, as a separate
  // undo step, when the caret leaves it (docs/conformance.md, outside deletion into inline controls).
  for (let i = 0; i < 4; i++) { await select('Existing value'); await input.press('Backspace'); await input.press('ArrowRight'); }
  await select('Existing value'); await input.press('Backspace');
  const restoredText = original.replaceAll('Existing value', 'Enter name').replace(/Enter name$/, 'First line\nSecond line');
  await expect(input).toHaveValue(restoredText); await expect(page.locator('canvas.canvas-page')).toHaveCount(1);
  const restored = await save('restored');
  const names = xml => page.evaluate(xml => { const w = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main', d = new DOMParser().parseFromString(xml, 'application/xml'); return [...d.getElementsByTagNameNS(w, 'bookmarkStart')].map(n => n.getAttributeNS(w, 'name')).sort(); }, xml);
  expect(await names(strFromU8(unzipSync(readFileSync(restored))['word/document.xml']))).toEqual(['PromptAcross', 'PromptInner', 'PromptPoint', 'PromptSecond', 'PromptWhole']);
  for (let i = 0; i < 9; i++) await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(input).toHaveValue(original); sameParts(unzipSync(readFileSync(await save('undo'))), parts);
  await reopenDocx(page, input, restored, restoredText);
  for (let i = 0; i < 4; i++) { await select('Enter name'); await input.press('X'); }
  await select('First line\nSecond line'); await input.press('X');
  const changed = original.replaceAll('Existing value', 'X'); await expect(input).toHaveValue(changed);
  const edited = await save('edited'), exported = unzipSync(readFileSync(edited));
  expect(await names(strFromU8(exported['word/document.xml']))).toEqual([]);
  for (const [n, b] of Object.entries(parts)) if (n !== 'word/document.xml') expect(Buffer.from(exported[n]).equals(Buffer.from(b)), n).toBe(true);
  await reopenDocx(page, input, edited, changed); await expect(input).toBeEditable(); expect(errors).toEqual([]);
});
