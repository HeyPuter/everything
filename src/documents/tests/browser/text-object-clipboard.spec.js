import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { onTab, downloadDocx } from './helpers/editor-tools.js';
import { reopenDocx } from './helpers/reopen-docx.js';

// Text cut or copied with the pictures, shapes and equations in it pastes back with them in this document,
// rather than with "[Image]" or an equation's linear text in their place.
const input = page => page.getByRole('textbox', { name: 'Document text' });
test.use({ viewport: { width: 1440, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
const objects = page => page.evaluate(() => {
  const m = window.__docs.current.view.engine.model;
  return m.paragraphs.map(p => p.runs.map(r => r.image ? `[${r.image.anchor ? 'float' : 'inline'}:${r.image.id}]` : r.math ? '[math]' : r.text).join(''));
});
async function start(page) {
  await page.goto('/mock.html#/new');
  await expect((await onTab(page, 'home')).getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await input(page).focus();
}
const select = (page, from, to) => page.evaluate(([from, to]) => { const e = window.__docs.current.view.engine; e.model.select(from, to); e.syncInput(); e.paint(); e.onSelection(); e.focus(); }, [from, to]);

test('a paragraph cut with its picture, shape and equation pastes back with all three', async ({ page }, info) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await start(page);
  await page.keyboard.type('First '); 
  await page.getByLabel('Insert image file').setInputFiles('icon.png');
  await expect.poll(async () => (await objects(page))[0]).toMatch(/^First \[inline:\d+\]$/);
  await select(page, 7, 7);
  await page.keyboard.type(' then ');
  await page.keyboard.press(process.platform === 'darwin' ? 'Control+Equal' : 'Alt+Equal');
  const dialog = page.getByRole('dialog', { name: 'Equation' });
  await dialog.getByRole('textbox', { name: 'Equation in linear format' }).fill('x=a/b');
  await dialog.getByRole('button', { name: 'Insert' }).click();
  await expect(dialog).toBeHidden();
  await page.keyboard.type(' end.');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Second paragraph.');
  await onTab(page, 'insert');
  await page.locator('#ribbon-panel-insert').getByRole('button', { name: 'Shapes', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Oval', exact: true }).click();
  const box = await page.locator('canvas.canvas-page').first().boundingBox();
  await page.mouse.move(box.x + 300, box.y + 200); await page.mouse.down(); await page.mouse.move(box.x + 420, box.y + 280, { steps: 4 }); await page.mouse.up();
  await expect(page.locator('#ribbon-tab-shapeFormat')).toBeVisible();
  const before = await objects(page);
  expect(before[0]).toMatch(/^First (\[float:\d+\])?\[inline:\d+\] then \[math\] end\.$/);
  // The first paragraph with its mark: picture, equation and whatever shape anchors there.
  const length = (await input(page).inputValue()).indexOf('\n') + 1;
  await select(page, 0, length);
  await page.keyboard.press('ControlOrMeta+x');
  await expect.poll(async () => (await objects(page)).length).toBe(before.length - 1);
  await page.evaluate(() => { const e = window.__docs.current.view.engine; e.model.select(e.model.text.length); e.syncInput(); e.paint(); e.onSelection(); e.focus(); });
  await page.keyboard.press('Enter');
  await page.keyboard.press('ControlOrMeta+v');
  const pasted = (await objects(page)).filter(p => p.startsWith('First'))[0];
  expect(pasted?.replace(/\d+/g, '#')).toBe(before[0].replace(/\d+/g, '#'));
  // One undo takes the paste back.
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await objects(page)).some(p => p.startsWith('First'))).toBe(false);
  await page.keyboard.press('ControlOrMeta+y');
  await expect.poll(async () => (await objects(page)).some(p => p.startsWith('First'))).toBe(true);
  const path = info.outputPath('text-objects.docx');
  const download = page.waitForEvent('download'); await downloadDocx(page); await (await download).saveAs(path);
  const xml = strFromU8(unzipSync(new Uint8Array(readFileSync(path)))['word/document.xml']);
  expect(xml).toContain('<m:f>');
  const ids = [...xml.matchAll(/<wp:docPr id="(\d+)"/g)].map(m => m[1]);
  expect(new Set(ids).size).toBe(ids.length);
  await reopenDocx(page, input(page), path, await input(page).inputValue());
  expect((await objects(page)).filter(p => p.startsWith('First'))[0].replace(/\d+/g, '#')).toBe(before[0].replace(/\d+/g, '#'));
  expect(errors).toEqual([]);
});

test('text copied with a picture pastes a second picture here, and only its text into another document', async ({ page }, info) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await start(page);
  await page.keyboard.type('Logo ');
  await page.getByLabel('Insert image file').setInputFiles('icon.png');
  await expect.poll(async () => (await objects(page))[0]).toMatch(/^Logo \[inline:\d+\]$/);
  await select(page, 0, 6);
  await page.keyboard.press('ControlOrMeta+c');
  await page.evaluate(() => { const e = window.__docs.current.view.engine; e.model.select(e.model.text.length); e.syncInput(); e.paint(); e.onSelection(); e.focus(); });
  await page.keyboard.press('Enter');
  await page.keyboard.press('ControlOrMeta+v');
  await expect.poll(async () => (await objects(page)).map(p => p.replace(/\d+/g, '#'))).toEqual(['Logo [inline:#]', 'Logo [inline:#]']);
  const path = info.outputPath('copied-picture.docx');
  const download = page.waitForEvent('download'); await downloadDocx(page); await (await download).saveAs(path);
  const parts = unzipSync(new Uint8Array(readFileSync(path))), xml = strFromU8(parts['word/document.xml']);
  expect(xml.match(/<pic:pic /g)).toHaveLength(2);
  const ids = [...xml.matchAll(/<wp:docPr id="(\d+)"/g)].map(m => m[1]);
  expect(new Set(ids).size).toBe(2);
  await reopenDocx(page, input(page), path, await input(page).inputValue());
  expect((await objects(page)).map(p => p.replace(/\d+/g, '#'))).toEqual(['Logo [inline:#]', 'Logo [inline:#]']);
  // Another open document (another token) takes the text alone, with no stray character.
  await page.evaluate(() => { window.__docs.current.view.engine.clipboardToken = 'another document'; });
  await page.evaluate(() => { const e = window.__docs.current.view.engine; e.model.select(e.model.text.length); e.syncInput(); e.paint(); e.onSelection(); e.focus(); });
  await page.keyboard.press('Enter');
  await page.keyboard.press('ControlOrMeta+v');
  await expect.poll(async () => (await objects(page)).at(-1)).toBe('Logo ');
  expect(errors).toEqual([]);
});
