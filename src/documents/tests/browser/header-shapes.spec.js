import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { onTab, downloadDocx } from './helpers/editor-tools.js';

// A shape or text box drawn while a header is being edited goes into the header, as a picture does. It went
// into the body, anchored at the header's caret offset in the body text (so on another page in a long
// document), and the header stopped being edited.
test('a shape and a text box inserted while editing a header belong to the header', async ({ page }, info) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/playground.html');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByRole('textbox', { name: 'Document text' }).fill('Body text. '.repeat(20));
  await onTab(page, 'insert');
  await page.locator('#ribbon-panel-insert').getByRole('button', { name: 'Header', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Edit Header' }).click();
  const header = page.getByRole('textbox', { name: 'Header text' });
  await expect(header).toBeFocused();
  const drawings = async name => {
    const download = page.waitForEvent('download'); await downloadDocx(page);
    const path = info.outputPath(name); await (await download).saveAs(path);
    const files = unzipSync(readFileSync(path)), names = xml => [...(xml || '').matchAll(/<wp:docPr [^>]*name="([^"]*)"/g)].map(m => m[1]);
    const headers = Object.keys(files).filter(k => /^word\/header\d*\.xml$/.test(k)).flatMap(k => names(strFromU8(files[k])));
    return { body: names(strFromU8(files['word/document.xml'])), headers };
  };
  await onTab(page, 'insert');
  await page.locator('#ribbon-panel-insert').getByRole('button', { name: 'Shapes', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Oval', exact: true }).click();
  const box = await page.locator('canvas.canvas-page').first().boundingBox();
  await page.mouse.move(box.x + 500, box.y + 30); await page.mouse.down(); await page.mouse.move(box.x + 600, box.y + 70, { steps: 4 }); await page.mouse.up();
  await expect(page.locator('#ribbon-tab-shapeFormat')).toBeVisible();
  await expect.poll(() => drawings('shape.docx')).toEqual({ body: [], headers: ['Oval 1'] });
  await header.focus();
  await onTab(page, 'insert');
  await page.locator('#ribbon-panel-insert').getByRole('button', { name: 'Text Box', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Simple Text Box/ }).click();
  const hint = page.getByText('Edit this text frame, then apply your changes to the drawing.');
  await expect(hint).toBeVisible();
  await page.keyboard.type('Draft');
  await page.getByRole('dialog').filter({ has: hint }).last().getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(hint).toBeHidden();
  await expect.poll(() => drawings('text-box.docx')).toEqual({ body: [], headers: ['Oval 1', 'Text Box 2'] });
  await header.focus(); await header.press('ControlOrMeta+z'); await header.press('ControlOrMeta+z');
  await expect.poll(() => drawings('undone.docx')).toEqual({ body: [], headers: ['Oval 1'] });
  expect(errors).toEqual([]);
});
