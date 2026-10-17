import {test,expect} from '@playwright/test';
import {readFileSync} from 'node:fs';
import {unzipSync} from 'fflate';
import {reopenDocx} from './helpers/reopen-docx.js';

const pixels=page=>page.locator('canvas.canvas-page').evaluateAll(async canvases=>Promise.all(canvases.map(async c=>({width:c.width,height:c.height,hash:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',c.getContext('2d').getImageData(0,0,c.width,c.height).data))).map(b=>b.toString(16).padStart(2,'0')).join('')}))));
// Spelling as you type marks words on screen shortly after an edit and on opening, so the pixels
// captured right after an edit and after reopening would differ by those marks alone. These checks
// compare section repainting, so they turn the screen-only spelling marks off.
test.beforeEach(async({page})=>{await page.addInitScript(()=>{try{localStorage.setItem('documents:spellcheck','off');}catch{}});});
const select=async(input,start,end=start)=>input.evaluate((el,[a,b])=>{el.focus();el.setSelectionRange(a,b);el.dispatchEvent(new Event('select',{bubbles:true}));},[start,end]);

test('first-cell Backspace preserves section pages, native caret, export and exact undo',async({page},info)=>{
 test.setTimeout(180000);
 const source='tests/fixtures/section-editing/boundary-table.docx',errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('/playground.html');const input=page.getByRole('textbox',{name:'Document text',exact:true}),previous=await input.elementHandle();
 await page.getByLabel('Open DOCX file').setInputFiles(source);await expect.poll(()=>previous.evaluate(e=>e.isConnected)).toBe(false);await previous.dispose();
 await expect(input).toHaveJSProperty('readOnly',false);await expect(page.locator('canvas.canvas-page')).toHaveCount(3);
 const original=await input.inputValue();await select(input,27);await input.evaluate(el=>el.blur());const before=await pixels(page);
 await input.press('Backspace');const text=original.slice(0,25)+original.slice(26);await expect(input).toHaveValue(text);
 await expect(input).toHaveJSProperty('selectionStart',25);await expect(page.locator('canvas.canvas-page')).toHaveCount(3);
 await input.evaluate(el=>el.blur());const editedPixels=await pixels(page);
 const download=async name=>{const pending=page.waitForEvent('download');await page.getByRole('button',{name:'Download .docx',exact:true}).click();const path=info.outputPath(name);await(await pending).saveAs(path);return path;};
 const exported=await download('backspace.docx'),parts=unzipSync(readFileSync(exported));
 for(const[name,bytes]of Object.entries(unzipSync(readFileSync(source))))if(name!=='word/document.xml')expect(parts[name],name).toEqual(bytes);
 await input.press('ControlOrMeta+z');await expect(input).toHaveValue(original);await expect(input).toHaveJSProperty('selectionStart',27);
 await input.evaluate(el=>el.blur());expect(await pixels(page)).toEqual(before);expect(unzipSync(readFileSync(await download('backspace-undo.docx')))).toEqual(unzipSync(readFileSync(source)));
 await input.press('ControlOrMeta+Shift+z');await expect(input).toHaveValue(text);await input.evaluate(el=>el.blur());expect(await pixels(page)).toEqual(editedPixels);
 await reopenDocx(page,input,exported,text);await input.evaluate(el=>el.blur());expect(await pixels(page)).toEqual(editedPixels);
 expect(errors).toEqual([]);await expect(page.locator('#playground-error')).toBeEmpty();await expect(page.locator('.canvas-message-error')).toHaveCount(0);
});

for(const fixture of ['formats','inheritance','implicit-final','table','boundary-table'])test(`section editing repaints ${fixture} stories, saves, reopens and undoes exactly`,async({page},info)=>{
 test.setTimeout(180000);
 const source=`tests/fixtures/section-editing/${fixture}.docx`,errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('/playground.html');
 const input=page.getByRole('textbox',{name:'Document text',exact:true}),previous=await input.elementHandle();
 await page.getByLabel('Open DOCX file').setInputFiles(source);await expect.poll(()=>previous.evaluate(e=>e.isConnected)).toBe(false);await previous.dispose();
 await expect(input).toHaveJSProperty('readOnly',false);await expect(page.locator('canvas.canvas-page')).toHaveCount(3);
 const original=await input.inputValue();let before;
 const download=async name=>{const pending=page.waitForEvent('download');await page.getByRole('button',{name:'Download .docx',exact:true}).click();const path=info.outputPath(name);await(await pending).saveAs(path);return path;};
 if(fixture==='table'){
  const end=original.indexOf('Echo final')+2;await select(input,24,end);await input.evaluate(el=>el.blur());before=await pixels(page);await input.focus();await page.keyboard.insertText('Edited');await expect(input).toHaveValue(original.slice(0,24)+'Edited'+original.slice(end));
 }else{
  await select(input,26);await input.evaluate(el=>el.blur());before=await pixels(page);await input.press('Delete');await expect(input).toHaveValue(original.slice(0,26)+original.slice(27));
 }
 await expect(page.locator('canvas.canvas-page')).toHaveCount(fixture==='table'?1:2);
 await input.evaluate(el=>el.blur());const editedPixels=await pixels(page),text=await input.inputValue();
 if(fixture!=='table')expect(editedPixels[0].width).toBeGreaterThan(editedPixels[0].height);
 const exported=await download('edited.docx');
 await input.press('ControlOrMeta+z');await expect(input).toHaveValue(original);await input.evaluate(el=>el.blur());expect(await pixels(page)).toEqual(before);
 expect(unzipSync(readFileSync(await download('undo.docx')))).toEqual(unzipSync(readFileSync(source)));
 await input.press('ControlOrMeta+Shift+z');await expect(input).toHaveValue(text);await input.evaluate(el=>el.blur());expect(await pixels(page)).toEqual(editedPixels);
 await reopenDocx(page,input,exported,text);await input.evaluate(el=>el.blur());expect(await pixels(page)).toEqual(editedPixels);
 expect(errors).toEqual([]);await expect(page.locator('#playground-error')).toBeEmpty();await expect(page.locator('.canvas-message-error')).toHaveCount(0);
});
