import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { onTab, downloadDocx } from './helpers/editor-tools.js';

// A number field's arrows step by a convenient amount, but Word takes any amount in range, and a document's own
// amounts need not fall on those steps. Fields that used the step as a constraint refused them.
async function start(page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/playground.html');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Document text' });
  await input.fill('Shapes and letters sit beside this paragraph of text. '.repeat(4));
  await input.press('ControlOrMeta+Home');
  return input;
}
async function insertShape(page) {
  await onTab(page, 'insert');
  await page.locator('#ribbon-panel-insert').getByRole('button', { name: 'Shapes', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Rectangle', exact: true }).click();
  const box = await page.locator('canvas.canvas-page').first().boundingBox();
  await page.mouse.move(box.x + 420, box.y + 380); await page.mouse.down(); await page.mouse.move(box.x + 540, box.y + 450, { steps: 4 }); await page.mouse.up();
  await onTab(page, 'shapeFormat');
  return page.locator('#ribbon-panel-shapeFormat');
}
async function documentXml(page, info) {
  const download = page.waitForEvent('download');
  await downloadDocx(page);
  const path = info.outputPath('saved.docx');
  await (await download).saveAs(path);
  return strFromU8(unzipSync(readFileSync(path))['word/document.xml']);
}

test('the Format pane takes a 0.6 pt line, between its quarter-point arrow steps', async ({ page }, info) => {
  await start(page);
  const ribbon = await insertShape(page);
  await ribbon.getByRole('button', { name: 'Format Shape', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Format pane' });
  const width = pane.getByRole('spinbutton', { name: 'Width' });
  await width.fill('0.6');
  await width.press('Enter');
  // 0.6 pt is 7620 EMU (ECMA-376 §20.1.2.2.24 a:ln w).
  await expect.poll(() => documentXml(page, info)).toMatch(/<a:ln w="7620"/);
  // Out of range is still refused.
  await pane.getByRole('spinbutton', { name: 'Width' }).fill('2000');
  await pane.getByRole('spinbutton', { name: 'Width' }).press('Enter');
  expect(await documentXml(page, info)).toMatch(/<a:ln w="7620"/);
});
