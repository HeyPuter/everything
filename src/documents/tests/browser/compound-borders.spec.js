import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { unzipSync } from 'fflate';
import { showAllTools, onTab } from './helpers/editor-tools.js';
import { reopenDocx } from './helpers/reopen-docx.js';

for (const name of ['controls', 'edges', 'frame']) test(`renders and edits compound border ${name} without losing source declarations`, async ({ page }, info) => {
 const errors = []; page.on('pageerror', e => errors.push(e.message));
 await page.goto('/playground.html'); await showAllTools(page);
 const source = `public/fixtures/compound-border-${name}.docx`;
 await page.getByLabel('Open DOCX file').setInputFiles(source);
 const input = page.getByRole('textbox', { name: 'Document text' });
 await expect(input).toHaveValue(/^paragraph: thinThickLargeGap/); await expect(input).toBeEditable();
 const original = await input.inputValue();
 const download = async suffix => { const pending = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download .docx', exact: true }).click(); const path = info.outputPath(`${name}-${suffix}.docx`); await (await pending).saveAs(path); return path; };
 const parts = unzipSync(readFileSync(source));
 const same = path => { const actual = unzipSync(readFileSync(path)); expect(Object.keys(actual).sort()).toEqual(Object.keys(parts).sort()); for (const [key, bytes] of Object.entries(parts)) expect(Buffer.from(actual[key]).equals(Buffer.from(bytes)), key).toBe(true); };
 same(await download('original'));
 writeFileSync(info.outputPath(`${name}.png`), Buffer.from(await page.locator('canvas.canvas-page').first().evaluate(c => c.toDataURL().split(',')[1]), 'base64'));
 for (const cell of [false, true]) {
  await input.evaluate((el, cell) => { const at = cell ? el.value.lastIndexOf('Border control') : el.value.indexOf('Border control'); el.focus(); el.setSelectionRange(at, at + 14); el.dispatchEvent(new Event('select', { bubbles:true })); }, cell);
  const title = cell ? 'Cell borders' : 'Paragraph borders', prefix = cell ? 'Top cell border' : 'Top border';
  await (await onTab(page, cell ? 'tableDesign' : 'home')).getByRole('button', { name: title, exact:true }).click();
  const dialog = page.getByRole('dialog', { name:title, exact:true });
  await expect(dialog.getByRole('combobox', { name:`${prefix} style`, exact:true })).toHaveValue('thinThickLargeGap');
  await dialog.getByRole('spinbutton', { name:`${prefix} width (pt)`, exact:true }).fill('1.625');
  await dialog.getByRole('textbox', { name:`${prefix} color`, exact:true }).fill('CC3300');
  await dialog.getByRole('button', { name:'Apply', exact:true }).click(); await expect(dialog).toHaveCount(0);
  const saved = await download(cell ? 'cell' : 'paragraph');
  await page.getByRole('button', { name:'Undo', exact:true }).click(); same(await download(cell ? 'cell-undo' : 'paragraph-undo'));
  await reopenDocx(page,input,saved,original);
  expect(new TextDecoder().decode(unzipSync(readFileSync(saved))['word/document.xml'])).toContain('CC3300');
  await page.getByLabel('Open DOCX file').setInputFiles(source); await expect(input).toHaveValue(original);
 }
 expect(errors).toEqual([]);
});
