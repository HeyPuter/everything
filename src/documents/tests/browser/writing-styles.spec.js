import { test, expect } from '@playwright/test';
import { unzipSync, strFromU8 } from 'fflate';
import { readFileSync } from 'node:fs';
import { downloadDocx, showAllTools, onTab } from './helpers/editor-tools.js';
import { reopenDocx } from './helpers/reopen-docx.js';

const input = page => page.getByRole('textbox', { name: 'Document text' });
const style = page => page.getByRole('combobox', { name: 'Paragraph style', exact: true });
async function place(page, text) {
  await input(page).evaluate((el, text) => { const at = el.value.indexOf(text); el.focus(); el.setSelectionRange(at, at); el.dispatchEvent(new Event('select')); }, text);
}

test('new documents offer title, subtitle and six heading levels, with working heading shortcuts', async ({ page }, info) => {
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  // The Paragraph style list is part of the optional Formatting Pane; the ribbon shows a style gallery.
  await showAllTools(page);
  await expect(style(page).locator('option:not([disabled])')).toHaveText(['Normal', 'Title', 'Subtitle', 'Heading 1', 'Heading 2', 'Heading 3', 'Heading 4', 'Heading 5', 'Heading 6']);
  const text = 'Report title\nA subtitle\nThird level\nSixth level\nBody text';
  await input(page).fill(text);
  await place(page, 'Report title'); await style(page).selectOption('Title');
  await expect(page.getByRole('spinbutton', { name: 'Font size (pt)' })).toHaveValue('26');
  await place(page, 'A subtitle'); await style(page).selectOption('Subtitle');
  await place(page, 'Third level'); await input(page).press('ControlOrMeta+Alt+3');
  await expect(style(page)).toHaveValue('Heading3');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await place(page, 'Sixth level'); await input(page).press('ControlOrMeta+Alt+6');
  await expect(style(page)).toHaveValue('Heading6');
  await (await onTab(page, 'view')).getByRole('button', { name: 'Navigation Pane', exact: true }).click();
  await expect(page.locator('.canvas-outline-entry')).toHaveCount(2);
  await (await onTab(page, 'view')).getByRole('button', { name: 'Navigation Pane', exact: true }).click();

  const download = page.waitForEvent('download'); await downloadDocx(page);
  const path = info.outputPath('writing-styles.docx'); await (await download).saveAs(path);
  const parts = unzipSync(readFileSync(path)), xml = strFromU8(parts['word/document.xml']), styles = strFromU8(parts['word/styles.xml']);
  for (const id of ['Title', 'Subtitle', 'Heading3', 'Heading6']) {
    expect(xml).toContain(`<w:pStyle w:val="${id}"/>`);
    expect(styles).toContain(`w:styleId="${id}"`);
  }
  await reopenDocx(page, input(page), path, text);
  await place(page, 'Report title'); await expect(style(page)).toHaveValue('Title');
  await place(page, 'Sixth level'); await expect(style(page)).toHaveValue('Heading6');
});
