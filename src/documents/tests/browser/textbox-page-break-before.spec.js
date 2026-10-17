import {test,expect} from '@playwright/test';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {unzipSync} from 'fflate';
import {reopenDocx} from './helpers/reopen-docx.js';
import {expectBodyEditParts} from './helpers/expect-body-edit-parts.js';
const root='tests/fixtures/textbox-page-break-before/';
test('unlinked text-frame paragraph breaks match the native reference and survive body editing',async({page},info)=>{
 test.setTimeout(120000);const bytes=readFileSync(root+'control.docx'),ref=JSON.parse(readFileSync(root+'reference.json'));
 const hash=b=>createHash('sha256').update(b).digest('hex');expect(hash(bytes)).toBe(ref.sourceSha256);expect(hash(readFileSync(root+'native-verified.pdf'))).toBe(ref.pdfSha256);
 await page.goto('/playground.html');await page.getByLabel('Open DOCX file').setInputFiles(root+'control.docx');const input=page.getByRole('textbox',{name:'Document text'});await expect(input).toBeEditable();
 const check=async()=>{
  await expect(page.locator('canvas.canvas-page')).toHaveCount(7);
  for(let i=0;i<7;i++){
   const actual=await page.locator('canvas.canvas-page').nth(i).evaluate(c=>{
    const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let l=c.width,t=c.height,r=-1,b=-1;const rows=[];
    for(let y=0;y<c.height;y++){let ink=false;for(let x=0;x<c.width;x++){const k=(y*c.width+x)*4;if(d[k]-d[k+1]>40&&d[k]-d[k+2]>30){l=Math.min(l,x);r=Math.max(r,x);t=Math.min(t,y);b=Math.max(b,y);ink=true;}}if(ink)rows.push(y);}
    const bands=[];for(const y of rows){if(!bands.length||y>bands.at(-1)[1])bands.push([y,y+1]);else bands.at(-1)[1]=y+1;}
    const scale=612/c.width;return {ink:[l,t,r+1,b+1].map(v=>v*scale),bands:bands.map(a=>a.map(v=>v*scale))};
   });
   for(let k=0;k<4;k++)expect(Math.abs(actual.ink[k]-ref.pages[i].ink[k]),`page ${i+1} ink ${k}`).toBeLessThan(1.1);
   expect(actual.bands).toHaveLength(3);for(let j=0;j<3;j++)for(let k=0;k<2;k++)expect(Math.abs(actual.bands[j][k]-ref.pages[i].bands[j][k])).toBeLessThan(1.1);
  }
 };
 await check();const original=await input.inputValue(),parts=unzipSync(bytes);
 const save=async n=>{const pending=page.waitForEvent('download');await page.getByRole('button',{name:'Download .docx',exact:true}).click();const path=info.outputPath(n+'.docx');await(await pending).saveAs(path);return path;};
 expect(unzipSync(readFileSync(await save('noedit')))).toEqual(parts);
 await input.press('ControlOrMeta+Home');await page.keyboard.insertText('Edited ');const edited=await save('edited');expectBodyEditParts(unzipSync(readFileSync(edited)),parts);
 await input.press('ControlOrMeta+z');await expect(input).toHaveValue(original);expect(unzipSync(readFileSync(await save('undo')))).toEqual(parts);await check();
 await reopenDocx(page,input,edited,'Edited '+original);await expect(input).toBeEditable();await check();
});

// Oversized body lines now open editable, one fresh page per line (docs/conformance.md,
// "Oversized body text and physical-page editing bounds"), instead of a read-only fallback.
test('retains fonts and pagination for oversized body lines, which open editable',async({page},info)=>{
 const source=root+'oversized-body.docx';await page.goto('/playground.html');await page.getByLabel('Open DOCX file').setInputFiles(source);
 const input=page.getByRole('textbox',{name:'Document text'});await expect(input).toHaveJSProperty('readOnly',false);await expect(input).toHaveValue('A\nB');await expect(page.locator('canvas.canvas-page')).toHaveCount(2);
 const ref=JSON.parse(readFileSync(root+'oversized-reference.json')),hash=b=>createHash('sha256').update(b).digest('hex');expect(hash(readFileSync(source))).toBe(ref.sourceSha256);expect(hash(readFileSync(root+'oversized-native.pdf'))).toBe(ref.pdfSha256);
 const bounds=await page.locator('canvas.canvas-page').evaluateAll(cs=>cs.map(c=>{const a=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let l=c.width,r=-1,t=c.height,b=-1;for(let i=0;i<a.length;i+=4)if(a[i]-a[i+1]>40&&a[i]-a[i+2]>30){const x=(i/4)%c.width,y=Math.floor(i/4/c.width);l=Math.min(l,x);r=Math.max(r,x);t=Math.min(t,y);b=Math.max(b,y);}return [l,t,r+1,b+1].map(v=>v*612/c.width);}));for(let i=0;i<2;i++)for(let k=0;k<4;k++)expect(Math.abs(bounds[i][k]-ref.pages[i].ink[k])).toBeLessThan(1.1);
 const pending=page.waitForEvent('download');await page.getByRole('button',{name:'Download .docx',exact:true}).click();const path=info.outputPath('oversized-noedit.docx');await(await pending).saveAs(path);expect(unzipSync(readFileSync(path))).toEqual(unzipSync(readFileSync(source)));
});
