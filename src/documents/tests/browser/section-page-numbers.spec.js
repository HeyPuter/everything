import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { reopenDocx } from './helpers/reopen-docx.js';
const references=JSON.parse(readFileSync('tests/fixtures/section-page-numbers/reference.json','utf8'));
for(const [name,ref] of Object.entries(references)) test(`matches native page numbering and blank pages: ${name}`,async({page},info)=>{
  const path=`public/fixtures/${name}.docx`,bytes=readFileSync(path);
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(ref.sourceSha256);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{
    window.pageNumberPaint=[];const paint=CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText=function(text,x,y,...args){
      // Fractional sizes paint inside a translated, scaled context: record page CSS pixels.
      const m=this.getTransform(),scale=this.canvas.width/816;
      window.pageNumberPaint.push({text,x:(m.a*x+m.c*y+m.e)/scale,y:(m.b*x+m.d*y+m.f)/scale,canvas:this.canvas});return paint.call(this,text,x,y,...args);
    };
  });
  await page.goto('/playground.html');await page.getByLabel('Open DOCX file').setInputFiles(path);
  await expect(page.getByRole('textbox',{name:'Document text'})).toHaveValue(/^Roman start, page 1/);
  const input=page.getByRole('textbox',{name:'Document text'});
  await expect(input).toHaveJSProperty('readOnly',false);
  const canvases=page.locator('canvas.canvas-page');await expect(canvases).toHaveCount(ref.pages.length);
  await expect.poll(()=>page.evaluate(()=>[...document.querySelectorAll('canvas.canvas-page')].map(canvas=>{
    const drawn=new Map();for(const p of window.pageNumberPaint)if(p.canvas===canvas)drawn.set(`${p.x},${p.y}`,p);
    const text=footer=>[...drawn.values()].filter(p=>(p.y>900)===footer).sort((a,b)=>a.y-b.y||a.x-b.x).map(p=>p.text).join('').trim()||null;
    return {body:text(false),footer:text(true)};
  }))).toEqual(ref.pages);
  for(const [i,p] of ref.pages.entries())if(p.body===null){
    expect(await canvases.nth(i).evaluate(c=>{
      const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
      for(let j=0;j<d.length;j+=4)if(d[j]!==255||d[j+1]!==255||d[j+2]!==255||d[j+3]!==255)return false;return true;
    })).toBe(true);
  }
  writeFileSync(info.outputPath(`${name}.png`),Buffer.from(await canvases.nth(0).evaluate(c=>c.toDataURL().split(',')[1]),'base64'));
  const pending=page.waitForEvent('download');await page.getByRole('button',{name:'Download .docx',exact:true}).click();
  const saved=info.outputPath(`${name}.docx`);await(await pending).saveAs(saved);expect(unzipSync(readFileSync(saved))).toEqual(unzipSync(bytes));
  const original=await input.inputValue(),parts=unzipSync(bytes);
  await input.press('ControlOrMeta+Home');await page.keyboard.insertText('Edited ');
  const editedEvent=page.waitForEvent('download');await page.getByRole('button',{name:'Download .docx',exact:true}).click();
  const edited=info.outputPath('edited.docx');await(await editedEvent).saveAs(edited);
  const changed=unzipSync(readFileSync(edited));for(const part of Object.keys(parts))if(part!=='word/document.xml')expect(changed[part],part).toEqual(parts[part]);
  await input.press('ControlOrMeta+z');await expect(input).toHaveValue(original);
  const undoEvent=page.waitForEvent('download');await page.getByRole('button',{name:'Download .docx',exact:true}).click();
  const undo=info.outputPath('undo.docx');await(await undoEvent).saveAs(undo);expect(unzipSync(readFileSync(undo))).toEqual(parts);
  await reopenDocx(page,input,edited,'Edited '+original);await expect(canvases).toHaveCount(ref.pages.length);await expect(page.locator('#playground-error')).toBeEmpty();
  expect(errors).toEqual([]);
});

test('falls back before attaching an editor when duplex fillers exceed the page limit',async({page},info)=>{
  const parts=unzipSync(readFileSync('public/fixtures/section-page-numbers.docx'));
  const xml=strFromU8(parts['word/document.xml']);
  const section=xml.match(/<w:sectPr>.*?<\/w:sectPr>/)[0].replace('w:fmt="lowerRoman"','w:fmt="decimal"');
  const body=Array.from({length:101},(_,i)=>`<w:p><w:pPr>${i<100?section:''}</w:pPr><w:r><w:t>Filler page limit probe ${i+1}</w:t></w:r></w:p>`).join('')+section;
  parts['word/document.xml']=strToU8(xml.replace(/<w:body>.*<\/w:body>/,`<w:body>${body}</w:body>`));
  const bytes=Buffer.from(zipSync(parts)),inputPath=info.outputPath('filler-page-limit.docx');writeFileSync(inputPath,bytes);
  await page.goto('/playground.html');await page.getByLabel('Open DOCX file').setInputFiles(inputPath);
  const input=page.getByRole('textbox',{name:'Document text'});
  await expect(input).toHaveValue(/Filler page limit probe 101$/);await expect(input).toHaveJSProperty('readOnly',true);
  await expect.poll(()=>page.locator('canvas.canvas-page').count()).toBeGreaterThan(0);
  expect(await page.locator('canvas.canvas-page').count()).toBeLessThan(200);
  await expect(page.locator('#playground-error')).toBeEmpty();
  const pending=page.waitForEvent('download');await page.getByRole('button',{name:'Download .docx',exact:true}).click();
  const saved=info.outputPath('filler-page-limit-original.docx');await(await pending).saveAs(saved);
  expect(readFileSync(saved).equals(bytes)).toBe(true);
});
