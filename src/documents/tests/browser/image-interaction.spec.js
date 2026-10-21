import {test,expect} from '@playwright/test';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {unzipSync} from 'fflate';
import {downloadDocx} from './helpers/editor-tools.js';
test.setTimeout(180000);
const source='tests/fixtures/image-interaction/control.docx';
const load=async(page,file)=>{
  await page.goto('/playground.html');const previous=await page.getByRole('textbox',{name:'Document text'}).elementHandle();
  await page.getByLabel('Open DOCX file').setInputFiles(file);
  await expect.poll(()=>previous.evaluate(e=>e.isConnected),{timeout:90000}).toBe(false);
  await expect(page.locator('canvas.canvas-page').first()).toBeVisible();
};
const drag=async(page,locator,dx,dy)=>{const b=await locator.boundingBox({timeout:10000});expect(b).not.toBeNull();await page.mouse.move(b.x+b.width/2,b.y+b.height/2);await page.mouse.down();await page.mouse.move(b.x+b.width/2+dx,b.y+b.height/2+dy,{steps:5});await page.mouse.up();};
const download=async(page,info,name)=>{const event=page.waitForEvent('download');await downloadDocx(page);const path=info.outputPath(name);await(await event).saveAs(path);return path;};
test('text behind a picture edits normally; explicit image gestures and layer menus export and undo',async({page},info)=>{
  await load(page,source);const input=page.getByRole('textbox',{name:'Document text'}),text=await input.inputValue();
  const canvas=page.locator('canvas.canvas-page').first(),b=await canvas.boundingBox();
  await page.mouse.click(b.x+105,b.y+105);
  expect(await input.evaluate(e=>e.selectionStart===e.selectionEnd)).toBe(true);
  await page.keyboard.insertText('Typed ');expect(await input.inputValue()).toContain('Typed ');
  await input.press('ControlOrMeta+z');expect(await input.inputValue()).toBe(text);
  await page.mouse.click(b.x+105,b.y+105,{button:'right'});
  await page.getByRole('menuitem',{name:'Select picture behind text',exact:true}).click();
  await expect(page.getByRole('button',{name:'Move selected image',exact:true})).toBeVisible();
  await page.keyboard.down('Alt');await page.mouse.click(b.x+110,b.y+110);await page.keyboard.up('Alt');
  await expect(page.getByRole('button',{name:'Resize image se'})).toBeVisible();
  const frame=page.locator('.canvas-image-frame'),before=await frame.boundingBox();
  await drag(page,page.getByRole('button',{name:'Resize image se'}),25,15);
  expect((await frame.boundingBox()).width).toBeGreaterThan(before.width);
  await drag(page,page.getByRole('button',{name:'Move selected image',exact:true}),40,20);
  const moved=await frame.boundingBox();expect(moved.x).toBeGreaterThan(before.x+30);
  await page.mouse.click(moved.x+10,moved.y+10,{button:'right'});
  await page.getByRole('menuitem',{name:'Arrange',exact:true}).hover();
  await page.getByRole('menuitemcheckbox',{name:'In front of text',exact:true}).click();
  const saved=await download(page,info,'image-edited.docx');
  const data=await page.evaluate(async bytes=>{
    const {DocxPackage}=await import('/src/engine/docx.js');const pkg=await DocxPackage.open(new Uint8Array(bytes));
    return pkg.paragraphs.flatMap(p=>p.runs.filter(r=>r.image).map(r=>({id:r.image.id,width:r.image.width,height:r.image.height,anchor:r.image.anchor})));
  },[...readFileSync(saved)]);
  expect(data[0].anchor.behind).toBe(false);expect(data[0].anchor.x).toBeGreaterThan(0);
  writeFileSync(info.outputPath('image-state.json'),JSON.stringify(data,null,2));
  await input.focus();for(let i=0;i<3;i++)await input.press('ControlOrMeta+z');
  expect(unzipSync(readFileSync(await download(page,info,'image-undo.docx')))).toEqual(unzipSync(readFileSync(source)));
  await page.screenshot({path:info.outputPath('image-controls.png'),fullPage:true});
  await expect(page.locator('.canvas-message-error')).toHaveCount(0);
});
test('inline picture drag moves its insertion position and remains one undo step',async({page},info)=>{
  await load(page,source);
  const geometry=await page.evaluate(async bytes=>{
    const {openCanvasDocument}=await import('/src/engine/open-document.js');const {CanvasEditor}=await import('/src/engine/canvas-editor.js');
    const {pkg,images}=await openCanvasDocument(new Uint8Array(bytes));const host=document.createElement('div');document.body.append(host);const editor=new CanvasEditor(host,{...pkg,images});
    try{const lines=editor.layout.lines,f=lines.flatMap(l=>l.fragments.map(f=>({...f,y:l.baseline-f.ascent}))).find(f=>f.image&&!f.image.anchor),target=lines.find(l=>l.fragments.some(f=>f.text==='Drop image here'));return {x:f.x+20,y:f.y+10,targetX:target.fragments[0].x+100,targetY:target.y+5};}finally{editor.destroy();host.remove();}
  },[...readFileSync(source)]);
  const canvas=await page.locator('canvas.canvas-page').first().boundingBox(),input=page.getByRole('textbox',{name:'Document text'}),before=await input.inputValue();
  await page.mouse.move(canvas.x+geometry.x,canvas.y+geometry.y);await page.mouse.down();
  await page.mouse.move(canvas.x+geometry.targetX,canvas.y+geometry.targetY,{steps:5});await page.mouse.up();
  expect(await input.inputValue()).not.toBe(before);
  await download(page,info,'inline-moved.docx');await input.press('ControlOrMeta+z');expect(await input.inputValue()).toBe(before);
  expect(unzipSync(readFileSync(await download(page,info,'inline-undo.docx')))).toEqual(unzipSync(readFileSync(source)));
});
test('Escape cancels a gesture; keyboard nudges export as a single undo step',async({page},info)=>{
  await load(page,source);const canvas=await page.locator('canvas.canvas-page').first().boundingBox();
  await page.keyboard.down('Alt');await page.mouse.click(canvas.x+110,canvas.y+110);await page.keyboard.up('Alt');
  const move=page.getByRole('button',{name:'Move selected image',exact:true}),frame=page.locator('.canvas-image-frame'),before=await frame.boundingBox(),b=await move.boundingBox();
  await page.mouse.move(b.x+b.width/2,b.y+b.height/2);await page.mouse.down();await page.mouse.move(b.x+b.width/2+50,b.y+b.height/2+20);
  await page.keyboard.press('Escape');await page.mouse.up();
  expect((await frame.boundingBox()).x).toBe(before.x);
  expect(unzipSync(readFileSync(await download(page,info,'cancelled.docx')))).toEqual(unzipSync(readFileSync(source)));
  await move.focus();await move.press('Shift+ArrowRight');expect((await frame.boundingBox()).x).toBeCloseTo(before.x+10,0);
  await download(page,info,'keyboard-moved.docx');await page.getByRole('textbox',{name:'Document text'}).press('ControlOrMeta+z');
  expect(unzipSync(readFileSync(await download(page,info,'keyboard-undo.docx')))).toEqual(unzipSync(readFileSync(source)));
});
const external=process.env.DOCX_EDIT_REVIEW_SOURCE;
test('requested teacher card permits clicking, typing and selecting message text',async({page},info)=>{
  test.skip(!external||!existsSync(external),'Local source supplied through DOCX_EDIT_REVIEW_SOURCE.');
  await page.addInitScript(()=>{window.print=()=>{window.printCalls=(window.printCalls || 0)+1;};});
  await page.addInitScript(()=>{window.drawnText=[];const native=CanvasRenderingContext2D.prototype.fillText;CanvasRenderingContext2D.prototype.fillText=function(text,x,y,...args){if(this.canvas.classList.contains('canvas-page')&&String(text).includes('THE BEST TEACHER')){const m=this.getTransform();window.drawnText.push({page:this.canvas.dataset.page,x:m.a*x+m.c*y+m.e,y:m.b*x+m.d*y+m.f,width:this.measureText(text).width*m.a,height:parseFloat(this.font.match(/([\d.]+)px/)?.[1]||16)*m.d});}return native.call(this,text,x,y,...args);};});
  await load(page,external);const input=page.getByRole('textbox',{name:'Document text'});await expect(input).toHaveJSProperty('readOnly',false);
  await expect.poll(()=>page.evaluate(()=>window.drawnText.length)).toBeGreaterThan(0);
  const point=await page.evaluate(()=>{const t=window.drawnText.at(-1),c=document.querySelectorAll('canvas.canvas-page')[+t.page],b=c.getBoundingClientRect();return {x:b.left+(t.x+t.width/2)*b.width/c.width,y:b.top+(t.y-t.height/2)*b.height/c.height};});
  await page.mouse.click(point.x,point.y);
  // A title prompt selects its whole content control on the first click.
  const selected=await input.evaluate(e=>e.value.slice(e.selectionStart,e.selectionEnd));
  expect(selected).not.toContain('\ufffc');
  expect(selected).toContain('THE BEST TEACHER');
  const original=await input.inputValue();await page.keyboard.insertText('TEST');expect(await input.inputValue()).toContain('TEST');
  await download(page,info,'teacher-edited.docx');await input.press('ControlOrMeta+z');expect(await input.inputValue()).toBe(original);
  expect(unzipSync(readFileSync(await download(page,info,'teacher-undo.docx')))).toEqual(unzipSync(readFileSync(external)));
  await page.screenshot({path:info.outputPath('teacher-card.png'),fullPage:true});
  await input.press('ControlOrMeta+p');await expect.poll(()=>page.evaluate(()=>window.printCalls)).toBe(1);
  await page.pdf({path:info.outputPath('teacher-card.pdf'),preferCSSPageSize:true,printBackground:true});
  await page.evaluate(()=>window.dispatchEvent(new Event('afterprint')));
  await expect(page.locator('.print-stage')).toHaveCount(0);
});
test('in Viewing mode the arrow keys move the caret off a selected floating picture instead of being swallowed',async({page})=>{
  await load(page,source);const canvas=await page.locator('canvas.canvas-page').first().boundingBox();
  await page.keyboard.down('Alt');await page.mouse.click(canvas.x+110,canvas.y+110);await page.keyboard.up('Alt');
  await expect(page.getByRole('button',{name:'Move selected image',exact:true})).toBeVisible();
  const input=page.getByRole('textbox',{name:'Document text'});
  await page.getByRole('button',{name:/^Editing mode/}).click();await page.getByRole('menuitemradio',{name:/^Viewing/}).click();
  const state=()=>input.evaluate(el=>({start:el.selectionStart,end:el.selectionEnd}));
  const before=await state();expect(before.end).toBeGreaterThan(before.start);
  await input.focus();await input.press('ArrowRight');
  expect(await state()).toEqual({start:before.end,end:before.end});
});
