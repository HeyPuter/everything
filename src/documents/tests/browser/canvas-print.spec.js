import { test, expect } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { fileCommand } from './helpers/editor-tools.js';
test.setTimeout(180000);
test('File print and Ctrl/Cmd+P capture physical pages without altering the editor', async ({page},info) => {
  await page.addInitScript(() => { window.print = () => { window.printCalls = (window.printCalls || 0) + 1; }; });
  await page.goto('/playground.html');
  await page.getByRole('button', {name:'Across pages',exact:true}).click();
  const input = page.getByRole('textbox',{name:'Document text'});
  await expect(page.locator('canvas.canvas-page').nth(1)).toBeVisible();
  const text = await input.inputValue(), count = await page.locator('canvas.canvas-page').count();
  await input.focus(); await input.press('ControlOrMeta+a'); await input.press('ControlOrMeta+p');
  await expect.poll(() => page.evaluate(() => window.printCalls)).toBe(1);
  await expect(page.locator('.print-stage canvas')).toHaveCount(count);
  const snapshot = await page.locator('.print-stage canvas').evaluateAll(cs => cs.map(c => ({width:c.style.width,height:c.style.height,
    ink: [...c.getContext('2d').getImageData(0,0,c.width,c.height).data].some((v,i)=>i%4!==3 && v<200)})));
  expect(snapshot.every(p=>p.ink)).toBe(true);
  await page.pdf({path:info.outputPath('printed.pdf'),preferCSSPageSize:true,printBackground:true});
  writeFileSync(info.outputPath('pages.json'),JSON.stringify(snapshot,null,2));
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  await expect(page.locator('.print-stage')).toHaveCount(0);
  expect(await input.inputValue()).toBe(text);
  await (await fileCommand(page,'Print…')).click();
  await expect.poll(() => page.evaluate(() => window.printCalls)).toBe(2);
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  await expect(page.locator('.print-stage')).toHaveCount(0);
  await expect(page.locator('.canvas-message-error')).toHaveCount(0);
});
test('print rendering is independent of selection, zoom and editing area', async ({page}) => {
  await page.goto('/playground.html');
  const result = await page.evaluate(async () => {
    const {createDocx}=await import('/src/engine/docx.js');
    const {paragraph}=await import('/src/engine/model.js');
    const {CanvasEditor}=await import('/src/engine/canvas-editor.js');
    const pkg=createDocx([paragraph('Printable text')]),host=document.createElement('div');document.body.append(host);
    const editor=new CanvasEditor(host,pkg);
    try{
      const first=editor.printSheets().map(c=>c.toDataURL());
      editor.model.select(0,5);editor.focus();editor.setZoom(.75);
      const second=editor.printSheets().map(c=>c.toDataURL());
      return {same:JSON.stringify(first)===JSON.stringify(second),selection:editor.model.range,zoom:editor.zoom};
    }finally{editor.destroy();host.remove();}
  });
  expect(result).toEqual({same:true,selection:[0,5],zoom:.75});
});

test('read-only documents print mixed physical page sizes and keep editing disabled',async({page},info)=>{
  await page.addInitScript(()=>{window.print=()=>{window.printCalls=(window.printCalls || 0)+1;};});
  await page.goto('/playground.html');
  const result=await page.evaluate(async()=>{
    const {createDocx}=await import('/src/engine/docx.js'),{paragraph}=await import('/src/engine/model.js');
    const {CanvasEditor}=await import('/src/engine/canvas-editor.js'),{printPages}=await import('/src/lib/print.js');
    const first=paragraph('Portrait page'),last=paragraph('Landscape page');first.sectionEnd={width:12240,height:15840,orientation:'portrait'};
    const pkg=createDocx([first,last],{width:15840,height:12240,orientation:'landscape'}),host=document.createElement('div');document.body.append(host);
    window.printProbe=new CanvasEditor(host,{...pkg,readOnly:true});const editor=window.printProbe;
    const sizes=editor.printSheets().map(c=>({width:parseFloat(c.style.width),height:parseFloat(c.style.height)}));
    editor.setImageProperties({width:1});
    window.printPending=printPages({host,capture:()=>editor.printSheets()});
    return {sizes,readOnly:editor.input.readOnly,handlesHidden:host.querySelector('.canvas-image-frame').hidden,history:editor.session.history.length};
  });
  expect(result).toEqual({sizes:[{width:816,height:1056},{width:1056,height:816}],readOnly:true,handlesHidden:true,history:0});
  await expect.poll(()=>page.evaluate(()=>window.printCalls)).toBe(1);
  await page.pdf({path:info.outputPath('mixed-sizes.pdf'),preferCSSPageSize:true,printBackground:true});
  await page.evaluate(async()=>{window.dispatchEvent(new Event('afterprint'));await window.printPending;window.printProbe.host.remove();window.printProbe.destroy();});
  await expect(page.locator('.print-stage')).toHaveCount(0);
});
