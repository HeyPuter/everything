import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { unzipSync, zipSync } from 'fflate';
import { reopenDocx } from './helpers/reopen-docx.js';
import { menuBarMenu } from './helpers/editor-tools.js';

const source = 'tests/fixtures/emf-text/control.docx';
const missing = 'Missing EMF Face 48C9';
function unavailableFontDocument(fontName = missing) {
  const parts = unzipSync(readFileSync(source));
  for (const [name, bytes] of Object.entries(parts)) {
    if (!name.endsWith('.emf')) continue;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let at = 0; at < bytes.length; at += view.getUint32(at + 4, true)) {
      if (view.getUint32(at, true) !== 82) continue;
      bytes.fill(0, at + 40, at + 104);
      for (let i = 0; i < fontName.length; i++) view.setUint16(at + 40 + i * 2, fontName.charCodeAt(i), true);
    }
  }
  return Buffer.from(zipSync(parts));
}

test('missing EMF fonts are reported once without disabling editing or changing the package', async ({ page }, info) => {
  await page.goto('/playground.html');
  const buffer = unavailableFontDocument(), original = unzipSync(buffer);
  await page.getByLabel('Open DOCX file').setInputFiles({ name: 'picture-fonts.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer });
  const input = page.getByRole('textbox', { name: 'Document text' });
  await expect(input).toHaveValue(/^Shape defaults controls/);
  await expect(input).toHaveJSProperty('readOnly', false);
  const notice = page.locator('[data-picture-font-warning]');
  await expect(notice).toHaveText(`Fonts unavailable in pictures: ${missing}. Text in those pictures may look different.`);
  await expect(page.locator('.canvas-message')).not.toContainText('read-only');
  const save = async name => {
    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download .docx', exact: true }).click();
    const path = info.outputPath(name + '.docx'); await (await pending).saveAs(path); return path;
  };
  expect(unzipSync(readFileSync(await save('noedit')))).toEqual(original);
  const text = await input.inputValue();
  await input.press('ControlOrMeta+Home'); await page.keyboard.insertText('Edited ');
  const edited = await save('edited'), parts = unzipSync(readFileSync(edited));
  for (const name of Object.keys(original)) if (name !== 'word/document.xml') expect(parts[name]).toEqual(original[name]);
  await input.press('ControlOrMeta+z');
  expect(unzipSync(readFileSync(await save('undo')))).toEqual(original);
  await reopenDocx(page, input, edited, 'Edited ' + text);
  await expect(notice).toBeVisible();
  await page.getByLabel('Open DOCX file').setInputFiles(source);
  await expect(input).toHaveValue(/^Shape defaults controls/);
  await expect(notice).toHaveCount(0);
  await expect(page.locator('.canvas-message')).toBeHidden();
});

test('font-file loading refreshes metafile text and its warning without changing the package', async ({page},info)=>{
  test.setTimeout(180000);await page.goto('/playground.html');const buffer=unavailableFontDocument('Corpus File Font');
  await page.getByLabel('Open DOCX file').setInputFiles({name:'file-font-metafile.docx',mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',buffer});
  const input=page.getByRole('textbox',{name:'Document text'});await expect(input).toHaveValue(/^Shape defaults controls/);
  const notice=page.locator('[data-picture-font-warning]');await expect(notice).toContainText('Corpus File Font');
  const before=await page.locator('canvas.canvas-page').first().evaluate(c=>c.toDataURL());
  await (await menuBarMenu(page,'Format')).getByRole('menuitem',{name:'Document Fonts…',exact:true}).click();
  await page.getByLabel('Font files').setInputFiles('tests/fixtures/font-files/Regular.ttf');
  await expect(page.getByRole('status').filter({hasText:'Available in this session: Corpus File Font.'})).toBeVisible({timeout:90000});
  await expect(notice).toHaveCount(0);await page.keyboard.press('Escape');
  expect(await page.locator('canvas.canvas-page').first().evaluate(c=>c.toDataURL())).not.toBe(before);
  const event=page.waitForEvent('download');await page.getByRole('button',{name:'Download .docx',exact:true}).click();const path=info.outputPath('metafile-noedit.docx');await(await event).saveAs(path);
  expect(unzipSync(readFileSync(path))).toEqual(unzipSync(buffer));await expect(input).toHaveJSProperty('readOnly',false);
});
