import { test, expect } from '@playwright/test';
import { onTab, downloadDocx } from './helpers/editor-tools.js';
import { reopenDocx } from './helpers/reopen-docx.js';

const wrapChoice = async (page, name) => {
  await page.locator('.ribbon-card').getByRole('button', { name: 'Wrap Text', exact: true }).click();
  await page.getByRole('menuitemradio', { name, exact: true }).click();
  await expect(page.getByRole('menu')).toHaveCount(0);
};
const checkedWrap = async page => {
  await page.locator('.ribbon-card').getByRole('button', { name: 'Wrap Text', exact: true }).click();
  const name = await page.getByRole('menuitemradio', { checked: true }).first().textContent();
  await page.keyboard.press('Escape');
  return name.trim();
};

test('wraps a new picture square, behind and in line, and keeps it through saving', async ({ page }, info) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/playground.html');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Document text' });
  await input.fill('Words that flow around the picture once it floats. '.repeat(8));
  await input.press('ControlOrMeta+Home');
  await page.getByLabel('Insert image file').setInputFiles('icon.png');
  await expect(page.getByRole('tab', { name: 'Picture Format' })).toHaveAttribute('aria-selected', 'true');
  expect(await checkedWrap(page)).toBe('In Line with Text');
  const lines = () => input.evaluate(() => document.querySelectorAll('canvas.canvas-page').length);
  const pixels = () => page.locator('canvas.canvas-page').first().evaluate(c => c.toDataURL());
  const inline = await pixels();
  await wrapChoice(page, 'Square');
  expect(await checkedWrap(page)).toBe('Square');
  await expect.poll(pixels).not.toBe(inline);
  await wrapChoice(page, 'Behind Text');
  expect(await checkedWrap(page)).toBe('Behind Text');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await input.evaluate(el => { const at = el.value.indexOf('￼'); el.setSelectionRange(at, at + 1); el.dispatchEvent(new Event('select', { bubbles: true })); });
  expect(await checkedWrap(page)).toBe('Square');
  const path = info.outputPath('picture-wrap.docx');
  const download = page.waitForEvent('download'); await downloadDocx(page); await (await download).saveAs(path);
  await reopenDocx(page, input, path, await input.inputValue());
  await input.evaluate(el => { const at = el.value.indexOf('￼'); el.setSelectionRange(at, at + 1); el.dispatchEvent(new Event('select', { bubbles: true })); });
  await onTab(page, 'picture');
  expect(await checkedWrap(page)).toBe('Square');
  await wrapChoice(page, 'In Line with Text');
  expect(await checkedWrap(page)).toBe('In Line with Text');
  expect(await lines()).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test('Picture Format sizes a picture in proportion and rotates and flips it in undoable steps', async ({ page }, info) => {
  await page.goto('/playground.html');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Document text' });
  await input.fill('Picture: ');
  await input.press('End');
  await page.getByLabel('Insert image file').setInputFiles('icon.png');
  const width = page.getByRole('spinbutton', { name: 'Picture width (in)' }), height = page.getByRole('spinbutton', { name: 'Picture height (in)' });
  await width.fill('1.5'); await width.press('Enter');
  await expect(height).toHaveValue('1.5');
  const pixels = () => page.locator('canvas.canvas-page').first().evaluate(c => c.toDataURL());
  const upright = await pixels();
  await page.locator('.ribbon-card').getByRole('button', { name: 'Rotate', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Flip Vertical' }).click();
  await expect.poll(pixels).not.toBe(upright);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(pixels).toBe(upright);
  await page.locator('.ribbon-card').getByRole('button', { name: 'Rotate', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Rotate Right 90°' }).click();
  const path = info.outputPath('picture-rotate.docx');
  const download = page.waitForEvent('download'); await downloadDocx(page); await (await download).saveAs(path);
  const { unzipSync, strFromU8 } = await import('fflate');
  const xml = strFromU8(unzipSync(new Uint8Array((await import('node:fs')).readFileSync(path)))['word/document.xml']);
  expect(xml).toMatch(/<a:xfrm[^>]*rot="5400000"/);
  expect(xml).toContain('cx="1371600"');
});
