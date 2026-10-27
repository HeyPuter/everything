import {test,expect} from '@playwright/test';
import {readFileSync,writeFileSync} from 'node:fs';
import {unzipSync} from 'fflate';
import {reopenDocx} from './helpers/reopen-docx.js';

const matrix=JSON.parse(readFileSync('tests/fixtures/script-position-native/cases.json'));
test.use({permissions:['local-fonts']});
const groups=['script-size','script-position-metrics','script-vdmx-position','script-vdmx-ppem','script-device-caps','script-size-offset','script-sub-offset','script-sub-offset-threshold','script-metric-controls','bundled-script','script-compound-position'];
for(const name of groups)test(`paints native script baselines: ${name}`,async({page},info)=>{
 test.setTimeout(180000);
 const root=`tests/fixtures/${name}/`,file=['script-size','bundled-script'].includes(name)?'control.docx':'controls.docx';
 const compound=name==='script-compound-position';
 const expected=compound?JSON.parse(readFileSync(root+'reference.json')).cases[0].rows.map(r=>({...r,nativeRise:r.risePt,nativeSize:-r.scriptHeight*.12})):
  matrix.cases.filter(c=>{const f=matrix.fonts[c.font];return name==='script-size'?f.system:name==='bundled-script'?f.file.startsWith('public/fonts/'):f.file.startsWith(root);});
 const fonts=['script-size','bundled-script'].includes(name)?[]:JSON.parse(readFileSync(root+'fonts.json')).map(file=>({name:file,bytes:readFileSync(root+file).toString('base64')}));
 await page.goto('/playground.html');
 const actual=await page.evaluate(async({fonts,source})=>{
  const bytes=b=>Uint8Array.from(atob(b),c=>c.charCodeAt(0));
  const {loadFontFile}=await import('/src/engine/file-fonts.js');
  const {DocxPackage}=await import('/src/engine/docx.js');
  const {loadCanvasFonts}=await import('/src/engine/canvas-text.js');
  const {CanvasEditor}=await import('/src/engine/canvas-editor.js');
  for(const f of fonts)await loadFontFile(new File([bytes(f.bytes)],f.name));
  const pkg=await DocxPackage.open(bytes(source));await loadCanvasFonts(pkg);
  const host=document.createElement('div');document.body.append(host);const editor=new CanvasEditor(host,{...pkg,images:new Map()});
  const paints=[],fill=CanvasRenderingContext2D.prototype.fillText;
  CanvasRenderingContext2D.prototype.fillText=function(text,x,y,...args){
   if((text==='START '||text==='TEST')&&this.canvas.classList.contains('canvas-page')){
    const page=+this.canvas.dataset.page,m=this.getTransform(),scale=this.canvas.width/(editor.layout.pages[page]||editor.layout.page).width;
    const points=Number(/([\d.]+)px/.exec(this.font)[1])*.75;
    paints.push({text,page,y:(m.b*x+m.d*y+m.f)/scale*.75,sizeX:points*Math.hypot(m.a,m.b)/scale,sizeY:points*Math.hypot(m.c,m.d)/scale});
   }
   return fill.call(this,text,x,y,...args);
  };
  try{editor.paint();editor.flushPaint();return {paints,pages:editor.layout.pageCount};}finally{CanvasRenderingContext2D.prototype.fillText=fill;editor.destroy();host.remove();}
 },{fonts,source:readFileSync(root+file).toString('base64')});
 expect(actual.paints).toHaveLength(expected.length*2);
 const comparisons=expected.map((row,i)=>{
  const [prefix,script]=actual.paints.slice(i*2,i*2+2);
  expect([prefix.text,script.text]).toEqual(['START ','TEST']);expect(prefix.page).toBe(script.page);
  expect(Math.abs(prefix.y-script.y-row.nativeRise),`${name} ${i} rise`).toBeLessThan(.061);
  for(const axis of ['sizeX','sizeY'])expect(Math.abs(script[axis]-row.nativeSize),`${name} ${i} ${axis}`).toBeLessThan(.061);
  return {size:row.size,script:row.script,nativeRise:row.nativeRise,paintRise:prefix.y-script.y,nativeSize:row.nativeSize,sizeX:script.sizeX,sizeY:script.sizeY};
 });
 writeFileSync(info.outputPath('native-positions.json'),JSON.stringify(comparisons,null,2));
 if(!compound)return;
 const previous=await page.getByRole('textbox',{name:'Document text'}).elementHandle();
 await page.getByLabel('Open DOCX file').setInputFiles(root+file);await expect.poll(()=>previous.evaluate(e=>e.isConnected),{timeout:90000}).toBe(false);
 const input=page.getByRole('textbox',{name:'Document text'});await expect(input).toBeEditable();const original=await input.inputValue(),parts=unzipSync(readFileSync(root+file));
 const save=async name=>{const pending=page.waitForEvent('download');await page.getByRole('button',{name:'Download .docx',exact:true}).click();const path=info.outputPath(name+'.docx');await(await pending).saveAs(path);return path;};
 expect(unzipSync(readFileSync(await save('noedit')))).toEqual(parts);
 await input.focus();await input.press('ControlOrMeta+Home');await page.keyboard.insertText('EDIT ');const edited=await save('edited');
 const changed=unzipSync(readFileSync(edited));for(const[name,data]of Object.entries(parts))if(name!=='word/document.xml')expect(changed[name]).toEqual(data);
 await input.press('ControlOrMeta+z');await expect(input).toHaveValue(original);expect(unzipSync(readFileSync(await save('undo')))).toEqual(parts);
 await reopenDocx(page,input,edited,'EDIT '+original);
});
