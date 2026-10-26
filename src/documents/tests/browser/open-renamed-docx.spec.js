import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';

// File > Open in the editor names a file it cannot import, but a Word document saved under another name
// (a download kept as .zip, or a file without an extension) still opens, as it does from a .docx name.
test('opens a Word document under another name and names a file that is not one', async ({ page }, info) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/playground.html');
  const input = page.getByRole('textbox', { name: 'Document text' });
  await expect(input).toHaveValue(/^A small beginning/);
  const bytes = readFileSync('public/fixtures/tab-leaders.docx');
  for (const name of ['Report.zip', 'Report']) {
    await page.goto('/playground.html');
    await expect(input).toHaveValue(/^A small beginning/);
    const path = info.outputPath(name); writeFileSync(path, bytes);
    await page.getByLabel('Open DOCX file').setInputFiles(path);
    await expect(input).toHaveValue(/^Tab leaders/);
  }
  const pdf = info.outputPath('Scan.pdf'); writeFileSync(pdf, '%PDF-1.7\n');
  await page.getByLabel('Open DOCX file').setInputFiles(pdf);
  await expect(page.locator('.toast-root')).toContainText('That file cannot be imported');
  await expect(input).toHaveValue(/^Tab leaders/);
  expect(errors).toEqual([]);
});
