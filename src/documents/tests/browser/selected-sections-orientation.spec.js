import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { onTab, downloadDocx } from './helpers/editor-tools.js';

// Layout > Orientation, Size and Margins with a selection that reaches several sections change each of them
// (§17.6.13 pgSz, §17.6.11 pgMar), as Word's "Selected sections"; Orientation turns each section's own page.
test('Orientation turns every selected section, each keeping its own paper and margins', async ({ page }, info) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/playground.html');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Document text' });
  await input.fill('Section one.');
  await onTab(page, 'layout');
  const ribbon = page.locator('#ribbon-panel-layout');
  await ribbon.getByRole('button', { name: 'Breaks', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Next Page/ }).click();
  await page.keyboard.insertText('Section two.');
  // The second section gets A4 paper and narrow margins of its own.
  await ribbon.getByRole('button', { name: 'Size', exact: true }).click();
  await page.locator('[role=menu] [role^=menuitem]').filter({ hasText: /^A4/ }).click();
  await ribbon.getByRole('button', { name: 'Margins', exact: true }).click();
  await page.locator('[role=menu] [role^=menuitem]').filter({ hasText: /^Narrow/ }).click();
  await expect.poll(() => page.locator('canvas.canvas-page').count()).toBe(2);
  await input.focus();
  await page.keyboard.press('ControlOrMeta+a');
  await ribbon.getByRole('button', { name: 'Orientation', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'Landscape' }).click();
  // Both pages are wider than tall now: Letter and A4 turned.
  await expect.poll(() => page.locator('canvas.canvas-page').evaluateAll(pages => pages.map(c => c.width > c.height))).toEqual([true, true]);
  const path = info.outputPath('turned.docx');
  const download = page.waitForEvent('download'); await downloadDocx(page); await (await download).saveAs(path);
  const body = strFromU8(unzipSync(new Uint8Array(readFileSync(path)))['word/document.xml']);
  const sections = body.match(/<w:sectPr\b.*?<\/w:sectPr>/g);
  expect(sections).toHaveLength(2);
  expect(sections[0]).toMatch(/<w:pgSz w:w="15840" w:h="12240" w:orient="landscape"\/>/);
  expect(sections[0]).toMatch(/w:top="1440"/);
  expect(sections[1]).toMatch(/<w:pgSz w:w="16838" w:h="11906" w:orient="landscape"\/>/);
  expect(sections[1]).toMatch(/w:top="720"/);
  // One undo step puts both back.
  await page.getByRole('button', { name: 'Undo', exact: true }).first().click();
  await expect.poll(() => page.locator('canvas.canvas-page').evaluateAll(pages => pages.map(c => c.width > c.height))).toEqual([false, false]);
  expect(errors).toEqual([]);
});
