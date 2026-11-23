import {test,expect} from '@playwright/test';
import {readFileSync,writeFileSync} from 'node:fs';
import {unzipSync} from 'fflate';
const HANDLE_NAMES = { nw: 'Resize from top-left corner', n: 'Resize from top edge', ne: 'Resize from top-right corner', e: 'Resize from right edge', se: 'Resize from bottom-right corner', s: 'Resize from bottom edge', sw: 'Resize from bottom-left corner', w: 'Resize from left edge' };

const source='tests/fixtures/image-resize/control.docx', bytes=readFileSync(source);
const cases=JSON.parse(readFileSync('tests/fixtures/image-resize/cases.json','utf8'));
test.setTimeout(180000);
const snapshot=page=>page.evaluate(()=>{
  const e=window.resizeEditor,image=e.model.selectedImage;
  const f=e.layout.floatingObjects.find(f=>f.image===image);
  return {image:JSON.parse(JSON.stringify(image)),frame:f?{x:f.x,y:f.y,width:f.width,height:f.height}:null};
});
const save=async(page,info,name)=>{
  const bytes=await page.evaluate(async()=>{
    const e=window.resizeEditor,m=e.model;
    return [...new Uint8Array(await window.resizePackage.export(m.paragraphs,m.pageSettings,m.numbering,m.styles,m.tables,m.assets).arrayBuffer())];
  });
  const path=info.outputPath(name);writeFileSync(path,Uint8Array.from(bytes));return unzipSync(Uint8Array.from(bytes));
};
const opposite={nw:'se',ne:'sw',sw:'ne',se:'nw'};
const cornerPoint=(f,corner,rotation)=>{
  const a=rotation*Math.PI/180,c=Math.cos(a),s=Math.sin(a),x=(corner.includes('w')?-1:1)*f.width/2,y=(corner.includes('n')?-1:1)*f.height/2;
  return {x:f.x+f.width/2+x*c-y*s,y:f.y+f.height/2+x*s+y*c};
};
async function drag(page,corner,dx,dy,modifier) {
  const handle=page.getByRole('button',{name:HANDLE_NAMES[corner],exact:true});
  await handle.scrollIntoViewIfNeeded();const b=await handle.boundingBox();
  await page.mouse.move(b.x+b.width/2,b.y+b.height/2);
  if(modifier)await page.keyboard.down(modifier);
  await page.mouse.down();await page.mouse.move(b.x+b.width/2+dx,b.y+b.height/2+dy,{steps:4});await page.mouse.up();
  if(modifier)await page.keyboard.up(modifier);
}
for(const item of cases) test(`${item.name}: corners, export, undo and modifiers`,async({page},info)=>{
  await page.goto('/playground.html');
  await page.evaluate(async({bytes,id})=>{
    const {openCanvasDocument}=await import('/src/engine/open-document.js'),{CanvasEditor}=await import('/src/engine/canvas-editor.js');
    const {pkg,images}=await openCanvasDocument(Uint8Array.from(bytes));
    const host=document.createElement('div');host.className='canvas-host';host.style.cssText='position:fixed;inset:0;z-index:100;overflow:auto';document.body.append(host);
    window.resizeErrors=[];window.resizePackage=pkg;window.resizeEditor=new CanvasEditor(host,{...pkg,images,onError:e=>window.resizeErrors.push(e.message)});
    const e=window.resizeEditor,parts=e.layout.lines.flatMap(l=>l.fragments),f=parts.find(f=>f.image?.id===id);e.model.select(f.start,f.end);e.focus();
  },{bytes:[...bytes],id:item.id});
  const before=await snapshot(page);expect(before.image.aspectLocked).toBe(item.lock===true);
  expect(await save(page,info,'no-edit.docx')).toEqual(unzipSync(bytes));
  for(const corner of Object.keys(opposite)) {
    const a=item.rotation*Math.PI/180,c=Math.cos(a),s=Math.sin(a),lx=(corner.includes('w')?-1:1)*24,ly=(corner.includes('n')?-1:1)*7;
    await drag(page,corner,lx*c-ly*s,lx*s+ly*c);
    const after=await snapshot(page);
    expect(after.image.width).toBeGreaterThan(before.image.width);
    if(item.lock===true) expect(Math.abs(after.image.height-after.image.width*before.image.height/before.image.width)).toBeLessThanOrEqual(1);
    else {expect(after.image.width-before.image.width).toBeCloseTo(24*9525,-1);expect(after.image.height-before.image.height).toBeCloseTo(7*9525,-1);}
    for(const key of ['crop','flipH','rotation','aspectLocked'])expect(after.image[key]).toEqual(before.image[key]);
    if(before.frame) {
      const p=cornerPoint(before.frame,opposite[corner],item.rotation),q=cornerPoint(after.frame,opposite[corner],item.rotation);
      expect(Math.abs(p.x-q.x)).toBeLessThan(.08);expect(Math.abs(p.y-q.y)).toBeLessThan(.08);
    }
    const exported=await save(page,info,`${corner}-edited.docx`);
    for(const [name,value] of Object.entries(unzipSync(bytes)))if(name!=='word/document.xml')expect(exported[name]).toEqual(value);
    const reopened=await page.evaluate(async bytes=>{
      const {DocxPackage}=await import('/src/engine/docx.js'),pkg=await DocxPackage.open(Uint8Array.from(bytes));return pkg.paragraphs.flatMap(p=>p.runs.filter(r=>r.image).map(r=>r.image));
    },[...readFileSync(info.outputPath(`${corner}-edited.docx`))]);
    const image=reopened.find(i=>i.id===item.id);expect([image.width,image.height,image.crop,image.rotation,image.aspectLocked]).toEqual([after.image.width,after.image.height,after.image.crop,after.image.rotation,after.image.aspectLocked]);
    await page.getByRole('textbox',{name:'Document text'}).last().press('ControlOrMeta+z');
    expect(await save(page,info,`${corner}-undo.docx`)).toEqual(unzipSync(bytes));
  }
  if(!item.lock) {
    await drag(page,'se',24,7,'Shift');const shifted=await snapshot(page);
    expect(Math.abs(shifted.image.height-shifted.image.width*before.image.height/before.image.width)).toBeLessThanOrEqual(1);
    await save(page,info,'shift-edited.docx');await page.getByRole('textbox',{name:'Document text'}).last().press('ControlOrMeta+z');
    await drag(page,'se',24,7,'Control');const centered=await snapshot(page);
    if(before.frame) {expect(Math.abs(centered.frame.x+centered.frame.width/2-before.frame.x-before.frame.width/2)).toBeLessThan(.08);expect(Math.abs(centered.frame.y+centered.frame.height/2-before.frame.y-before.frame.height/2)).toBeLessThan(.08);}
    await save(page,info,'center-edited.docx');await page.getByRole('textbox',{name:'Document text'}).last().press('ControlOrMeta+z');
    const handle=page.getByRole('button',{name:'Resize from bottom-right corner'});await handle.focus();await handle.press('ArrowRight');
    const keyed=await snapshot(page);expect([keyed.image.width,keyed.image.height]).not.toEqual([before.image.width,before.image.height]);
    await save(page,info,'keyboard-edited.docx');await page.getByRole('textbox',{name:'Document text'}).last().press('ControlOrMeta+z');
    expect(await save(page,info,'modifiers-undo.docx')).toEqual(unzipSync(bytes));
  }
  expect(await page.evaluate(()=>window.resizeErrors)).toEqual([]);
});
