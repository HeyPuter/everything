import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
import { reopenDocx } from './helpers/reopen-docx.js';
import { showAllTools, onTab } from './helpers/editor-tools.js';
for(const suffix of ['', '-header', '-plain']) test(`paints native drawing page fields ${suffix} and retains their sources`,async({page},info)=>{
  const header=suffix==='-header',plain=suffix==='-plain',name='shape-page-fields'+suffix,source=`public/fixtures/${name}.docx`,bytes=readFileSync(source);
  const ref=JSON.parse(readFileSync(`tests/fixtures/${name}/reference.json`));
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(ref.sourceSha256);
  expect(createHash('sha256').update(readFileSync(`tests/fixtures/${name}/native.pdf`)).digest('hex')).toBe(ref.pdfSha256);
  await page.addInitScript(()=>{
    window.paintedFields={};window.paintedFieldSizes={};const texts=new WeakMap(),bitmaps=new WeakMap(),sizes=new WeakMap(),bitmapSizes=new WeakMap();
    const text=OffscreenCanvasRenderingContext2D.prototype.fillText;
    OffscreenCanvasRenderingContext2D.prototype.fillText=function(value,...args){texts.set(this.canvas,(texts.get(this.canvas)||'')+value);sizes.set(this.canvas,Number(/([\d.]+)px/.exec(this.font)[1])*.75);return text.call(this,value,...args);};
    const transfer=OffscreenCanvas.prototype.transferToImageBitmap;
    OffscreenCanvas.prototype.transferToImageBitmap=function(){const b=transfer.call(this),value=texts.get(this);if(value){bitmaps.set(b,value);bitmapSizes.set(b,sizes.get(this));}return b;};
    const fill=CanvasRenderingContext2D.prototype.fillRect,draw=CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.fillRect=function(x,y,w,h){if(this.canvas.classList.contains('canvas-page')&&x===0&&y===0&&w>600)window.paintedFields[this.canvas.dataset.page]={};return fill.call(this,x,y,w,h);};
    CanvasRenderingContext2D.prototype.drawImage=function(bitmap,...args){
      if(this.canvas.classList.contains('canvas-page')) {const value=bitmaps.get(bitmap),m=value?.match(/^F([0-7]):\s*(\S+)$/);if(m){(window.paintedFields[this.canvas.dataset.page]||={})['F'+m[1]]=m[2];(window.paintedFieldSizes[this.canvas.dataset.page]||={})['F'+m[1]]=bitmapSizes.get(bitmap);}}
      return draw.call(this,bitmap,...args);
    };
  });
  await page.goto('/playground.html');await page.getByLabel('Open DOCX file').setInputFiles(source);
  const input=page.getByRole('textbox',{name:'Document text'});await expect(input).toHaveValue(/^Page field controls 1/);await expect(input).toHaveJSProperty('readOnly',false);
  const original=await input.inputValue();
  const check=async expected=>{await expect(page.locator('#playground-error')).toBeEmpty();await expect(page.locator('canvas.canvas-page')).toHaveCount(expected.length);const actual=await page.evaluate(()=>window.paintedFields);for(const[i,fields]of expected.entries())expect(actual[i],`page ${i+1}`).toEqual(fields);};
  const save=async suffix=>{const pending=page.waitForEvent('download');await page.getByRole('button',{name:'Download .docx',exact:true}).click();const path=info.outputPath(name+'-'+suffix+'.docx');await(await pending).saveAs(path);return path;};
  const before=unzipSync(bytes);await check(ref.pages);expect(unzipSync(readFileSync(await save('original')))).toEqual(before);
  const sizes=await page.evaluate(()=>window.paintedFieldSizes);
  for(const[i,fields]of ref.sizes.entries())for(const[key,value]of Object.entries(fields))expect(Math.abs(sizes[i][key]-value)).toBeLessThan(.1);
  await input.press('ControlOrMeta+Home');await page.keyboard.insertText('Edited ');await check(ref.pages);const editedText=await input.inputValue(),edited=await save('edited');
  for(const[n,b]of Object.entries(unzipSync(readFileSync(edited))))if(n!=='word/document.xml')expect(b).toEqual(before[n]);
  await input.press('ControlOrMeta+z');await expect(input).toHaveValue(original);await check(ref.pages);expect(unzipSync(readFileSync(await save('undo')))).toEqual(before);
  await reopenDocx(page,input,edited,editedText);await check(ref.pages);
  if(header)return;
  await input.press('ControlOrMeta+Home');await showAllTools(page);await(await onTab(page,'insert')).getByRole('button',{name:'Page break',exact:true}).click();
  const moved=ref.pages.map((p,i)=>({...p,F0:i===0?(plain?'iv':'IV'):i===1?(plain?'v':'V'):'8',F1:i===0?(plain?'iv':'IV'):i===1?(plain?'v':'V'):'8',F4:'4',F6:i<2?'3':'1'}));
  await check([{},...moved]);const movedText=await input.inputValue(),movedFile=await save('repaginated');
  await reopenDocx(page,input,movedFile,movedText);await check([{},...moved]);
});
