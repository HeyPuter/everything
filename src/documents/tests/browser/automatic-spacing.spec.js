import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { unzipSync } from 'fflate';
import { reopenDocx } from './helpers/reopen-docx.js';
const refs = JSON.parse(readFileSync('tests/fixtures/automatic-spacing/reference.json'));
async function download(page, info, name) {
  const event=page.waitForEvent('download'); await page.getByRole('button',{name:'Download .docx',exact:true}).click();
  const path=info.outputPath(name);await (await event).saveAs(path);return path;
}
for (const ref of refs) test('paints native automatic spacing: '+ref.file, async ({page},info)=>{
  await page.addInitScript(()=>{
    window.spacingPaint={}; const original=CanvasRenderingContext2D.prototype.fillText;
    // Text can be painted at the origin of a translated, scaled context; record the page position.
    CanvasRenderingContext2D.prototype.fillText=function(text,x,y,...rest){const m=this.getTransform();window.spacingPaint[text]={x:m.a*x+m.c*y+m.e,y:m.b*x+m.d*y+m.f};return original.call(this,text,x,y,...rest);};
  });
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('/playground.html');await page.getByLabel('Open DOCX file').setInputFiles('public/fixtures/'+ref.file);
  const input=page.getByRole('textbox',{name:'Document text'});
  await expect(input).toBeEditable();await expect(input).toHaveValue(new RegExp('^'+ref.pages[0][0].text));
  await expect(page.locator('canvas.canvas-page')).toHaveCount(ref.pages.length);
  for (const [index,lines] of ref.pages.entries()) {
    const labels=lines.filter(l=>/[A-Za-z]/.test(l.text));
    await expect.poll(()=>page.evaluate(text=>!!window.spacingPaint[text],labels.at(-1).text)).toBe(true);
    const paint=await page.evaluate(()=>window.spacingPaint),first=labels[0];
    for(const line of labels) expect(Math.abs((paint[line.text].y-paint[first.text].y)*.75-(line.baseline-first.baseline)),line.text).toBeLessThan(.3);
    const png=await page.locator('canvas.canvas-page').nth(index).evaluate(c=>c.toDataURL().split(',')[1]);
    writeFileSync(info.outputPath('page-'+(index+1)+'.png'),Buffer.from(png,'base64'));
  }
  const original=unzipSync(readFileSync('public/fixtures/'+ref.file));
  expect(unzipSync(readFileSync(await download(page,info,'unchanged.docx')))).toEqual(original);
  if(ref.file==='automatic-spacing-modern.docx') {
    const text=await input.inputValue();await input.evaluate(el=>{el.focus();el.setSelectionRange(0,0);el.dispatchEvent(new Event('select',{bubbles:true}));});
    await input.press('!');await expect(input).toHaveValue('!'+text);
    const edited=await download(page,info,'edited.docx');
    const parts=unzipSync(readFileSync(edited));for(const [name,bytes] of Object.entries(original)) if(name!=='word/document.xml') expect(parts[name],name).toEqual(bytes);
    await page.getByRole('button',{name:'Undo',exact:true}).click();await expect(input).toHaveValue(text);
    expect(unzipSync(readFileSync(await download(page,info,'undo.docx')))).toEqual(original);
    await reopenDocx(page,input,edited,'!'+text);
  }
  expect(errors).toEqual([]);
});
