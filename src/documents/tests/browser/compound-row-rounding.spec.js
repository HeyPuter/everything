import {test,expect} from '@playwright/test';
import {readFileSync} from 'node:fs';
import {unzipSync} from 'fflate';
import {reopenDocx} from './helpers/reopen-docx.js';
import {paintAllPages} from './helpers/paint-pages.js';
const reference=JSON.parse(readFileSync('tests/fixtures/compound-row-rounding/reference.json','utf8'));
test('compound-border rows retain native spacing across sizes and height rules',async({page},info)=>{
 await page.addInitScript(()=>{
  window.rowPaint=new Map();const original=CanvasRenderingContext2D.prototype.fillText;
  CanvasRenderingContext2D.prototype.fillText=function(text,x,y,...rest){
   if(text.startsWith('Case ')){if(!window.rowPaint.has(this.canvas))window.rowPaint.set(this.canvas,new Map());const m=this.getTransform();window.rowPaint.get(this.canvas).set(text.replace(/\s/g,''),(m.b*x+m.d*y+m.f)/devicePixelRatio);}
   return original.call(this,text,x,y,...rest);
  };
 });
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('/playground.html');
 const available=await page.evaluate(async()=>{const{checkFontAvailability,fontAvailable}=await import('/src/engine/font-availability.js');await checkFontAvailability('Arial');return fontAvailable('Arial');});
 test.skip(!available,'Native reference uses installed Arial.');
 const source='tests/fixtures/compound-row-rounding/control.docx';await page.getByLabel('Open DOCX file').setInputFiles(source);
 const input=page.getByRole('textbox',{name:'Document text'});await expect(input).toHaveValue(/Case 15 row 9/);await expect(input).toHaveJSProperty('readOnly',false);
 await expect(page.locator('canvas.canvas-page')).toHaveCount(15);
 const check=async()=>{
  await paintAllPages(page);
  const actual=await page.evaluate(()=>[...document.querySelectorAll('canvas.canvas-page')].flatMap((c,page)=>[...(window.rowPaint.get(c)||new Map())].map(([text,y])=>({page,text,y:y*.75}))));
  expect(actual).toHaveLength(135);
  for(const w of reference.positions){const a=actual.find(a=>a.page===w.page&&a.text===w.text);expect(a).toBeDefined();expect(Math.abs(a.y-w.y),JSON.stringify({actual:a,word:w})).toBeLessThan(.2);}
 };
 await check();const original=await input.inputValue(),parts=unzipSync(readFileSync(source));
 const save=async suffix=>{const pending=page.waitForEvent('download');await page.getByRole('button',{name:'Download .docx',exact:true}).click();const path=info.outputPath(suffix+'.docx');await(await pending).saveAs(path);return path;};
 expect(unzipSync(readFileSync(await save('noedit')))).toEqual(parts);
 await input.press('ControlOrMeta+Home');await page.keyboard.insertText('Edited ');const edited=await input.inputValue(),path=await save('edited'),after=unzipSync(readFileSync(path));
 for(const[n,b]of Object.entries(parts))if(n!=='word/document.xml')expect(after[n]).toEqual(b);
 await input.press('ControlOrMeta+z');await expect(input).toHaveValue(original);await check();expect(unzipSync(readFileSync(await save('undo')))).toEqual(parts);
 await reopenDocx(page,input,path,edited);await expect(input).toHaveJSProperty('readOnly',false);expect(errors).toEqual([]);
});
