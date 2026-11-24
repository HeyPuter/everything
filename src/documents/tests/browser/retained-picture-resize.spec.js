import {test,expect} from '@playwright/test';
import {readFileSync,writeFileSync} from 'node:fs';
import {unzipSync} from 'fflate';
const source='tests/fixtures/retained-picture-resize/control.docx',bytes=readFileSync(source);
const cases=JSON.parse(readFileSync('tests/fixtures/retained-picture-resize/cases.json','utf8'));
test.setTimeout(180000);
for(const item of cases)test(item.name,async({page},info)=>{
  await page.goto('/playground.html');
  const initial=await page.evaluate(async({bytes,id})=>{
    const {openCanvasDocument}=await import('/src/engine/open-document.js'),{CanvasEditor}=await import('/src/engine/canvas-editor.js'),{attachShapeEditing}=await import('/src/engine/shape-editing.js');
    const {pkg,images}=await openCanvasDocument(Uint8Array.from(bytes));if(pkg.readOnly)throw new Error('Fixture is read-only');
    const host=document.createElement('div');host.className='canvas-host';host.style.cssText='position:fixed;inset:0;z-index:40;overflow:auto';document.getElementById('app').append(host);
    window.sceneErrors=[];window.scenePackage=pkg;window.sceneEditor=new CanvasEditor(host,{...pkg,images,onError:e=>window.sceneErrors.push(e.message)});
    attachShapeEditing(window.sceneEditor,e=>window.sceneErrors.push(e.message),()=>pkg);
    const e=window.sceneEditor,f=e.layout.lines.flatMap(l=>l.fragments).find(f=>f.image?.id===id);e.model.select(f.start,f.end);e.focus();
    return {image:JSON.parse(JSON.stringify(e.model.selectedImage)),range:[...e.model.range]};
  },{bytes:[...bytes],id:item.id});
  const exportBytes=()=>page.evaluate(async()=>{const e=window.sceneEditor,m=e.model;return [...new Uint8Array(await window.scenePackage.export(m.paragraphs,m.pageSettings,m.numbering,m.styles,m.tables,m.assets).arrayBuffer())];});
  expect(unzipSync(Uint8Array.from(await exportBytes()))).toEqual(unzipSync(bytes));
  const handle=page.getByRole('button',{name:'Resize from bottom-right corner',exact:true});
  if(item.relative){await expect(handle).toHaveCount(0);return;}
  await handle.scrollIntoViewIfNeeded();const b=await handle.boundingBox();
  await page.mouse.move(b.x+b.width/2,b.y+b.height/2);await page.mouse.down();await page.mouse.move(b.x+b.width/2+24,b.y+b.height/2+7,{steps:4});await page.mouse.up();
  await expect.poll(()=>page.evaluate(()=>window.sceneEditor.model.selectedImage.width),{timeout:60000}).toBeGreaterThan(initial.image.width);
  const after=await page.evaluate(()=>JSON.parse(JSON.stringify(window.sceneEditor.model.selectedImage)));
  if(item.locked)expect(Math.abs(after.height-after.width*initial.image.height/initial.image.width)).toBeLessThanOrEqual(1);
  else {expect(after.width-initial.image.width).toBeCloseTo(24*9525,-1);expect(after.height-initial.image.height).toBeCloseTo(7*9525,-1);}
  const exported=Uint8Array.from(await exportBytes());writeFileSync(info.outputPath('resized.docx'),exported);
  for(const [name,data] of Object.entries(unzipSync(bytes)))if(name!=='word/document.xml')expect(unzipSync(exported)[name]).toEqual(data);
  const pixels=await page.evaluate(()=>window.sceneEditor.printSheets().map(c=>c.toDataURL()));
  const reopened=await page.evaluate(async({bytes,id})=>{
    const {openCanvasDocument}=await import('/src/engine/open-document.js'),{CanvasEditor}=await import('/src/engine/canvas-editor.js');
    const {pkg,images}=await openCanvasDocument(Uint8Array.from(bytes)),host=document.createElement('div');document.getElementById('app').append(host);const e=new CanvasEditor(host,{...pkg,images});
    try{return {image:pkg.paragraphs.flatMap(p=>p.runs.filter(r=>r.image).map(r=>r.image)).find(i=>i.id===id),pixels:e.printSheets().map(c=>c.toDataURL())};}finally{e.destroy();host.remove();}
  },{bytes:[...exported],id:item.id});
  expect([reopened.image.width,reopened.image.height]).toEqual([after.width,after.height]);expect(reopened.pixels).toEqual(pixels);
  const preserved=await page.evaluate(({before,after})=>{
    const x=s=>new DOMParser().parseFromString(s,'application/xml');
    const tree=n=>n?{ns:n.namespaceURI,name:n.localName,attrs:[...n.attributes].filter(a=>a.namespaceURI!=='http://www.w3.org/2000/xmlns/').map(a=>[a.namespaceURI,a.localName,a.value]).sort(),children:[...n.children].map(tree)}:null;
    return ['blipFill','prstGeom','custGeom','ln','effectLst','scene3d','sp3d'].map(name=>{const a=x(before).getElementsByTagNameNS('*',name)[0],b=x(after).getElementsByTagNameNS('*',name)[0];return [tree(a),tree(b)];});
  },{before:initial.image.shell,after:after.shell});
  for(const [a,b] of preserved)expect(b).toEqual(a);
  await page.getByRole('textbox',{name:'Document text'}).last().press('ControlOrMeta+z');
  expect(unzipSync(Uint8Array.from(await exportBytes()))).toEqual(unzipSync(bytes));
  if(item.id===3){
    const canceled=await page.evaluate(async()=>{
      const e=window.sceneEditor,controller=new AbortController(),count=e.images.size;
      const job=e.pictureEditor.resize({width:e.model.selectedImage.width+9525,height:e.model.selectedImage.height},{signal:controller.signal});controller.abort();
      return {result:await job,countBefore:count,countAfter:e.images.size};
    });
    expect(canceled.result).toBe(false);expect(canceled.countAfter).toBe(canceled.countBefore);
    expect(unzipSync(Uint8Array.from(await exportBytes()))).toEqual(unzipSync(bytes));
    await page.evaluate(async()=>{
      const {openImageProperties}=await import('/src/views/image-properties.js'),e=window.sceneEditor;
      openImageProperties(e.model.selectedImage,(patch,signal)=>e.pictureEditor.resize(patch,{signal}),{canResize:true});
    });
    const dialog=page.getByRole('dialog',{name:'Image properties'});
    await expect(dialog.getByLabel('Crop left (%)')).toHaveCount(0);
    await dialog.getByLabel('Keep image proportions').uncheck();await dialog.getByLabel('Image width (in)').fill('1.6');
    await dialog.getByRole('button',{name:'Apply',exact:true}).click();await expect(dialog).toHaveCount(0);
    expect(await page.evaluate(()=>window.sceneEditor.model.selectedImage.width)).toBe(1463040);
    await page.getByRole('textbox',{name:'Document text'}).last().press('ControlOrMeta+z');
    expect(unzipSync(Uint8Array.from(await exportBytes()))).toEqual(unzipSync(bytes));
  }
  expect(await page.evaluate(()=>window.sceneErrors)).toEqual([]);
});
