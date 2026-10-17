import {test,expect} from '@playwright/test';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {unzipSync} from 'fflate';
import {showAllTools} from './helpers/editor-tools.js';
import {reopenDocx} from './helpers/reopen-docx.js';
// Match the native recorder's 2 pixels per point, including the 1 pt glyph.
test.use({deviceScaleFactor:1.5});
test('large fonts match the native reference and support direct/style edits, export and exact undo',async({page},info)=>{
 test.setTimeout(180000);
 const root='tests/fixtures/large-fonts/',source=root+'control.docx',bytes=readFileSync(source),ref=JSON.parse(readFileSync(root+'reference.json'));
 const hash=b=>createHash('sha256').update(b).digest('hex');expect(hash(bytes)).toBe(ref.sourceSha256);expect(hash(readFileSync(root+'native-verified.pdf'))).toBe(ref.pdfSha256);
 const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('/playground.html');await showAllTools(page);await page.getByLabel('Open DOCX file').setInputFiles(source);
 const input=page.getByRole('textbox',{name:'Document text'}),size=page.getByRole('spinbutton',{name:'Font size (pt)',exact:true});await expect(input).toBeEditable();await expect(page.locator('canvas.canvas-page')).toHaveCount(9);await expect(size).toHaveAttribute('max','1638');
 const bounds=async i=>page.locator('canvas.canvas-page').nth(i).evaluate(c=>{
  const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let l=c.width,t=c.height,r=-1,b=-1;
  for(let y=0;y<c.height;y++)for(let x=0;x<c.width;x++){const k=(y*c.width+x)*4;if(d[k]-d[k+1]>40&&d[k]-d[k+2]>30){l=Math.min(l,x);t=Math.min(t,y);r=Math.max(r,x);b=Math.max(b,y);}}
  const scale=1584/c.width;return r<0?null:[l,t,r+1,b+1].map(v=>v*scale);
 });
 for(let i=0;i<9;i++){const actual=await bounds(i),native=ref.pages[i].ink;expect(actual,`glyph on page ${i+1}`).not.toBeNull();expect(native).not.toBeNull();for(let k=0;k<4;k++)expect(Math.abs(actual[k]-native[k]),`page ${i+1}, bound ${k}`).toBeLessThan(1.1);}
 const original=await input.inputValue(),parts=unzipSync(bytes),first=original.indexOf('\nA\n')+1;
 const select=async at=>{await input.focus();await input.evaluate((el,at)=>{el.setSelectionRange(at,at+1);el.dispatchEvent(new Event('select',{bubbles:true}));},at);};
 const save=async name=>{const pending=page.waitForEvent('download');await page.getByRole('button',{name:'Download .docx',exact:true}).click();const path=info.outputPath(name+'.docx');await(await pending).saveAs(path);return path;};
 expect(unzipSync(readFileSync(await save('noedit')))).toEqual(parts);
 await select(first);await expect(size).toHaveValue('1');await size.fill('650.5');await size.press('Tab');await expect(size).toHaveValue('650.5');
 const changed=await bounds(0);expect(changed[2]-changed[0]).toBeGreaterThan(400);
 const edited=await save('edited'),out=unzipSync(readFileSync(edited));for(const[n,b]of Object.entries(parts))if(n!=='word/document.xml')expect(out[n],n).toEqual(b);
 await page.getByRole('button',{name:'Undo',exact:true}).click();await expect(size).toHaveValue('1');const restored=await bounds(0);expect(restored[2]-restored[0]).toBeLessThan(3);
 expect(unzipSync(readFileSync(await save('undo')))).toEqual(parts);await reopenDocx(page,input,edited,original);await select(first);await expect(size).toHaveValue('650.5');await expect(page.locator('canvas.canvas-page')).toHaveCount(9);expect(errors).toEqual([]);
});

test('edits a character style above 200 pt and preserves it on export and reopen',async({page},info)=>{
 await page.goto('/playground.html');await showAllTools(page);await page.getByLabel('Open DOCX file').setInputFiles('tests/fixtures/large-fonts/body-control.docx');
 const input=page.getByRole('textbox',{name:'Document text'}),size=page.getByRole('spinbutton',{name:'Font size (pt)',exact:true});
 const select=async()=>input.evaluate(el=>{const at=el.value.indexOf('Large font: inherited\n')+'Large font: inherited\n'.length;el.setSelectionRange(at,at+1);el.dispatchEvent(new Event('select',{bubbles:true}));});
 // Wait for the fixture itself: the playground's sample document is editable before it is replaced.
 await expect(input).toHaveValue(/Large font: inherited\n/);await expect(input).toBeEditable();await select();await page.getByRole('button',{name:'Edit character style',exact:true}).click();
 const styleSize=page.getByRole('spinbutton',{name:'Style font size (pt)',exact:true});await expect(styleSize).toHaveAttribute('max','1638');await styleSize.fill('650.5');await page.getByRole('button',{name:'Apply',exact:true}).click();await expect(size).toHaveValue('650.5');
 const pending=page.waitForEvent('download');await page.getByRole('button',{name:'Download .docx',exact:true}).click();const path=info.outputPath('style.docx');await(await pending).saveAs(path);
 const original=await input.inputValue();await page.getByRole('button',{name:'Undo',exact:true}).click();await expect(size).toHaveValue('650');
 await reopenDocx(page,input,path,original);await select();await expect(size).toHaveValue('650.5');
});
