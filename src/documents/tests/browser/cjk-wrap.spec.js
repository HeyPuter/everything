import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { unzipSync } from 'fflate';
import { reopenDocx } from './helpers/reopen-docx.js';
const source='public/fixtures/cjk-wrap.docx';
const cases=JSON.parse(readFileSync('tests/fixtures/cjk-wrap/cases.json','utf8'));
// Characters a line may not start or end with under the default East Asian line rules.
const NO_START=/^[、。，．：；？！）」』】〕〉》”’ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶーゝゞヽヾ々…‥・]/u,NO_END=/[（「『【〔〈《“‘]$/u;
test('wraps Chinese and Japanese beside every character under the East Asian line rules, through editing, reopen and exact undo',async({page},info)=>{
 test.setTimeout(90000);
 await page.goto('/playground.html');const input=page.getByRole('textbox',{name:'Document text'});
 // Open the fixture only once the initial sample has loaded, so the sample cannot replace it.
 await expect(input).toHaveValue(/A small beginning/);await page.getByLabel('Open DOCX file').setInputFiles(source);
 await expect(input).toHaveValue(/CASE japanese/);await expect(input).toHaveJSProperty('readOnly',false);
 const check=async path=>{
  const result=await page.evaluate(async data=>{
   const {DocxPackage}=await import('/src/engine/docx.js'),{loadCanvasFonts,measureCanvasText,setCanvasFontAlternatives}=await import('/src/engine/canvas-text.js'),{layoutDocument}=await import('/src/engine/layout.js'),{pageGeometry}=await import('/src/engine/page-settings.js'),{paragraphText}=await import('/src/engine/model.js');
   const pkg=await DocxPackage.open(Uint8Array.from(atob(data),c=>c.charCodeAt(0)));await loadCanvasFonts(pkg);
   const ctx=document.createElement('canvas').getContext('2d');setCanvasFontAlternatives(ctx,pkg.styles.fontAlternatives);
   const layout=layoutDocument(pkg.paragraphs,(t,s)=>measureCanvasText(ctx,t,s),pageGeometry(pkg.pageSettings),pkg.numbering,pkg.tables);
   return pkg.paragraphs.filter((p,i)=>i%2).map(p=>{
    const text=paragraphText(p),lines=layout.lines.filter(l=>l.paragraphId===p.id),base=lines[0].start;
    return {text,lines:lines.map(l=>text.slice(l.start-base,l.end-base))};
   });
  },readFileSync(path).toString('base64'));
  for(const [i,c] of cases.entries()){
   const r=result[i];
   if(i||!path.includes('edited'))expect(r.text).toBe(c.runs.join(''));
   expect(r.lines.length,c.name).toBeGreaterThan(1);expect(r.lines.join(''),c.name).toBe(r.text);
   for(const line of r.lines.slice(1))expect(line,c.name).not.toMatch(NO_START);
   for(const line of r.lines.slice(0,-1))expect(line,c.name).not.toMatch(NO_END);
   if(c.name==='korean')for(const line of r.lines.slice(0,-1))expect(line,c.name).toMatch(/ $/u);
  }
  // English words followed by Chinese: the Chinese starts on the first line instead of leaving it half empty.
  expect(result[0].lines.find(line=>line.includes('then'))).toMatch(/then [\p{Script=Han}]/u);
  await expect(page.locator('canvas.canvas-page')).toHaveCount(cases.length);await expect(page.locator('#playground-error')).toBeEmpty();
 };
 await check(source);const original=await input.inputValue();
 const save=async name=>{const event=page.waitForEvent('download');await page.getByRole('button',{name:'Download .docx',exact:true}).click();const path=info.outputPath(name);await(await event).saveAs(path);return path;};
 const noedit=await save('noedit.docx');
 const at=original.indexOf('汉字之间');await input.evaluate((el,at)=>{el.focus();el.setSelectionRange(at,at);el.dispatchEvent(new Event('select'));},at);await page.keyboard.insertText('中文');
 const edited=original.slice(0,at)+'中文'+original.slice(at);await expect(input).toHaveValue(edited);
 const editedPath=await save('edited.docx');await check(editedPath);await input.press('ControlOrMeta+z');await expect(input).toHaveValue(original);await check(await save('undo.docx'));
 const a=unzipSync(readFileSync(source));
 for(const path of [noedit,info.outputPath('undo.docx')]){const b=unzipSync(readFileSync(path));for(const name of Object.keys(a))expect(Buffer.from(b[name]).equals(Buffer.from(a[name])),name).toBe(true);}
 const e=unzipSync(readFileSync(editedPath));for(const name of Object.keys(a))if(name!=='word/document.xml')expect(Buffer.from(e[name]).equals(Buffer.from(a[name])),name).toBe(true);
 await reopenDocx(page,input,editedPath,edited);await check(editedPath);
});

test('ideographs take the forms of the language their text is marked in', async ({ page }) => {
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  // Only where this browser has Japanese and Chinese forms of 直 to choose from.
  const distinct = await page.evaluate(() => {
    const draw = lang => { const c = document.createElement('canvas'); c.width = c.height = 64; const ctx = c.getContext('2d'); if (!('lang' in ctx)) return ''; ctx.lang = lang; ctx.font = '48px "Canvas Noto Sans"'; ctx.fillText('直', 4, 52); return c.toDataURL(); };
    return draw('ja-JP') !== draw('zh-CN');
  });
  test.skip(!distinct, 'This browser has one form of these ideographs.');
  const input = page.getByRole('textbox', { name: 'Document text' });
  await input.fill('直骨角\nother');
  const box = await page.locator('canvas.canvas-page').first().boundingBox();
  const shot = async () => {
    const r = await page.evaluate(() => { const e = window.__docs.current.view.engine, l = e.selectionLayout.lines[0]; return { x: l.stops[0].x * e.zoom, w: (l.stops.at(-1).x - l.stops[0].x) * e.zoom, y: l.y * e.zoom, h: l.height * e.zoom }; });
    return (await page.screenshot({ clip: { x: box.x + r.x, y: box.y + r.y, width: r.w - 2, height: r.h } })).toString('base64');
  };
  // As a Japanese document marks its text (w:lang/@w:eastAsia), then as a Chinese one does.
  const mark = language => page.evaluate(language => { const e = window.__docs.current.view.engine; e.model.select(0, 3); e.execute(() => e.model.setRunFormat({ fontEastAsiaLanguage: language })); e.model.select(8); e.syncInput(); e.paint(); }, language);
  await mark('ja-JP'); const japanese = await shot();
  await mark('zh-CN'); const chinese = await shot();
  await mark('ja-JP');
  expect(await shot()).toBe(japanese);
  expect(chinese).not.toBe(japanese);
});
