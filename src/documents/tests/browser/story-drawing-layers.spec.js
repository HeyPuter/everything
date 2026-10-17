import {test,expect} from '@playwright/test';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {unzipSync} from 'fflate';
import {reopenDocx} from './helpers/reopen-docx.js';
const source='public/fixtures/story-drawing-layers.docx';
const reference=JSON.parse(readFileSync('tests/fixtures/story-drawing-layers/reference.json','utf8'));
test.use({deviceScaleFactor:3});
test('matches native story stacking while preserving visible stories, body front/behind order and edits',async({page},info)=>{
 test.setTimeout(90000);
 expect(createHash('sha256').update(readFileSync(source)).digest('hex')).toBe(reference.sourceSha256);
 expect(createHash('sha256').update(readFileSync('tests/fixtures/story-drawing-layers/native.pdf')).digest('hex')).toBe(reference.pdfSha256);
 await page.goto('/playground.html');
 // While the body is edited the screen dims the header and footer bands (canvas-story-chrome.js), a
 // screen-only cue the native PDF does not have. Compare the editor's printed pages, which omit it.
 await page.evaluate(async()=>{const {CanvasEditor}=await import('/src/engine/canvas-editor.js');const paint=CanvasEditor.prototype.paint;CanvasEditor.prototype.paint=function(...args){window.storyEditor=this;return paint.apply(this,args);};});
 await page.getByLabel('Open DOCX file').setInputFiles(source);
 const input=page.getByRole('textbox',{name:'Document text'});await expect(input).toHaveValue(/^BODY TEXT/);await expect(input).toHaveJSProperty('readOnly',false);
 const check=async()=>{
  await expect(page.locator('canvas.canvas-page')).toHaveCount(5);await expect(page.locator('#playground-error')).toBeEmpty();
  const actual=await page.evaluate(ref=>Array.from(window.storyEditor.printSheets(),(c,i)=>{
   const ctx=c.getContext('2d'),scale=c.width/612;
   return {samples:ref.pages[i].samples.map(s=>Array.from(ctx.getImageData(Math.round(s.x*scale),Math.round(s.y*scale),1,1).data).slice(0,3)),regions:ref.pages[i].regions.map(r=>{
    const [x,y,w,h]=r.rect,data=ctx.getImageData(Math.round(x*scale),Math.round(y*scale),Math.round(w*scale),Math.round(h*scale)).data;let dark=0;
    for(let j=0;j<data.length;j+=4)if(Math.max(data[j],data[j+1],data[j+2])<50)dark++;
    return dark/(scale*scale)*16;
   })};
  }),reference);
  for(const [i,p] of reference.pages.entries()){
   expect(actual[i].samples,`page ${i+1} picture order`).toEqual(p.samples.map(s=>s.color));
   for(const [j,r] of p.regions.entries()){
    if(r.dark===0)expect(actual[i].regions[j],`page ${i+1} covered ${r.name}`).toBe(0);
    else expect(Math.abs(actual[i].regions[j]/r.dark-1),`page ${i+1} visible ${r.name}`).toBeLessThan(.2);
   }
  }
 };
 await check();
 for(const [i,c] of (await page.locator('canvas.canvas-page').all()).entries())writeFileSync(info.outputPath(`page-${i+1}.png`),Buffer.from(await c.evaluate(c=>c.toDataURL().split(',')[1]),'base64'));
 const original=await input.inputValue(),parts=unzipSync(readFileSync(source));
 const save=async name=>{const event=page.waitForEvent('download');await page.getByRole('button',{name:'Download .docx',exact:true}).click();const path=info.outputPath(name+'.docx');await(await event).saveAs(path);return path;};
 expect(unzipSync(readFileSync(await save('noedit')))).toEqual(parts);
 // Edit after the visible text without changing the overlap witness regions.
 await input.press('ControlOrMeta+End');await page.keyboard.insertText(' ');const edited=await save('edited');
 for(const [n,b] of Object.entries(unzipSync(readFileSync(edited))))if(n!=='word/document.xml')expect(b,n).toEqual(parts[n]);
 await input.press('ControlOrMeta+z');await expect(input).toHaveValue(original);await check();expect(unzipSync(readFileSync(await save('undo')))).toEqual(parts);
 await reopenDocx(page,input,edited,original+' ');await check();
});
