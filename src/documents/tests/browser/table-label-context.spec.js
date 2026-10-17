import {test,expect} from '@playwright/test';
import {readFileSync,writeFileSync} from 'node:fs';
import {unzipSync} from 'fflate';

const source='tests/fixtures/table-label-context/control.docx';
const download=async(page,info,name)=>{
  const event=page.waitForEvent('download');
  await page.getByRole('button',{name:'Download .docx',exact:true}).click();
  const path=info.outputPath(name);await(await event).saveAs(path);return readFileSync(path);
};

test('table label context retains editing, layout and untouched package parts',async({page},info)=>{
  await page.goto('/playground.html');
  const previous=await page.getByRole('textbox',{name:'Document text'}).elementHandle();
  await page.getByLabel('Open DOCX file').setInputFiles(source);
  await expect.poll(()=>previous.evaluate(e=>e.isConnected)).toBe(false);
  const input=page.getByRole('textbox',{name:'Document text'});
  await expect(input).toHaveJSProperty('readOnly',false);
  await expect(page.locator('canvas.canvas-page')).toHaveCount(6);
  const original=await input.inputValue(),parts=unzipSync(readFileSync(source));
  expect(unzipSync(await download(page,info,'noedit.docx'))).toEqual(parts);
  const geometry=await page.evaluate(async bytes=>{
    const {openCanvasDocument}=await import('/src/engine/open-document.js');
    const {CanvasEditor}=await import('/src/engine/canvas-editor.js');
    const {pkg,images}=await openCanvasDocument(new Uint8Array(bytes));
    const host=document.createElement('div');document.body.append(host);
    const editor=new CanvasEditor(host,{...pkg,images});
    try{return editor.layout.lines.filter(l=>l.fragments.map(f=>f.text||'').join('').trim()==='W:').map(l=>{
      const cell=editor.layout.cells.find(c=>c.id===pkg.paragraphs.find(p=>p.id===l.paragraphId).cellId);
      return {page:l.page,x:l.stops[0].x,y:l.baseline,width:editor.layout.page.width,
        baselineFromTopBorderPt:(l.baseline-cell.y)*.75,depth:cell.depth};
    });}finally{editor.destroy();host.remove();for(const bitmap of images.values())bitmap.close();}
  },[...readFileSync(source)]);
  expect(geometry).toHaveLength(6);
  writeFileSync(info.outputPath('geometry.json'),JSON.stringify(geometry,null,2));
  // Native control origins differ by under one 600-DPI drawing unit. This
  // observation is not a zero-error native PDF or corpus equivalence assertion.
  const native=JSON.parse(readFileSync('tests/fixtures/table-label-context/native-reference.json'));
  for(const [index,g] of geometry.entries()){
    expect(Math.abs(g.baselineFromTopBorderPt-native.cases[index].baselineFromTopBorderPt)).toBeLessThan(.12);
    const canvas=page.locator('canvas.canvas-page').nth(g.page);
    await canvas.evaluate(element=>element.scrollIntoView({block:'start'}));
    const bounds=await canvas.boundingBox();
    await page.mouse.click(bounds.x+(g.x+3)*bounds.width/g.width,bounds.y+(g.y-9)*bounds.width/g.width);
    // A digit: a letter typed at the start of a paragraph is capitalized as a sentence start, a separate undo step.
    await page.keyboard.insertText('1');expect(await input.inputValue()).not.toBe(original);
    const bytes=await download(page,info,`edited-${index+1}.docx`),edited=unzipSync(bytes);
    for(const name of Object.keys(parts).filter(n=>n!=='word/document.xml'))expect(edited[name],name).toEqual(parts[name]);
    const reopened=await page.evaluate(async data=>{
      const {DocxPackage}=await import('/src/engine/docx.js');
      const {TextDocument}=await import('/src/engine/model.js');
      const pkg=await DocxPackage.open(new Uint8Array(data));
      return new TextDocument(pkg.paragraphs,pkg.pageSettings,pkg.numbering,pkg.styles,pkg.tables,pkg.assets).text;
    },[...bytes]);
    expect(reopened).toBe(await input.inputValue());
    await input.press('ControlOrMeta+z');expect(await input.inputValue()).toBe(original);
    expect(unzipSync(await download(page,info,`undo-${index+1}.docx`))).toEqual(parts);
  }
  await expect(page.locator('.canvas-message-error')).toHaveCount(0);
});
