import {test,expect} from '@playwright/test';
import {readFileSync,writeFileSync} from 'node:fs';
import {unzipSync} from 'fflate';
import {openReadOnlyPreview} from './helpers/preview.js';

const folder='tests/fixtures/multipage-floating-preview/';
test('horizontal multi-page float remains editable with rich content in the UI',async({page},info)=>{
 test.setTimeout(120000);
 const source=folder+'horizontal-unsupported.docx',bytes=readFileSync(source);
 await page.goto('/playground.html');
 await page.getByLabel('Open DOCX file').setInputFiles(source);
 const input=page.getByRole('textbox',{name:'Document text'});
 await expect(input).not.toHaveValue('',{timeout:120000});
 await expect(input).toHaveJSProperty('readOnly',false);
 // Pages are painted just after the text model is ready.
 await expect.poll(()=>page.locator('canvas.canvas-page').count()).toBeGreaterThan(1);
 const original=await input.inputValue();await input.focus();await input.press('ControlOrMeta+Home');await input.pressSequentially('Edited ');
 await expect(input).toHaveValue(/^Edited /);
 for(let index=0;index<7;index++)await input.press('ControlOrMeta+z');
 await expect(input).toHaveValue(original);
 const download=page.waitForEvent('download');await page.getByRole('button',{name:'Download .docx',exact:true}).click();
 const output=info.outputPath('undo.docx');await(await download).saveAs(output);
 expect(unzipSync(readFileSync(output))).toEqual(unzipSync(bytes));
});
for(const mode of ['vertical','multiple'])for(const zoom of [1,.75])test(`${mode} multi-page floating-table recovery at ${zoom}`,async({page},info)=>{
 test.setTimeout(180000);
 await page.goto('/playground.html');
 const sources=['unsupported','matched'].map(name=>[...readFileSync(folder+mode+'-'+name+'.docx')]);
 const result=await page.evaluate(async({sources,zoom})=>{
  const {openCanvasDocument}=await import('/src/engine/open-document.js');
  const {DocxPackage}=await import('/src/engine/docx.js');
  const {validateCanvasLayout}=await import('/src/engine/canvas-text.js');
  const {CanvasEditor}=await import('/src/engine/canvas-editor.js');
  const raw=await DocxPackage.open(new Uint8Array(sources[0]));
  const before=JSON.stringify({tables:raw.tables,paragraphs:raw.paragraphs,assets:raw.assets});
  let strictError;try{await validateCanvasLayout(raw);}catch(error){strictError=error.message;}
  const strictUnchanged=before===JSON.stringify({tables:raw.tables,paragraphs:raw.paragraphs,assets:raw.assets});
  const out=[];
  for(const bytes of sources){
   const {pkg,images}=await openCanvasDocument(new Uint8Array(bytes));
   const original=JSON.stringify({tables:pkg.tables,paragraphs:pkg.paragraphs});
   const host=document.createElement('div');document.body.append(host);const errors=[];
   const editor=new CanvasEditor(host,{...pkg,images,onError:error=>errors.push(error.message)});
   try{
    editor.setZoom(zoom);await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    const pixels=editor.canvases.map(c=>c.toDataURL()),printedPixels=editor.printSheets().map(c=>c.toDataURL());
    const screenAfterPrintMatches=JSON.stringify(pixels)===JSON.stringify(editor.canvases.map(c=>c.toDataURL()));
    out.push({readOnly:!!pkg.readOnly,issues:pkg.previewIssues,images:images.size,tables:pkg.tables.length,
     floatingDeclarations:pkg.tables.filter(t=>t.floating).length,columns:pkg.pageSettings.columns,
     errors,pages:editor.layout.pageCount,sourceUnchanged:original===JSON.stringify({tables:pkg.tables,paragraphs:pkg.paragraphs}),
     stories:Object.keys(pkg.pageStories?.stories||{}).length,pixels,printedPixels,screenAfterPrintMatches,
     geometry:[...editor.layout.lines,...editor.storyLayout.lines].map(l=>({page:l.page,y:l.y,baseline:l.baseline,height:l.height,
      fragments:l.fragments.map(f=>({text:f.text,x:f.x,width:f.width,bold:f.bold,italic:f.italic,image:f.image&&{width:f.image.width,height:f.image.height}}))}))});
   }finally{editor.destroy();host.remove();}
  }
  const [actual,control]=out;
  return {strictError,strictUnchanged,paintedPages:actual.pixels,actual:{...actual,pixels:undefined,printedPixels:undefined,geometry:undefined},control:{...control,pixels:undefined,printedPixels:undefined,geometry:undefined},
   samePrintPixels:JSON.stringify(actual.printedPixels)===JSON.stringify(control.printedPixels),samePixels:JSON.stringify(actual.pixels)===JSON.stringify(control.pixels),sameGeometry:JSON.stringify(actual.geometry)===JSON.stringify(control.geometry)};
 },{sources,zoom});
 for(const [index,data]of result.paintedPages.entries())writeFileSync(info.outputPath(`page${index+1}.png`),Buffer.from(data.split(',')[1],'base64'));
 delete result.paintedPages;
 writeFileSync(info.outputPath('recovery.json'),JSON.stringify(result,null,2));
 expect(result.strictError).toMatch(/Multi-page floating tables with aligned positions/i);expect(result.strictUnchanged).toBe(true);
 expect(result.control.readOnly).toBe(false);expect(result.actual.readOnly).toBe(true);
 expect(result.actual.tables).toBe(2);expect(result.actual.images).toBe(2);
 expect(result.actual.stories).toBe(2);
 expect(result.actual.floatingDeclarations).toBe(mode==='multiple'?2:1);
 expect(result.actual.sourceUnchanged).toBe(true);expect(result.actual.errors).toEqual([]);
 expect(result.sameGeometry).toBe(true);expect(result.samePixels).toBe(true);expect(result.samePrintPixels).toBe(true);expect(result.actual.screenAfterPrintMatches).toBe(true);expect(result.control.screenAfterPrintMatches).toBe(true);
 expect(result.actual.issues.filter(s=>s.includes('ordinary flow'))).toHaveLength(mode==='multiple'?2:1);
 await openReadOnlyPreview(page,folder+mode+'-unsupported.docx');
 const input=page.getByRole('textbox',{name:'Document text'}),before=await input.inputValue();
 await input.focus();await input.press('ControlOrMeta+End');await input.press('x');expect(await input.inputValue()).toBe(before);
 const download=page.waitForEvent('download');await page.getByRole('button',{name:'Download .docx',exact:true}).click();
 const path=info.outputPath('original.docx');await(await download).saveAs(path);
 expect(unzipSync(readFileSync(path))).toEqual(unzipSync(readFileSync(folder+mode+'-unsupported.docx')));
 await page.locator('.canvas-message summary').click();await expect(page.getByText(/ordinary flow/).first()).toBeVisible();
 await page.screenshot({path:info.outputPath('preview.png'),fullPage:true});
});
