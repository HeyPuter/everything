import {test,expect} from '@playwright/test';
import {readFileSync,writeFileSync} from 'node:fs';
import {unzipSync} from 'fflate';
import {showAllTools,onTab} from './helpers/editor-tools.js';
import {reopenDocx} from './helpers/reopen-docx.js';
const refs=JSON.parse(readFileSync('tests/fixtures/section-before-spacing/reference.json')).variants;
for(const ref of refs)test(`matches native section and explicit page spacing: ${ref.file}`,async({page},info)=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{
  window.spacingPaint=[];const original=CanvasRenderingContext2D.prototype.fillText;
  CanvasRenderingContext2D.prototype.fillText=function(text,x,y,...args){window.spacingPaint.push({text,x,y,canvas:this.canvas});return original.call(this,text,x,y,...args);};
 });
 await page.goto('/playground.html');await showAllTools(page);await page.getByLabel('Open DOCX file').setInputFiles('public/fixtures/'+ref.file);
 const input=page.getByRole('textbox',{name:'Document text'}),canvases=page.locator('canvas.canvas-page');
 await expect(input).toHaveValue(/^StartS00/);await expect(canvases).toHaveCount(18);
 const positions=()=>page.evaluate(()=>{
  const canvases=[...document.querySelectorAll('canvas.canvas-page')],values=new Map();
  for(const p of window.spacingPaint)if(canvases.includes(p.canvas)&&/^(Start|Body)S\d+$/.test(p.text))values.set(p.text,{text:p.text,page:canvases.indexOf(p.canvas)+1,baseline:p.y*.75});
  return [...values.values()];
 });
 await expect.poll(async()=> (await positions()).length).toBe(36);
 for(const row of ref.cases)for(const [prefix,key] of [['Start','startBaseline'],['Body','bodyBaseline']]){
  const p=(await positions()).find(p=>p.text===prefix+row.id);expect(p.page).toBe(row.page);expect(Math.abs(p.baseline-row[key]),row.id+' '+key).toBeLessThan(.1);
 }
 writeFileSync(info.outputPath('section-start.png'),Buffer.from(await canvases.nth(2).evaluate(c=>c.toDataURL().split(',')[1]),'base64'));
 await input.evaluate(el=>{const at=el.value.indexOf('Previous S02');el.setSelectionRange(at,at);el.dispatchEvent(new Event('select',{bubbles:true}));});
 const after=(await onTab(page,'layout')).getByRole('spinbutton',{name:'Space after paragraph (pt)',exact:true});await after.fill('8');await after.press('Tab');
 const editedBaseline=ref.cases[2].startBaseline-5;
 await expect.poll(async()=>Math.abs((await positions()).find(p=>p.text==='StartS02').baseline-editedBaseline)).toBeLessThan(.1);
 const download=page.waitForEvent('download');await page.getByRole('button',{name:'Download .docx',exact:true}).click();
 const saved=info.outputPath(ref.file);await(await download).saveAs(saved);
 const original=unzipSync(readFileSync('public/fixtures/'+ref.file)),edited=unzipSync(readFileSync(saved));
 for(const name of Object.keys(original))if(name!=='word/document.xml')expect(Buffer.from(edited[name]).equals(Buffer.from(original[name])),name).toBe(true);
 await page.getByRole('button',{name:'Undo',exact:true}).click();
 await expect.poll(async()=>Math.abs((await positions()).find(p=>p.text==='StartS02').baseline-ref.cases[2].startBaseline)).toBeLessThan(.1);
 const undoDownload=page.waitForEvent('download');await page.getByRole('button',{name:'Download .docx',exact:true}).click();
 const undo=info.outputPath('undo-'+ref.file);await(await undoDownload).saveAs(undo);const restored=unzipSync(readFileSync(undo));
 for(const name of Object.keys(original))expect(Buffer.from(restored[name]).equals(Buffer.from(original[name])),name).toBe(true);
 await reopenDocx(page,input,saved,await input.inputValue());await expect(canvases).toHaveCount(18);
 await expect.poll(async()=>Math.abs((await positions()).find(p=>p.text==='StartS02')?.baseline-editedBaseline)).toBeLessThan(.1);
 expect(errors).toEqual([]);
});
