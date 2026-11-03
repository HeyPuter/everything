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

test('Grid Settings takes its own eighth-of-an-inch spacing', async ({ page }) => {
  await start(page);
  const ribbon = await insertShape(page);
  await ribbon.getByRole('button', { name: 'Align', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Grid Settings…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Grid Settings' });
  // The spacing starts at 0.125 in; OK used to refuse it, between the hundredths the arrows step by.
  await expect(dialog.getByLabel('Grid spacing (in)')).toHaveValue('0.125');
  await dialog.getByLabel('Snap objects to the grid while moving them').check();
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect(dialog).toBeHidden();
  await ribbon.getByRole('button', { name: 'Align', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Grid Settings…' }).click();
  await expect(dialog.getByLabel('Snap objects to the grid while moving them')).toBeChecked();
  // Out of range is still refused.
  await dialog.getByLabel('Grid spacing (in)').fill('3');
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect(dialog).toBeVisible();
});

test('Drop Cap takes Word\'s 0.1 in (7.2 pt) distance from text', async ({ page }) => {
  const input = await start(page);
  await onTab(page, 'insert');
  const ribbon = page.locator('#ribbon-panel-insert');
  await ribbon.getByRole('button', { name: 'Drop Cap', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'Dropped' }).click();
  await expect.poll(() => input.inputValue()).toMatch(/^S\nhapes/);
  // Word's Drop Cap dialog steps the distance by tenths of an inch: 0.1 in is hSpace="144" (§17.3.1.11), 7.2 pt here.
  const options = async () => {
    await ribbon.getByRole('button', { name: 'Drop Cap', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Drop Cap Options…' }).click();
    return page.getByRole('dialog', { name: 'Drop Cap' });
  };
  let cap = await options();
  await cap.getByRole('spinbutton', { name: 'Distance from text (pt)' }).fill('7.2');
  await cap.getByRole('button', { name: 'OK' }).click();
  await expect(cap).toBeHidden();
  // Opened again, the document's own distance does not stop another change.
  cap = await options();
  await expect(cap.getByRole('spinbutton', { name: 'Distance from text (pt)' })).toHaveValue('7.2');
  await cap.getByRole('spinbutton', { name: 'Lines to drop' }).fill('2');
  await cap.getByRole('button', { name: 'OK' }).click();
  await expect(cap).toBeHidden();
  cap = await options();
  await expect(cap.getByRole('spinbutton', { name: 'Lines to drop' })).toHaveValue('2');
  await expect(cap.getByRole('spinbutton', { name: 'Distance from text (pt)' })).toHaveValue('7.2');
  // Out of range is still refused.
  await cap.getByRole('spinbutton', { name: 'Distance from text (pt)' }).fill('80');
  await cap.getByRole('button', { name: 'OK' }).click();
  await expect(cap).toBeVisible();
});

test('the ribbon\'s shape and table size boxes take 1.125 in, between their hundredth steps', async ({ page }, info) => {
  const input = await start(page);
  const ribbon = await insertShape(page);
  const height = ribbon.getByRole('spinbutton', { name: 'Shape height (in)' });
  await height.fill('1.125');
  await height.press('Enter');
  // 1⅛ in is 1028700 EMU (§20.4.2.7 wp:extent).
  await expect.poll(async () => (await documentXml(page, info)).match(/<wp:extent [^>]*>/)[0]).toMatch(/cy="1028700"/);
  // A table's row height and column width (twips: 1⅛ in is 1620).
  await input.press('ControlOrMeta+End');
  await onTab(page, 'insert');
  await page.locator('#ribbon-panel-insert').getByRole('button', { name: 'Insert table', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Insert Table…' }).click();
  await page.getByRole('dialog', { name: 'Insert Table' }).getByRole('button', { name: 'OK' }).click();
  const layout = await onTab(page, 'tableLayout');
  const width = layout.getByRole('spinbutton', { name: 'Width (in)', exact: true });
  await width.fill('1.125'); await width.press('Enter');
  await expect.poll(async () => (await documentXml(page, info)).match(/<w:gridCol [^>]*>/)?.[0]).toBe('<w:gridCol w:w="1620"/>');
});

test('the Layout dialog takes a 1.125 in width', async ({ page }, info) => {
  await start(page);
  const ribbon = await insertShape(page);
  await ribbon.getByRole('button', { name: 'Size and Position…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Layout' });
  await dialog.getByRole('tab', { name: 'Size' }).click();
  await dialog.getByRole('spinbutton', { name: 'Width (in)' }).fill('1.125');
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(async () => (await documentXml(page, info)).match(/<wp:extent [^>]*>/)[0]).toMatch(/cx="1028700"/);
  // Out of range is still refused, on its tab.
  await ribbon.getByRole('button', { name: 'Size and Position…' }).click();
  await dialog.getByRole('tab', { name: 'Size' }).click();
  await dialog.getByRole('spinbutton', { name: 'Width (in)' }).fill('0');
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect(dialog).toBeVisible();
});

test('Insert Table takes a 1.125 in fixed column width', async ({ page }, info) => {
  await start(page);
  await onTab(page, 'insert');
  await page.locator('#ribbon-panel-insert').getByRole('button', { name: 'Insert table', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Insert Table…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Insert Table' });
  await dialog.getByLabel('Fixed column width (in)').fill('1.125');
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(async () => (await documentXml(page, info)).match(/<w:gridCol [^>]*>/)?.[0]).toBe('<w:gridCol w:w="1620"/>');
  // Out of range is still refused.
  await onTab(page, 'insert');
  await page.locator('#ribbon-panel-insert').getByRole('button', { name: 'Insert table', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Insert Table…' }).click();
  await dialog.getByLabel('Fixed column width (in)').fill('30');
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect(dialog).toBeVisible();
});
