import {test,expect} from '@playwright/test';
import {readFileSync} from 'node:fs';
import {unzipSync} from 'fflate';
import {reopenDocx} from './helpers/reopen-docx.js';
const root='tests/fixtures/vertical-margin-anchors/';
for(const suffix of ['', '-legacy'])test(`top/bottom margin anchors match the native reference ${suffix}`,async({page},info)=>{
 test.setTimeout(120000);
 const source=root+`control${suffix}.docx`,parts=unzipSync(readFileSync(source));
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('/playground.html');await page.getByLabel('Open DOCX file').setInputFiles(source);
 const input=page.getByRole('textbox',{name:'Document text'});await expect(input).toHaveValue(/^topMargin/);await expect(input).toHaveJSProperty('readOnly',false);
 const check=async()=>{
  await expect(page.locator('canvas.canvas-page')).toHaveCount(18);
  for(let i=0;i<18;i++){
   const result=await page.locator('canvas.canvas-page').nth(i).evaluate(async(c,png)=>{
    // A page far from the view gives up its pixels in a long document; asking for its context paints it again.
    c.getContext('2d');
    const im=new Image();im.src='data:image/png;base64,'+png;await im.decode();
    const native=document.createElement('canvas');native.width=im.width;native.height=im.height;native.getContext('2d').drawImage(im,0,0);
    if(c.width!==im.width||c.height!==im.height)throw Error('Reference size mismatch');
    const w=c.width,h=c.height;
    const mask=context=>{const data=context.getImageData(0,0,w,h).data,m=new Uint8Array(w*h);for(let j=0;j<m.length;j++)m[j]=data[j*4+2]>data[j*4]+80&&data[j*4+2]>data[j*4+1]+60?1:0;return m;};
    const a=mask(c.getContext('2d')),b=mask(native.getContext('2d'));
    const compare=(from,to)=>{let count=0,miss=0;for(let j=0;j<from.length;j++)if(from[j]){count++;const x=j%w,y=Math.floor(j/w);let found=false;for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)if(x+dx>=0&&x+dx<w&&y+dy>=0&&y+dy<h&&to[j+dy*w+dx])found=true;if(!found)miss++;}return {count,miss};};
    return [compare(a,b),compare(b,a)];
   },readFileSync(root+`native${suffix}-page${i+1}.png`).toString('base64'));
   const visible=true;
   for(const item of result){expect(item.miss).toBe(0);if(visible)expect(item.count).toBeGreaterThan(4000);else expect(item.count).toBe(0);}
  }
 };
 await check();const original=await input.inputValue();
 const save=async name=>{const event=page.waitForEvent('download');await page.getByRole('button',{name:'Download .docx',exact:true}).click();const path=info.outputPath(name+'.docx');await(await event).saveAs(path);return path;};
 const exact=path=>{const out=unzipSync(readFileSync(path));expect(Object.keys(out).sort()).toEqual(Object.keys(parts).sort());for(const[n,b]of Object.entries(parts))expect(Buffer.from(out[n]).equals(Buffer.from(b)),n).toBe(true);};
 exact(await save('noedit'));
 await input.evaluate(el=>{const at=el.value.indexOf('Anchor cell');el.focus();el.setSelectionRange(at,at);el.dispatchEvent(new Event('select'));});await page.keyboard.insertText('Edited ');
 const edited=await input.inputValue(),path=await save('edited');await check();
 const out=unzipSync(readFileSync(path));for(const[n,b]of Object.entries(parts))if(n!=='word/document.xml')expect(Buffer.from(out[n]).equals(Buffer.from(b)),n).toBe(true);
 await input.press('ControlOrMeta+z');await expect(input).toHaveValue(original);exact(await save('undo'));
 await reopenDocx(page,input,path,edited);await check();expect(errors).toEqual([]);
});
