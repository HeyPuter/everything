import {test,expect} from '@playwright/test';
import {readFileSync} from 'node:fs';
import {unzipSync} from 'fflate';
import {reopenDocx} from './helpers/reopen-docx.js';
import {paintAllPages} from './helpers/paint-pages.js';
const reference={...JSON.parse(readFileSync('tests/fixtures/row-border-insets/positions.json','utf8')),
 ...JSON.parse(readFileSync('tests/fixtures/compound-row-insets/positions.json','utf8'))};
for(const name of Object.keys(reference)) test(`${name}: native row positions, edit, undo and reopen`,async({page},info)=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{window.rowPaint=new Map();const original=CanvasRenderingContext2D.prototype.fillText;
 CanvasRenderingContext2D.prototype.fillText=function(text,x,y,...rest){if(['Lead','Header','Body','Last','After'].includes(text)){if(!window.rowPaint.has(this.canvas))window.rowPaint.set(this.canvas,new Map());window.rowPaint.get(this.canvas).set(text,y);}return original.call(this,text,x,y,...rest);};});
 await page.goto('/playground.html');
 const available=await page.evaluate(async()=>{const {checkFontAvailability,fontAvailable}=await import('/src/engine/font-availability.js');await checkFontAvailability('Arial');return fontAvailable('Arial');});
 test.skip(!available,'Native reference requires installed Arial.');
 const fixture=`public/fixtures/${name}.docx`;
 await page.getByLabel('Open DOCX file').setInputFiles(fixture);
 const input=page.getByRole('textbox',{name:'Document text'});await expect(input).toHaveValue(/^Lead/);await expect(input).toHaveJSProperty('readOnly',false);
 const check=async()=>{
  await paintAllPages(page);
  const actual=await page.evaluate(()=>[...document.querySelectorAll('canvas.canvas-page')].flatMap((canvas,page)=>[...(window.rowPaint.get(canvas)||new Map())].map(([text,y])=>({page,text,y:y*.75}))));
  for(const w of reference[name]){const a=actual.find(a=>a.page===w.page&&a.text===w.text);expect(a).toBeDefined();expect(Math.abs(a.y-w.y),JSON.stringify({actual:a,word:w})).toBeLessThan(.2);}
 };
 await check();const text=await input.inputValue();await input.press('ControlOrMeta+Home');await page.keyboard.insertText('Edited ');
 const download=async suffix=>{const pending=page.waitForEvent('download');await page.getByRole('button',{name:'Download .docx',exact:true}).click();const path=info.outputPath(name+suffix+'.docx');await(await pending).saveAs(path);return path;};
 const saved=await download(''),source=unzipSync(readFileSync(fixture)),edited=unzipSync(readFileSync(saved));
 expect(Object.keys(edited).sort()).toEqual(Object.keys(source).sort());for(const part of Object.keys(source))if(part!=='word/document.xml')expect(Buffer.from(edited[part]).equals(Buffer.from(source[part])),part).toBe(true);
 await input.press('ControlOrMeta+z');await expect(input).toHaveValue(text);await check();
 const undo=unzipSync(readFileSync(await download('-undo')));for(const part of Object.keys(source))expect(Buffer.from(undo[part]).equals(Buffer.from(source[part])),part).toBe(true);
 await reopenDocx(page,input,saved,'Edited '+text);expect(errors).toEqual([]);
});
