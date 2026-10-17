import { test, expect } from '@playwright/test';
import { readFileSync,writeFileSync } from 'node:fs';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { reopenDocx } from './helpers/reopen-docx.js';
async function blueBounds(canvas) {
 return canvas.evaluate(el=>{
  const {width,height}=el,d=el.getContext('2d').getImageData(0,0,width,height).data;
  let l=width,t=height,r=-1,b=-1;
  for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
   const i=(y*width+x)*4;
   if(d[i]<40&&d[i+1]>60&&d[i+1]<100&&d[i+2]>170&&d[i+2]<210) {l=Math.min(l,x);t=Math.min(t,y);r=Math.max(r,x);b=Math.max(b,y);}
  }
  return r<0?null:[l,t,r+1,b+1].map(v=>v*576/width);
 });
}
test('preserves neighboring table artwork when one cell anchor cannot be laid out',async({page},info)=>{
 test.setTimeout(120000);
 const parts=unzipSync(readFileSync('public/fixtures/table-global-anchors.docx'));
 const original=strFromU8(parts['word/document.xml']);
 // Numeric page X with paragraph Y is laid out in cells now; an aligned X with paragraph Y is still guarded.
 const changed=original.replace(/(<wp:positionV\b[^>]*relativeFrom=")[^"]+/, '$1paragraph').replace(/(<wp:positionH\b[^>]*>)<wp:posOffset>[^<]*<\/wp:posOffset>/, '$1<wp:align>center</wp:align>');
 expect(changed).not.toBe(original);parts['word/document.xml']=strToU8(changed);
 const source=Buffer.from(zipSync(parts));writeFileSync(info.outputPath('mixed-anchor-source.docx'),source);
 await page.goto('/playground.html');await page.getByLabel('Open DOCX file').setInputFiles({name:'mixed-anchor.docx',mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',buffer:source});
 const input=page.getByRole('textbox',{name:'Document text'}),canvases=page.locator('canvas.canvas-page');
 await expect(input).toHaveValue(/^Cell anchor 1/);await expect(input).toHaveJSProperty('readOnly',true);
 await expect(canvases).toHaveCount(22);await expect(page.locator('#playground-error')).toBeEmpty();
 expect(await blueBounds(canvases.first())).toBeNull();
 await canvases.nth(1).scrollIntoViewIfNeeded();
 await expect.poll(()=>blueBounds(canvases.nth(1))).not.toBeNull();
 const pending=page.waitForEvent('download');await page.getByRole('button',{name:'Download .docx',exact:true}).click();
 const path=info.outputPath('mixed-anchor-original.docx');await(await pending).saveAs(path);
 const downloaded=unzipSync(readFileSync(path));
 for(const name of Object.keys(parts))expect(Buffer.from(downloaded[name]).equals(Buffer.from(parts[name])),name).toBe(true);
});
for(const family of ['table-global-anchors','table-relative-anchors','relative-group-anchors','relative-body-anchors'])for(const suffix of (family.startsWith('table-') ? ['', '-legacy'] : ['']))test(`renders native table page/margin anchors and preserves edits ${family}${suffix}`,async({page},info)=>{
 test.setTimeout(120000);
 const name=`${family}${suffix}.docx`,source=`public/fixtures/${name}`;
 const reference=JSON.parse(readFileSync(`tests/fixtures/${family}/reference${suffix}.json`));
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('/playground.html');await page.getByLabel('Open DOCX file').setInputFiles(source);
 const input=page.getByRole('textbox',{name:'Document text'}),canvases=page.locator('canvas.canvas-page');
 await expect(input).toHaveValue(/^Cell anchor 1/);await expect(input).toBeEditable();await expect(canvases).toHaveCount(reference.cases.length);
 await expect(page.locator('#playground-error')).toBeEmpty();const original=await input.inputValue();
 for(let i=0;i<reference.cases.length;i++){
  const canvas=canvases.nth(i);await canvas.scrollIntoViewIfNeeded();
  const ref=reference.cases[i].ink;
  await expect.poll(async()=>{
   const actual=await blueBounds(canvas);
   return ref===null?actual===null:actual!==null&&actual.every((v,j)=>Math.abs(v-ref[j])<1.1);
  },{message:`native blue ink page ${i+1}`}).toBe(true);
 }
 await input.press('ControlOrMeta+Home');await page.keyboard.insertText('Edited ');
 const at=(await input.inputValue()).indexOf('Anchor cell');
 await input.evaluate((el,at)=>{el.focus();el.setSelectionRange(at,at);el.dispatchEvent(new Event('select',{bubbles:true}));},at);
 await page.keyboard.insertText('Cell ');
 const edited=await input.inputValue();
 const save=async name=>{const pending=page.waitForEvent('download');await page.getByRole('button',{name:'Download .docx',exact:true}).click();const path=info.outputPath(name);await(await pending).saveAs(path);return path;};
 const path=await save(name);
 await page.getByRole('button',{name:'Undo',exact:true}).click();await page.getByRole('button',{name:'Undo',exact:true}).click();await expect(input).toHaveValue(original);
 expect(unzipSync(readFileSync(await save('undo-'+name)))).toEqual(unzipSync(readFileSync(source)));
 await reopenDocx(page,input,path,edited);await expect(input).toBeEditable();await expect(canvases).toHaveCount(reference.cases.length);
 await canvases.nth(Math.min(20,reference.cases.length-1)).scrollIntoViewIfNeeded();await expect.poll(()=>blueBounds(canvases.nth(Math.min(20,reference.cases.length-1)))).not.toBeNull();
 writeFileSync(info.outputPath('overflow.png'),Buffer.from((await canvases.nth(Math.min(20,reference.cases.length-1)).evaluate(el=>el.toDataURL())).split(',')[1],'base64'));
 expect(errors).toEqual([]);
});
