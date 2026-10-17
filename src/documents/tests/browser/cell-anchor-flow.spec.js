import {test,expect} from '@playwright/test';
import {readFileSync,writeFileSync} from 'node:fs';
import {unzipSync} from 'fflate';
import {reopenDocx} from './helpers/reopen-docx.js';
const refs=JSON.parse(readFileSync('tests/fixtures/cell-anchor-flow/reference.json'));
const origins=JSON.parse(readFileSync('tests/fixtures/cell-anchor-flow/origins.json'));
async function download(page,info,name){const event=page.waitForEvent('download');await page.getByRole('button',{name:'Download .docx',exact:true}).click();const path=info.outputPath(name);await(await event).saveAs(path);return path;}
for(const ref of origins)test('paints displaced cell origins: '+ref.file,async({page},info)=>{
 await page.goto('/playground.html');await page.getByLabel('Open DOCX file').setInputFiles('public/fixtures/'+ref.file);await expect(page.getByRole('textbox',{name:'Document text'})).toHaveValue(/^Origin1/);await expect(page.getByRole('textbox',{name:'Document text'})).toBeEditable();
 await expect(page.locator('canvas.canvas-page')).toHaveCount(2);
 for(const [i,frames] of ref.frames.entries()){
  const canvas=page.locator('canvas.canvas-page').nth(i);
  await expect.poll(()=>canvas.evaluate((c,f)=>{const s=c.width/612;return [...c.getContext('2d').getImageData(Math.floor((f[0]+f[2]/2)*s),Math.floor((f[1]+f[3]/2)*s),1,1).data].slice(0,3);},frames[0])).toEqual([20,80,190]);
 }
 expect(unzipSync(readFileSync(await download(page,info,'unchanged.docx')))).toEqual(unzipSync(readFileSync('public/fixtures/'+ref.file)));
});
for(const ref of refs)test('paints native unwrapped cell flow: '+ref.file,async({page},info)=>{
 await page.addInitScript(()=>{window.cellFlowPaint={};const original=CanvasRenderingContext2D.prototype.fillText;CanvasRenderingContext2D.prototype.fillText=function(t,x,y,...rest){const m=this.getTransform();window.cellFlowPaint[t]={x:m.a*x+m.c*y+m.e,y:m.b*x+m.d*y+m.f};return original.call(this,t,x,y,...rest);};});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('/playground.html');await page.getByLabel('Open DOCX file').setInputFiles('public/fixtures/'+ref.file);
 const input=page.getByRole('textbox',{name:'Document text'});await expect(input).toHaveValue(new RegExp('^'+ref.pages[0].lines[0].text));await expect(input).toBeEditable();
 await expect(page.locator('canvas.canvas-page')).toHaveCount(ref.pages.length);
 for(const [i,p] of ref.pages.entries()){
  await expect.poll(()=>page.evaluate(t=>!!window.cellFlowPaint[t],p.lines.at(-1).text)).toBe(true);
  const paint=await page.evaluate(()=>window.cellFlowPaint),first=p.lines[0];for(const line of p.lines)expect(Math.abs((paint[line.text].y-paint[first.text].y)*.75-line.baseline+first.baseline),line.text).toBeLessThan(.3);
  const canvas=page.locator('canvas.canvas-page').nth(i),f=p.frames[0];
  await expect.poll(()=>canvas.evaluate((c,f)=>{const scale=c.width/612;return [...c.getContext('2d').getImageData(Math.floor((f[0]+f[2]/2)*scale),Math.floor((f[1]+f[3]-2)*scale),1,1).data].slice(0,3);},f)).toEqual([20,80,190]);
  writeFileSync(info.outputPath('page-'+i+'.png'),Buffer.from(await canvas.evaluate(c=>c.toDataURL().split(',')[1]),'base64'));
 }
 const original=unzipSync(readFileSync('public/fixtures/'+ref.file));expect(unzipSync(readFileSync(await download(page,info,'unchanged.docx')))).toEqual(original);
 if(ref.file==='cell-anchor-flow.docx'){
  const text=await input.inputValue();await input.evaluate(el=>{el.focus();el.setSelectionRange(0,0);el.dispatchEvent(new Event('select',{bubbles:true}));});await input.press('!');await expect(input).toHaveValue('!'+text);
  const saved=await download(page,info,'edited.docx'),parts=unzipSync(readFileSync(saved));for(const [name,data] of Object.entries(original))if(name!=='word/document.xml')expect(parts[name]).toEqual(data);
  await page.getByRole('button',{name:'Undo',exact:true}).click();await expect(input).toHaveValue(text);expect(unzipSync(readFileSync(await download(page,info,'undo.docx')))).toEqual(original);
  await reopenDocx(page,input,saved,'!'+text);
 }
 expect(errors).toEqual([]);
});
