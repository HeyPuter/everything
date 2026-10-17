import { test, expect } from '@playwright/test';
import { unzipSync, strFromU8 } from 'fflate';
import { readFileSync } from 'node:fs';
import { downloadDocx, showAllTools } from './helpers/editor-tools.js';
import { reopenDocx } from './helpers/reopen-docx.js';

const input = page => page.getByRole('textbox', { name: 'Document text' });
// The Paragraph style field is in the Formatting Pane, which the app keeps closed by default.
const style = page => page.getByRole('combobox', { name: 'Paragraph style', exact: true });
async function place(page, text) {
  await input(page).evaluate((el, text) => { const at = el.value.indexOf(text); el.focus(); el.setSelectionRange(at, at); el.dispatchEvent(new Event('select')); }, text);
}

test('every built-in template opens as an editable document from the home screen', async ({ page }) => {
  for (const [name, first, heading] of [['Letter', '[Your name]', null], ['Meeting notes', 'Meeting notes', 'Attendees'], ['Report', '[Report title]', 'Summary'], ['Résumé', '[Your name]', 'Experience'], ['Essay', '[Essay title]', 'References']]) {
    await page.goto('/mock.html#/home');
    await page.getByRole('button', { name: 'Templates', exact: true }).click();
    await page.getByRole('menuitem', { name: new RegExp(`^${name}`) }).click();
    await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
    await expect(page.locator('.editor-error')).toHaveCount(0);
    await expect(input(page)).toHaveValue(new RegExp(`^${first.replace(/[[\]]/g, '\\$&')}\\n`));
    expect(await input(page).evaluate(el => [el.selectionStart, el.selectionEnd])).toEqual([0, 0]);
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
    await expect(page.getByRole('textbox', { name: 'Document name' })).toHaveValue(name);
    if (heading) { await showAllTools(page); await place(page, heading); await expect(style(page)).toHaveValue(/^Heading[12]$/); }
  }
});

test('a template keeps its styles, lists and table through editing, export and reopen', async ({ page }, info) => {
  await page.goto('/mock.html#/new/meeting');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled(); await showAllTools(page);
  await place(page, 'Meeting notes'); await expect(style(page)).toHaveValue('Title');
  await place(page, 'Attendees'); await expect(style(page)).toHaveValue('Heading2');
  await place(page, '[First topic]'); await expect(page.getByRole('button', { name: 'Numbered list', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await place(page, '[Name]'); await expect(page.getByRole('button', { name: 'Bulleted list', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await place(page, 'Owner'); await expect(page.locator('select[aria-label="Table actions"]')).toBeEnabled();
  await place(page, '[Decisions');
  await page.keyboard.insertText('Agreed. ');
  await expect(page.locator('.canvas-save-status')).toHaveText('Saved to Puter', { timeout: 10000 });
  const download = page.waitForEvent('download'); await downloadDocx(page);
  const path = info.outputPath('meeting.docx'); await (await download).saveAs(path);
  const parts = unzipSync(readFileSync(path)), xml = strFromU8(parts['word/document.xml']);
  expect(xml.match(/<w:tbl>/g)).toHaveLength(1);
  expect(xml.match(/<w:numPr>/g)?.length).toBeGreaterThanOrEqual(6);
  for (const id of ['Title', 'Subtitle', 'Heading2']) expect(xml).toContain(`<w:pStyle w:val="${id}"/>`);
  const text = await input(page).inputValue();
  expect(text).toContain('Agreed. [Decisions made and points raised.]');
  await reopenDocx(page, input(page), path, text);
  await place(page, 'Meeting notes'); await expect(style(page)).toHaveValue('Title');
});
