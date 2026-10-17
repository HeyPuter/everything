import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { unzipSync } from 'fflate';

for (const fixture of ['theme-gray-tints', 'theme-gray-boundaries']) test(`paints native gray modifiers through editing and reopening: ${fixture}`, async ({ page }, info) => {
  test.setTimeout(120000); // Two imports and exports of the 512-row native sweep.
  const folder = `tests/fixtures/${fixture}/`, source = folder + 'control.docx';
  const original = unzipSync(readFileSync(source));
  const colors = JSON.parse(readFileSync(folder + 'reference.json')).colors;
  await page.goto('/playground.html');
  await page.getByLabel('Open DOCX file').setInputFiles(source);
  const input = page.getByRole('textbox', { name: 'Document text' });
  await expect(input).toHaveValue(/^C000/, { timeout: 60000 });
  await expect(input).toHaveJSProperty('readOnly', false);
  const check = async () => {
    // Fixed rows 20pt high under a 36pt top margin; each label's page is the native page recorded in the
    // reference (36 exact rows fill the 720pt body, as in the native PDF).
    const rows = colors.map(c => [c.page, colors.filter(o => o.page === c.page).indexOf(c)]);
    await expect(page.locator('canvas.canvas-page')).toHaveCount(Math.max(...colors.map(c => c.page)) + 1);
    await expect.poll(() => page.locator('canvas.canvas-page').evaluateAll((pages, rows) => rows.map(([p, k]) =>
      [...pages[p].getContext('2d').getImageData(288, Math.round((46 + 20 * k) * 4 / 3), 1, 1).data].slice(0, 3)), rows), { timeout: 30000 }).toEqual(colors.map(c => c.rgb));
  };
  await check();
  await input.focus(); await input.press('ControlOrMeta+Home'); await page.keyboard.insertText('Test ');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download .docx', exact: true }).click();
  const path = info.outputPath('edited.docx'); await (await download).saveAs(path);
  const edited = unzipSync(readFileSync(path));
  expect(Object.keys(edited).sort()).toEqual(Object.keys(original).sort());
  for (const name of Object.keys(original)) if (name !== 'word/document.xml') expect(edited[name], name).toEqual(original[name]);
  page.once('dialog', d => d.accept());
  await page.getByLabel('Open DOCX file').setInputFiles(path);
  await expect(input).toHaveValue(/^Test C000/, { timeout: 60000 });
  await check();
});
