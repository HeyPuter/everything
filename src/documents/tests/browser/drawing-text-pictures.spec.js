import {test,expect} from '@playwright/test';
import {readFileSync} from 'node:fs';
import {unzipSync} from 'fflate';
const source='tests/fixtures/drawing-text-pictures/control.docx';
test.setTimeout(300000);
for (const fixture of [source, 'tests/fixtures/drawing-text-image-alias/control.docx']) test(`pictures remain visible and editable in drawing drafts; apply, cancel, export and undo preserve resources: ${fixture.includes('alias') ? 'alias image parts' : 'original parts'}`,async({page},info)=>{
 const source = fixture;
 await page.goto('/playground.html');
 const old=await page.getByRole('textbox',{name:'Document text',exact:true}).elementHandle();
 await page.getByLabel('Open DOCX file').setInputFiles(source);await expect.poll(()=>old.evaluate(e=>e.isConnected)).toBe(false);
 const body=page.getByRole('textbox',{name:'Document text',exact:true});
 const geometry=await page.evaluate(async bytes=>{
  const {openCanvasDocument}=await import('/src/engine/open-document.js'),{CanvasEditor}=await import('/src/engine/canvas-editor.js');
  const {pkg,images}=await openCanvasDocument(new Uint8Array(bytes)),host=document.createElement('div');document.body.append(host);const editor=new CanvasEditor(host,{...pkg,images});
  try{return editor.layout.lines.flatMap(l=>l.fragments.filter(f=>f.image).map(f=>({x:f.x+20,y:l.baseline-f.ascent+15})));}finally{editor.destroy();host.remove();}
 },[...readFileSync(source)]);
 const open=async(drawing=0,frame=1)=>{
  const b=await page.locator('canvas.canvas-page').first().boundingBox();await page.mouse.click(b.x+geometry[drawing].x,b.y+geometry[drawing].y,{button:'right'});
  await page.getByRole('menuitem',{name:'Edit drawing text',exact:true}).hover();await page.getByRole('menuitem',{name:`Text frame ${frame}`,exact:true}).click();
  return page.getByRole('dialog',{name:'Edit drawing text',exact:true});
 };
 const pixels=async canvas=>canvas.evaluate(c=>{const a=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let n=0;for(let i=0;i<a.length;i+=4)if(a[i]>200&&a[i+1]<70&&a[i+2]<60&&a[i+3]>200)n++;return n;});
 const save=async name=>{const event=page.waitForEvent('download');await page.getByRole('button',{name:'Download .docx',exact:true}).click();const path=info.outputPath(name);await(await event).saveAs(path);return path;};
 const before=await pixels(page.locator('canvas.canvas-page').first());expect(before).toBeGreaterThan(300);
 for(const[drawing,frame]of [[0,1],[1,1],[1,2]]){
  const dialog=await open(drawing,frame),input=dialog.getByRole('textbox',{name:'Drawing text'}),text=await input.inputValue();
  expect(text).toContain('Before \ufffc after');expect(await pixels(dialog.locator('canvas.canvas-page').first())).toBeGreaterThan(100);
  const at=text.indexOf('Before');await input.evaluate((e,at)=>{e.setSelectionRange(at,at+6);e.dispatchEvent(new Event('select'));},at);await page.keyboard.insertText('Edited');
  if(drawing===0){
   await input.evaluate(e=>{const at=e.value.indexOf('\ufffc');e.setSelectionRange(at,at+1);e.dispatchEvent(new Event('select'));});
   await dialog.getByRole('button',{name:'Resize from bottom-right corner',exact:true}).press('ArrowRight');
   await dialog.getByRole('button',{name:'Move selected image',exact:true}).press('ArrowRight');
  }
  if(drawing===0) await page.screenshot({path:info.outputPath('picture-draft.png'),fullPage:true});
  await dialog.getByRole('button',{name:'Apply',exact:true}).click();await expect(dialog).toBeHidden();expect(await pixels(page.locator('canvas.canvas-page').first())).toBeGreaterThan(300);
 }
 const saved=await save('drawing-pictures-edited.docx'),parts=unzipSync(readFileSync(saved)),original=unzipSync(readFileSync(source));
 for(const name of Object.keys(original).filter(n=>n!=='word/document.xml'))expect(parts[name]).toEqual(original[name]);
 const result=await page.evaluate(async bytes=>{const {DocxPackage}=await import('/src/engine/docx.js');const p=await DocxPackage.open(new Uint8Array(bytes));return p.paragraphs.flatMap(p=>p.runs).filter(r=>r.image).flatMap(r=>p.drawingTextFrames(r.image)).map(f=>({reason:f.reason,text:f.paragraphs.map(p=>p.runs.map(r=>r.text).join('')).join('\n'),pictures:f.paragraphs.flatMap(p=>p.runs).filter(r=>r.image).map(r=>r.image)}));},[...readFileSync(saved)]);
 expect(result.map(r=>r.reason)).toEqual([null,null,null]);expect(result.every(r=>r.text.includes('Edited'))).toBe(true);expect(result[0].text).toContain('Edited  ￼after');expect(result[0].pictures[0].width).toBeGreaterThan(228600);
 const dialog=await open(),input=dialog.getByRole('textbox',{name:'Drawing text'});await input.press('ControlOrMeta+a');await page.keyboard.insertText('Discarded');await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
 expect(await pixels(page.locator('canvas.canvas-page').first())).toBeGreaterThan(300);expect(unzipSync(readFileSync(await save('drawing-pictures-cancel.docx')))).toEqual(parts);
 for(let i=0;i<3;i++)await body.press('ControlOrMeta+z');expect(unzipSync(readFileSync(await save('drawing-pictures-undo.docx')))).toEqual(original);
 await expect(page.locator('.canvas-message-error')).toHaveCount(0);
});

test('borrowed previews survive draft font refresh and destruction while replacements remain owned',async({page})=>{
 await page.goto('/playground.html');const result=await page.evaluate(async bytes=>{
  const {openCanvasDocument}=await import('/src/engine/open-document.js'),{CanvasEditor}=await import('/src/engine/canvas-editor.js');
  const {pkg,images}=await openCanvasDocument(new Uint8Array(bytes)),image=pkg.paragraphs.flatMap(p=>p.runs).filter(r=>r.image)[1].image,frame=pkg.drawingTextFrames(image)[0];
  const pic=frame.paragraphs.flatMap(p=>p.runs).find(r=>r.image).image,bitmap=images.get(pic.assetId),host=document.createElement('div');document.body.append(host);
  const assets={[pic.assetId]:pkg.assets[pic.assetId]},draftImages=new Map([[pic.assetId,bitmap]]),draft=new CanvasEditor(host,{paragraphs:frame.paragraphs,styles:pkg.styles,numbering:pkg.numbering,assets,images:draftImages,borrowImages:true});
  try{await draft.refreshFonts();const replacement=draft.images.get(pic.assetId);draft.destroy();return {parentSize:images.size,borrowedWidth:bitmap.width,replacementWidth:replacement.width,draftSize:draftImages.size};}finally{draft.destroy();host.remove();for(const b of images.values())b.close();}
 },[...readFileSync(source)]);
 expect(result.parentSize).toBeGreaterThan(2);expect(result.borrowedWidth).toBe(8);expect(result.replacementWidth).toBe(0);expect(result.draftSize).toBe(0);
});
