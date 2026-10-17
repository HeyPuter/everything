import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
import { menuBarMenu } from './helpers/editor-tools.js';
const root = 'tests/fixtures/font-files/';
const ref = JSON.parse(readFileSync(root + 'reference.json'));
test.setTimeout(180000);
async function open(page, name) {
  await page.goto('/playground.html');
  const previous = await page.getByRole('textbox', { name: 'Document text' }).elementHandle();
  await page.getByLabel('Open DOCX file').setInputFiles(root + name + '.docx');
  await expect.poll(() => previous.evaluate(e => e.isConnected), { timeout: 90000 }).toBe(false);
  await expect(page.locator('canvas.canvas-page').first()).toBeVisible();
}
async function fonts(page) {
  await (await menuBarMenu(page, 'Format')).getByRole('menuitem', { name: 'Document Fonts…', exact: true }).click();
  await page.getByLabel('Font files', { exact: true }).setInputFiles(['Regular', 'Bold', 'Italic', 'BoldItalic'].map(name => root + name + '.ttf'));
  await expect(page.getByRole('status').filter({ hasText: 'Available in this session: Corpus File Font.' })).toBeVisible({ timeout: 90000 });
  await page.keyboard.press('Escape');
}
async function save(page, info, name) {
  const event = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download .docx', exact: true }).click();
  const path = info.outputPath(name + '.docx'); await (await event).saveAs(path); return readFileSync(path);
}
async function layout(page) {
  return page.evaluate(async bytes => {
    const { DocxPackage } = await import('/src/engine/docx.js');
    const { validateCanvasLayout, setCanvasFontAlternatives, measureCanvasText } = await import('/src/engine/canvas-text.js');
    const { displayedFont } = await import('/src/engine/font-availability.js');
    const { layoutDocument } = await import('/src/engine/layout.js');
    const { pageGeometry } = await import('/src/engine/page-settings.js');
    const pkg = await DocxPackage.open(new Uint8Array(bytes)); await validateCanvasLayout(pkg);
    const ctx = document.createElement('canvas').getContext('2d'); setCanvasFontAlternatives(ctx, pkg.styles.fontAlternatives);
    const result = layoutDocument(pkg.paragraphs, (t, s) => measureCanvasText(ctx, t, s), pageGeometry(pkg.pageSettings), pkg.numbering, pkg.tables, pkg.pageStories, { styles: pkg.styles });
    return { font: displayedFont(pkg.paragraphs[0].runs[0], pkg.styles.fontAlternatives), rows: result.lines.filter(l => !l.virtual).map(l => ({ text: l.fragments.map(f => f.text).join('').trimEnd(), x: l.stops[0].x * .75, baseline: l.baseline * .75, glyphs: l.stops.filter(s => s.offset < l.end).map(s => s.x * .75) })) };
  }, [...readFileSync(root + 'control.docx')]);
}
test('file fonts refresh an edited document, follow native four-face metrics and preserve source/history', async ({ page }, info) => {
  for (const [file, hash] of Object.entries(ref.sha256)) expect(createHash('sha256').update(readFileSync(root + file)).digest('hex')).toBe(hash);
  await page.addInitScript(() => { window.queryLocalFonts = () => { throw Error('Unexpected OS font permission request'); }; });
  await open(page, 'control'); const input = page.getByRole('textbox', { name: 'Document text' }), original = await input.inputValue();
  await input.focus(); await input.press('ControlOrMeta+Home'); await page.keyboard.insertText('EDIT ');
  const pixels = () => page.locator('canvas.canvas-page').evaluateAll(cs => cs.map(c => c.toDataURL()));
  const before = await pixels(); await fonts(page);
  expect(await pixels()).not.toEqual(before); expect(await input.inputValue()).toBe('EDIT ' + original);
  const edited = unzipSync(await save(page, info, 'edited')), parts = unzipSync(readFileSync(root + 'control.docx'));
  for (const name of Object.keys(parts)) if (name !== 'word/document.xml') expect(edited[name]).toEqual(parts[name]);
  await input.press('ControlOrMeta+z'); expect(await input.inputValue()).toBe(original);
  expect(unzipSync(await save(page, info, 'undo'))).toEqual(parts);
  const actual = await layout(page); expect(actual.font).toMatch(/^canvas file font /); expect(actual.rows).toHaveLength(4);
  expect(await page.evaluate(async()=>{
    const {canvasText}=await import('/src/engine/canvas-text.js');
    const ctx=document.createElement('canvas').getContext('2d');
    return canvasText(ctx,'•',{fontFamily:'Corpus File Font',symbol:{font:'Corpus File Font',fallback:'•',text:'A'}});
  })).toBe('A');
  for (let i = 0; i < 4; i++) {
    const row = actual.rows[i], native = ref.pages[0][i]; expect(row.text).toBe(native.text);
    expect(Math.abs(row.baseline - native.baseline)).toBeLessThan(.2); expect(Math.abs(row.x - native.x)).toBeLessThan(.15);
    for (let j = 0; j < native.glyphs.length; j++) expect(Math.abs(row.glyphs[j] - native.glyphs[j]), `row ${i} glyph ${j}`).toBeLessThan(.35);
  }
  writeFileSync(info.outputPath('metrics.json'), JSON.stringify(actual, null, 2));
  await page.locator('canvas.canvas-page').first().screenshot({ path: info.outputPath('rendered.png') });
  await page.getByRole('button', { name: 'Latin font family', exact: true }).click();
  await expect(page.getByRole('dialog',{name:'Font',exact:true}).getByRole('status')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Corpus File Font Loaded for this session', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  // Reopening stays in the same browser session and must retain the loaded faces.
  await page.getByLabel('Open DOCX file').setInputFiles(root + 'control.docx');
  await expect(page.getByRole('textbox', { name: 'Document text' })).toHaveValue(original);
  expect(await layout(page)).toEqual(actual);
});
test('read-only previews can load fonts and retain the original download', async ({ page }, info) => {
  await open(page, 'readonly'); const input = page.getByRole('textbox', { name: 'Document text' });
  await expect(input).toHaveJSProperty('readOnly', true);
  const before = await page.locator('canvas.canvas-page').first().evaluate(c => c.toDataURL());
  await fonts(page); expect(await page.locator('canvas.canvas-page').first().evaluate(c => c.toDataURL())).not.toBe(before);
  await expect(input).toHaveJSProperty('readOnly', true); expect(unzipSync(await save(page, info, 'readonly'))).toEqual(unzipSync(readFileSync(root + 'readonly.docx')));
});
test('invalid files report their error while valid files load; repeated selections do not replace faces', async ({ page }) => {
  await open(page, 'control'); await page.getByRole('button', { name: 'Latin font family', exact: true }).click();
  await page.getByLabel('Font files').setInputFiles([{ name: 'invalid.ttf', mimeType: 'font/ttf', buffer: Buffer.from('not a font') }, { name: 'unrelated-name.otf', mimeType: 'font/otf', buffer: readFileSync(root + 'Regular.ttf') }]);
  await expect(page.getByRole('status').filter({ hasText: 'Available in this session: Corpus File Font. invalid.ttf:' })).toBeVisible();
  const before = await layout(page); await page.getByLabel('Font files').setInputFiles(root + 'Regular.ttf');
  await expect(page.getByRole('status').filter({ hasText: 'Available in this session: Corpus File Font.' })).toBeVisible(); expect(await layout(page)).toEqual(before);
});
test('variable weight/width and real italic faces remain available under their internal family', async ({ page }) => {
  await page.goto('/playground.html');
  const result=await page.evaluate(async files=>{
    const {loadFontFile,fileFontFamily}=await import('/src/engine/file-fonts.js');
    const {prepareCanvasFont,canvasFontSources}=await import('/src/engine/font-availability.js');
    for(const bytes of files)await loadFontFile(new File([new Uint8Array(bytes)],'unrelated.ttf'));
    await prepareCanvasFont('Open Sans');const alias=fileFontFamily('Open Sans'),sources=canvasFontSources(alias);
    const ctx=document.createElement('canvas').getContext('2d'),widths=[];
    for(const style of ['normal 400','normal 700','italic 400']){ctx.font=`${style} 32px "${alias}"`;widths.push(ctx.measureText('Hamburg AVATAR office').width);}
    return {descriptors:sources.map(s=>s.descriptors),widths};
  },['OpenSans.ttf','OpenSans-Italic.ttf'].map(name=>[...readFileSync('public/fonts/'+name)]));
  expect(result.descriptors).toEqual([{weight:'300 800',style:'normal',stretch:'75% 100%'},{weight:'300 800',style:'italic',stretch:'75% 100%'}]);
  expect(result.widths[0]).not.toBe(result.widths[1]);expect(result.widths[0]).not.toBe(result.widths[2]);
});
