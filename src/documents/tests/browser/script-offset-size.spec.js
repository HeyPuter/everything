import {test,expect} from '@playwright/test';
import {readFileSync} from 'node:fs';
import {unzipSync} from 'fflate';
import {reopenDocx} from './helpers/reopen-docx.js';

for(const name of ['script-sub-offset','script-sub-offset-threshold'])test(`paints native offset-dependent sizes and retains editing: ${name}`,async({page},info)=>{
 test.setTimeout(180000);
 const root=`tests/fixtures/${name}/`,source=readFileSync(root+'controls.docx');
 const reference=JSON.parse(readFileSync(root+'reference.json'));
 const fonts=JSON.parse(readFileSync(root+'fonts.json')).map(file=>({name:file,bytes:readFileSync(root+file).toString('base64')}));
 const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('/playground.html');
 const actual=await page.evaluate(async({fonts,source})=>{
  const {loadFontFile}=await import('/src/engine/file-fonts.js');
  const {DocxPackage}=await import('/src/engine/docx.js');
  const {loadCanvasFonts}=await import('/src/engine/canvas-text.js');
  const {CanvasEditor}=await import('/src/engine/canvas-editor.js');
  const bytes=b=>Uint8Array.from(atob(b),c=>c.charCodeAt(0));
  for(const f of fonts)await loadFontFile(new File([bytes(f.bytes)],f.name));
  const pkg=await DocxPackage.open(bytes(source));await loadCanvasFonts(pkg);
  const host=document.createElement('div');document.body.append(host);
  const editor=new CanvasEditor(host,{...pkg,images:new Map()});
  const paints=[],native=CanvasRenderingContext2D.prototype.fillText;
  CanvasRenderingContext2D.prototype.fillText=function(text,...args){
   if(text==='TEST'&&this.canvas.classList.contains('canvas-page')){
    const page=+this.canvas.dataset.page,m=this.getTransform();
    const scale=this.canvas.width/(editor.layout.pages[page]||editor.layout.page).width;
    const points=Number(/([\d.]+)px/.exec(this.font)[1])*.75;
    paints.push({page,sizeX:points*Math.hypot(m.a,m.b)/scale,sizeY:points*Math.hypot(m.c,m.d)/scale});
   }
   return native.call(this,text,...args);
  };
  try{editor.paint();editor.flushPaint();return paints;}finally{CanvasRenderingContext2D.prototype.fillText=native;editor.destroy();host.remove();}
 },{fonts,source:source.toString('base64')});
 const expected=reference.cases.flatMap((c,page)=>c.rows.map(row=>({...row,page})));
 expect(actual).toHaveLength(expected.length);
 for(const [i,row]of expected.entries()){
  expect(actual[i].page).toBe(row.page);
  for(const axis of ['sizeX','sizeY'])expect(Math.abs(actual[i][axis]+row.scriptHeight*.12),`${i} ${axis}`).toBeLessThan(.061);
 }
 const previous=await page.getByRole('textbox',{name:'Document text'}).elementHandle();
 await page.getByLabel('Open DOCX file').setInputFiles(root+'controls.docx');
 await expect.poll(()=>previous.evaluate(e=>e.isConnected),{timeout:90000}).toBe(false);
 const input=page.getByRole('textbox',{name:'Document text'});await expect(input).toBeEditable();
 const original=await input.inputValue(),parts=unzipSync(source);
 const save=async name=>{const pending=page.waitForEvent('download');await page.getByRole('button',{name:'Download .docx',exact:true}).click();const path=info.outputPath(name+'.docx');await(await pending).saveAs(path);return path;};
 expect(unzipSync(readFileSync(await save('noedit')))).toEqual(parts);
 await input.focus();await input.press('ControlOrMeta+Home');await page.keyboard.insertText('EDIT ');
 const edited=await save('edited'),changed=unzipSync(readFileSync(edited));
 for(const [file,bytes]of Object.entries(parts))if(file!=='word/document.xml')expect(changed[file]).toEqual(bytes);
 await input.press('ControlOrMeta+z');await expect(input).toHaveValue(original);
 expect(unzipSync(readFileSync(await save('undo')))).toEqual(parts);
 await reopenDocx(page,input,edited,'EDIT '+original);expect(errors).toEqual([]);
});
