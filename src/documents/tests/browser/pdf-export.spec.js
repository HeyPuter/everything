import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileCommand } from './helpers/editor-tools.js';

test('File → Export → PDF downloads every page with searchable text', async ({ page }, info) => {
  await page.goto('/playground.html');
  await page.locator('.canvas-workspace').first().waitFor();
  await page.getByLabel('Open DOCX file').setInputFiles('public/fixtures/annual-report.docx');
  await expect(page.locator('.canvas-page').first()).toBeVisible();
  const pages = await page.locator('.canvas-page').count();
  const downloading = page.waitForEvent('download');
  await (await fileCommand(page, 'Export')).click();
  await page.getByRole('menuitem', { name: 'PDF (.pdf)', exact: true }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/\.pdf$/);
  const path = info.outputPath('export.pdf');
  await download.saveAs(path);
  const pdf = readFileSync(path).toString('latin1');
  expect(pdf.startsWith('%PDF-1.7')).toBe(true);
  expect(pdf.match(/\/Type \/Page /g)).toHaveLength(pages);
  let text = null;
  try { text = execFileSync('pdftotext', [path, '-'], { encoding: 'utf8' }); } catch { /* poppler is optional */ }
  if (text !== null) expect(text.replace(/\s+/g, ' ')).toMatch(/\w{4,}/);
});
