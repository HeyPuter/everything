import {test,expect} from '@playwright/test';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {unzipSync} from 'fflate';
import {reopenDocx} from './helpers/reopen-docx.js';
const source='public/fixtures/cell-leading-space.docx';
const reference=JSON.parse(readFileSync('tests/fixtures/cell-leading-space/reference.json','utf8'));
test('matches native cell leading spacing across alignment and contextual boundaries',async({page},info)=>{
 test.setTimeout(120000);
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 expect(createHash('sha256').update(readFileSync(source)).digest('hex')).toBe(reference.sourceSha256);
 expect(createHash('sha256').update(readFileSync('tests/fixtures/cell-leading-space/native.pdf')).digest('hex')).toBe(reference.pdfSha256);
 await page.goto('/playground.html');await page.getByLabel('Open DOCX file').setInputFiles(source);
 const input=page.getByRole('textbox',{name:'Document text'});await expect(input).toHaveJSProperty('readOnly',false);
 await expect(page.locator('canvas.canvas-page')).toHaveCount(16);
 const actual=await page.evaluate(async bytes=>{
  const {DocxPackage}=await import('/src/engine/docx.js');const {loadCanvasFonts,measureCanvasText}=await import('/src/engine/canvas-text.js');const {layoutDocument}=await import('/src/engine/layout.js');const {layoutPageStories}=await import('/src/engine/page-story-layout.js');const {pageGeometry}=await import('/src/engine/page-settings.js');
  const p=await DocxPackage.open(Uint8Array.from(atob(bytes),c=>c.charCodeAt(0)));await loadCanvasFonts(p);const ctx=document.createElement('canvas').getContext('2d'),measure=(t,s)=>measureCanvasText(ctx,t,s);
  const body=layoutDocument(p.paragraphs,measure,pageGeometry(p.pageSettings),p.numbering,p.tables,p.pageStories);
  const story=layoutPageStories(body,p.pageStories,[...p.paragraphs.filter(p=>p.sectionEnd).map(p=>p.sectionEnd),p.pageSettings],measure,p.numbering,{styles:p.styles});
  // The empty paragraph a document ending in a table gets (as Word gives it) has no text to compare.
  return [...body.lines,...story.lines].filter(l=>l.fragments.length).map(l=>({page:l.page,text:l.fragments.map(f=>f.text).join(''),x:l.fragments[0].x*.75,baseline:l.baseline*.75,
   closing:l.fragments.at(-1).text.endsWith(']')?(l.fragments.at(-1).x+measure(l.fragments.at(-1).text.slice(0,-1),l.fragments.at(-1)).width)*.75:null}));
 },readFileSync(source).toString('base64'));
 writeFileSync(info.outputPath('actual.json'),JSON.stringify(actual,null,2));
 for(const [i,data] of (await page.locator('canvas.canvas-page').evaluateAll(cs=>cs.map(c=>c.toDataURL()))).entries())writeFileSync(info.outputPath(`page${i+1}.png`),Buffer.from(data.split(',')[1],'base64'));
 for(const [i,refs] of reference.pages.entries()){
  const lines=actual.filter(l=>l.page===i);
  expect(lines).toHaveLength(4);
  for(const line of lines){
   const ref=refs.find(r=>r.text.includes(line.text));expect(ref,line.text).toBeTruthy();
   expect(Math.abs(line.baseline-ref.baseline),`page ${i+1} ${line.text} baseline`).toBeLessThan(.2);
   expect(Math.abs(line.x-ref.glyphs[ref.text.indexOf(line.text)]),line.text+' origin').toBeLessThan(.2);
  }
 }
 const original=await input.inputValue(),parts=unzipSync(readFileSync(source));
 const save=async name=>{const pending=page.waitForEvent('download');await page.getByRole('button',{name:'Download .docx',exact:true}).click();const path=info.outputPath(name+'.docx');await(await pending).saveAs(path);return path;};
 expect(unzipSync(readFileSync(await save('noedit')))).toEqual(parts);
 await input.press('ControlOrMeta+Home');await page.keyboard.insertText('EDIT ');const edited=await save('edited'),changed=unzipSync(readFileSync(edited));
 for(const name of Object.keys(parts))if(name!=='word/document.xml')expect(changed[name],name).toEqual(parts[name]);
 await input.press('ControlOrMeta+z');await expect(input).toHaveValue(original);expect(unzipSync(readFileSync(await save('undo')))).toEqual(parts);
 const previous=await input.elementHandle();page.once('dialog',d=>d.accept());await page.getByLabel('Open DOCX file').setInputFiles(edited);await page.waitForFunction(el=>!el.isConnected,previous,{timeout:60000});await previous.dispose();await expect(input).toHaveValue('EDIT '+original);await expect(page.locator('#playground-error')).toBeEmpty();expect(errors).toEqual([]);
});
