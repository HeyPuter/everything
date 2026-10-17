import {test,expect} from '@playwright/test';
import {readFileSync} from 'node:fs';
import {unzipSync} from 'fflate';
import {reopenDocx} from './helpers/reopen-docx.js';
const refs=JSON.parse(readFileSync('tests/fixtures/paragraph-paint-width/reference.json'));
test.use({deviceScaleFactor:2});
async function download(page,info,name){const event=page.waitForEvent('download');await page.getByRole('button',{name:'Download .docx',exact:true}).click();const path=info.outputPath(name);await(await event).saveAs(path);return path;}
// Fractional sizes paint inside a translated, scaled context; record the baseline in page CSS pixels.
for(const ref of refs)test('paints native paragraph width: '+ref.file,async({page},info)=>{
 await page.addInitScript(()=>{window.widthPaint={};const fill=CanvasRenderingContext2D.prototype.fillText;CanvasRenderingContext2D.prototype.fillText=function(t,x,y,...rest){const m=this.getTransform();window.widthPaint[t]=(m.b*x+m.d*y+m.f)/(this.canvas.width/(612*4/3));return fill.call(this,t,x,y,...rest);};});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('/playground.html');await page.getByLabel('Open DOCX file').setInputFiles('public/fixtures/'+ref.file);
 const input=page.getByRole('textbox',{name:'Document text'});await expect(input).toHaveValue(new RegExp('^'+ref.pages[0].labels[0].replace(/Body$/,'')));await expect(input).toBeEditable();await expect(page.locator('canvas.canvas-page')).toHaveCount(ref.pages.length);
 for(const [i,reference]of ref.pages.entries())if(reference.compareFill)for(const [j,label]of reference.labels.entries()){
  await expect.poll(()=>page.evaluate(t=>window.widthPaint[t],label)).toBeTruthy();
  const y=await page.evaluate(t=>window.widthPaint[t],label);
  const bounds=await page.locator('canvas.canvas-page').nth(i).evaluate((c,y)=>{
   const scale=c.width/612,cssScale=c.width/(612*4/3),data=c.getContext('2d').getImageData(0,Math.round((y-4)*cssScale),c.width,1).data;let left=Infinity,right=-Infinity;
   for(let x=0;x<c.width;x++)if(data[x*4]===34&&data[x*4+1]===136&&data[x*4+2]===68){left=Math.min(left,x);right=x+1;}
   return {x:left/scale,right:right/scale};
  },y);
  expect(Math.abs(bounds.x-reference.fills[j].x),label+' left').toBeLessThan(.55);expect(Math.abs(bounds.right-reference.fills[j].right),label+' right').toBeLessThan(.55);
 }
 const original=unzipSync(readFileSync('public/fixtures/'+ref.file));expect(unzipSync(readFileSync(await download(page,info,'unchanged.docx')))).toEqual(original);
 if(ref.file==='paragraph-border-width-control.docx'){
  const text=await input.inputValue();await input.evaluate(el=>{el.focus();el.setSelectionRange(0,0);el.dispatchEvent(new Event('select',{bubbles:true}));});await input.press('!');await expect(input).toHaveValue('!'+text);
  const saved=await download(page,info,'edited.docx'),parts=unzipSync(readFileSync(saved));for(const [name,data]of Object.entries(original))if(name!=='word/document.xml')expect(parts[name]).toEqual(data);
  await page.getByRole('button',{name:'Undo',exact:true}).click();await expect(input).toHaveValue(text);expect(unzipSync(readFileSync(await download(page,info,'undo.docx')))).toEqual(original);await reopenDocx(page,input,saved,'!'+text);
 }
 expect(errors).toEqual([]);
});
