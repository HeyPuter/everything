import {test,expect} from '@playwright/test';
import {readFileSync} from 'node:fs';
import {unzipSync} from 'fflate';
import {reopenDocx} from './helpers/reopen-docx.js';
// 10pt is 13.3333px. The bundled fallback face paints at that size exactly; an installed face with
// fractional advances paints at the size rounded up to 0.01px (13.34px) under a compensating scale
// (fractionalTextScale), so compare the painted size rather than the font string.
const px=font=>font===undefined?NaN:parseFloat(/([\d.]+)px/.exec(font)[1]);
test('imports unspecified text at the native default size while retaining edits and explicit sizes',async({page},info)=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{window.sizePaint={};const original=CanvasRenderingContext2D.prototype.fillText;CanvasRenderingContext2D.prototype.fillText=function(text,...args){window.sizePaint[text]=this.font;return original.call(this,text,...args);};});
 await page.goto('/playground.html');const fixture='public/fixtures/default-run-size.docx';await page.getByLabel('Open DOCX file').setInputFiles(fixture);
 const input=page.getByRole('textbox',{name:'Document text'});await expect(input).toHaveValue(/^Unspecified Sample text/);await expect(input).toHaveJSProperty('readOnly',false);
 await expect.poll(()=>page.evaluate(()=>window.sizePaint['Unspecified Sample text']).then(px)).toBeCloseTo(40/3,1);
 const fonts=await page.evaluate(()=>window.sizePaint);expect(fonts['Explicit10 Sample text']).toBe(fonts['Unspecified Sample text']);expect(fonts['Explicit12 Sample text']).toContain('16px');
 const original=await input.inputValue();const source=unzipSync(readFileSync(fixture));
 const download=async label=>{const pending=page.waitForEvent('download');await page.getByRole('button',{name:'Download .docx',exact:true}).click();const path=info.outputPath(label+'.docx');await(await pending).saveAs(path);return path;};
 const same=file=>{const actual=unzipSync(readFileSync(file));expect(Object.keys(actual).sort()).toEqual(Object.keys(source).sort());for(const n of Object.keys(source))expect(Buffer.from(actual[n]).equals(Buffer.from(source[n])),n).toBe(true);};
 same(await download('noedit'));await input.focus();await input.press('ControlOrMeta+Home');await page.keyboard.insertText('Edited ');const edited=await download('edited');const parts=unzipSync(readFileSync(edited));for(const n of Object.keys(source))if(n!=='word/document.xml')expect(Buffer.from(parts[n]).equals(Buffer.from(source[n])),n).toBe(true);
 await input.press('ControlOrMeta+z');await expect(input).toHaveValue(original);same(await download('undo'));await reopenDocx(page,input,edited,'Edited '+original);await expect.poll(()=>page.evaluate(()=>window.sizePaint['Edited Unspecified Sample text']).then(px)).toBeCloseTo(40/3,1);expect(errors).toEqual([]);
});
