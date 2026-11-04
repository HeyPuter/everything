import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { onTab, downloadDocx } from './helpers/editor-tools.js';
import { reopenDocx } from './helpers/reopen-docx.js';

/**
 * A shape or text box pasted here is read from the copy's drawing XML, which any web page can put on the clipboard.
 * A text box whose text held an INCLUDEPICTURE, INCLUDETEXT, LINK or DDE field went into the saved file as it
 * was: a link to a picture or file elsewhere, planted in the user's document, that Word can load when the file is
 * opened. Such a paste is refused with a message saying why; the document is left as it was.
 */
test.use({ viewport: { width: 1440, height: 900 } });
const input = page => page.getByRole('textbox', { name: 'Document text' });
const drawingCount = page => page.evaluate(() => window.__docs.current.view.engine.model.paragraphs.flatMap(p => p.runs).filter(r => r.image).length);
const FIELD = instr => `<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r>${instr.map(part => `<w:r><w:instrText xml:space="preserve">${part}</w:instrText></w:r>`).join('')}<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>picture</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`;

async function textBox(page) {
  await page.goto('/mock.html#/new');
  await expect((await onTab(page, 'home')).getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await input(page).focus(); await page.keyboard.type('Start.');
  await (await onTab(page, 'insert')).locator('.ribbon-card').getByRole('button', { name: 'Text Box', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Simple Text Box/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit drawing text' });
  await dialog.getByRole('textbox').first().press('ControlOrMeta+a'); await page.keyboard.type('Boxed');
  await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(dialog).toHaveCount(0);
}
const selectDrawing = page => input(page).evaluate(el => { const at = el.value.indexOf('￼'); el.setSelectionRange(at, at + 1); el.dispatchEvent(new Event('select', { bubbles: true })); });
const copied = page => input(page).evaluate(el => { const d = new DataTransfer(); el.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: d })); return d.getData('text/html'); });
const paste = (page, html) => input(page).evaluate((el, html) => {
  const e = window.__docs.current.view.engine; e.model.select(e.model.text.length); e.syncInput();
  const d = new DataTransfer(); d.setData('text/html', html); d.setData('text/plain', 'x');
  el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: d }));
}, html);
const carried = html => JSON.parse(/data-documents-drawing="([^"]*)"/.exec(html)[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')).xml;
const carrying = xml => `<div data-documents-drawing="${JSON.stringify({ xml }).replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">x</div>`;

test('a pasted text box whose text loads a picture or file from elsewhere is refused with a message', async ({ page }, info) => {
  await textBox(page);
  await selectDrawing(page);
  const xml = carried(await copied(page));
  for (const [i, field] of [
    FIELD([' INCLUDEPICTURE "https://example.invalid/beacon.png" \\d ']),
    FIELD(['  incl', 'udepicture  "https://example.invalid/split.png"']),
    `<w:p><w:fldSimple w:instr=" IncludeText &quot;https://example.invalid/a.docx&quot; "><w:r><w:t>x</w:t></w:r></w:fldSimple></w:p>`,
  ].entries()) {
    await paste(page, carrying(xml.replace('</w:txbxContent>', `${field}</w:txbxContent>`)));
    await expect(page.locator('.toast').filter({ hasText: 'This drawing can’t be pasted' }).first()).toBeVisible();
    expect(await drawingCount(page), `variant ${i}`).toBe(1);
  }
  // The same text box without such a field still pastes.
  await paste(page, carrying(xml));
  await expect.poll(() => drawingCount(page)).toBe(2);
  const path = info.outputPath('pasted.docx');
  const download = page.waitForEvent('download'); await downloadDocx(page); await (await download).saveAs(path);
  expect(strFromU8(unzipSync(new Uint8Array(readFileSync(path)))['word/document.xml'])).not.toContain('example.invalid');
});

test('copying a text box of the document that holds such a field and pasting it says it cannot be pasted', async ({ page }, info) => {
  await textBox(page);
  const saved = info.outputPath('box.docx');
  const download = page.waitForEvent('download'); await downloadDocx(page); await (await download).saveAs(saved);
  const parts = unzipSync(new Uint8Array(readFileSync(saved)));
  const xml = strFromU8(parts['word/document.xml']);
  parts['word/document.xml'] = strToU8(xml.replace('</w:txbxContent>', `${FIELD([' INCLUDEPICTURE "https://example.invalid/own.png" '])}</w:txbxContent>`));
  const withField = info.outputPath('box-field.docx'); writeFileSync(withField, zipSync(parts));
  await reopenDocx(page, input(page), withField, await input(page).inputValue());
  await selectDrawing(page);
  const html = await copied(page);
  test.skip(!html.includes('data-documents-drawing'), 'This text box does not copy as a drawing.');
  await paste(page, html);
  await expect(page.locator('.toast').filter({ hasText: 'This drawing can’t be pasted' }).first()).toBeVisible();
  expect(await drawingCount(page)).toBe(1);
});
