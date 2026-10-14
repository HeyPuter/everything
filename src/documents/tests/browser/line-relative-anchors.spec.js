import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
import { reopenDocx } from './helpers/reopen-docx.js';
test('matches native line-relative anchor origins through selection, body editing, reopen and undo',async({page},info)=>{
 const source='tests/fixtures/line-relative-anchors/control.docx',bytes=readFileSync(source);
 const ref=JSON.parse(readFileSync('tests/fixtures/line-relative-anchors/reference.json'));
 expect(createHash('sha256').update(bytes).digest('hex')).toBe(ref.sourceSha256);
 expect(createHash('sha256').update(readFileSync('tests/fixtures/line-relative-anchors/native.pdf')).digest('hex')).toBe(ref.pdfSha256);
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('/playground.html');await page.getByLabel('Open DOCX file').setInputFiles(source);
 const input=page.getByRole('textbox',{name:'Document text'}),canvases=page.locator('canvas.canvas-page');
 await expect(input).toHaveValue(/^First line/);await expect(input).toHaveJSProperty('readOnly',false);const original=await input.inputValue();
 const check=async()=>{
  await expect(canvases).toHaveCount(ref.bounds.length);await expect(page.locator('#playground-error')).toBeEmpty();
  const bounds=await canvases.evaluateAll(cs=>cs.map(c=>{
   const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let l=c.width,t=c.height,r=-1,b=-1;
   for(let y=0;y<c.height;y++)for(let x=0;x<c.width;x++){const i=(y*c.width+x)*4;if(d[i]===20&&d[i+1]===80&&d[i+2]===190){l=Math.min(l,x);t=Math.min(t,y);r=Math.max(r,x);b=Math.max(b,y);}}
   return [l,t,r-l+1,b-t+1].map(v=>v*612/c.width);
  }));
  bounds.forEach((box,i)=>box.forEach((v,j)=>expect(Math.abs(v-ref.bounds[i][j]),`page ${i+1}, coordinate ${j}`).toBeLessThan(.8)));
 };
 const save=async suffix=>{const wait=page.waitForEvent('download');await page.getByRole('button',{name:'Download .docx',exact:true}).click();const path=info.outputPath('line-relative-anchors-'+suffix+'.docx');await(await wait).saveAs(path);return path;};
 await check();
 expect(unzipSync(readFileSync(await save('noedit')))).toEqual(unzipSync(bytes));
 const c=canvases.nth(1);await c.evaluate(el=>{const host=el.closest('.canvas-host');host.scrollTop=el.offsetTop+105*4/3-host.clientHeight/2;});const rect=await c.boundingBox();await page.mouse.click(rect.x+390/612*rect.width,rect.y+105/792*rect.height);
 await expect.poll(()=>input.evaluate(e=>e.value.slice(e.selectionStart,e.selectionEnd))).toBe('\ufffc');
 await input.press('Backspace');await input.press('ControlOrMeta+z');await expect(input).toHaveValue(original);
 // Arrow keys nudge a selected floating drawing (docs/parity/pictures.md); End leaves it in place and collapses the selection.
 await input.press('End');await check();
 await input.press('ControlOrMeta+Home');await page.keyboard.insertText('Edited ');await check();const editedText=await input.inputValue(),edited=await save('edited');
 const parts=unzipSync(bytes);for(const[n,b]of Object.entries(unzipSync(readFileSync(edited))))if(n!=='word/document.xml')expect(b).toEqual(parts[n]);
 await input.press('ControlOrMeta+z');await expect(input).toHaveValue(original);expect(unzipSync(readFileSync(await save('undo')))).toEqual(parts);
 await reopenDocx(page,input,edited,editedText);await check();expect(errors).toEqual([]);
});

