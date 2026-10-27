import {test,expect} from '@playwright/test';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {unzipSync} from 'fflate';
import {reopenDocx} from './helpers/reopen-docx.js';
import {expectBodyEditParts} from './helpers/expect-body-edit-parts.js';
import {paintAllPages} from './helpers/paint-pages.js';
const root='tests/fixtures/native-underlines/',ref=JSON.parse(readFileSync(root+'reference.json'));

test('matches native underline offsets and thickness without changing advances or edit/export behavior',async({page},info)=>{
  test.setTimeout(120000);const source=root+'controls.docx',bytes=readFileSync(source),errors=[];
  for(const [path,hash] of [[source,ref.sourceSha256],[root+'native.pdf',ref.pdfSha256]])expect(createHash('sha256').update(readFileSync(path)).digest('hex')).toBe(hash);
  await page.addInitScript(()=>{window.nativeUnderlinePaint=[];const fill=CanvasRenderingContext2D.prototype.fillRect;CanvasRenderingContext2D.prototype.fillRect=function(x,y,w,h){if(this.canvas.classList.contains('canvas-page')&&this.fillStyle==='#008080')window.nativeUnderlinePaint.push({page:Number(this.canvas.dataset.page),x:x*.75,y:y*.75,width:w*.75,height:h*.75});return fill.call(this,x,y,w,h);};});
  page.on('pageerror',e=>errors.push(e.message));await page.goto('/playground.html');
  const available=await page.evaluate(async()=>{const {checkFontAvailability,fontAvailable}=await import('/src/engine/font-availability.js');const names=['Arial','Calibri','Times New Roman','Cambria'];await Promise.all(names.map(checkFontAvailability));return names.every(fontAvailable);});
  test.skip(!available,'The native reference requires installed Arial, Calibri, Times New Roman and Cambria.');
  await page.getByLabel('Open DOCX file').setInputFiles(source);
  const input=page.getByRole('textbox',{name:'Document text'});await expect(input).toHaveValue(/^Arial: bold=False/);await expect(input).toHaveJSProperty('readOnly',false);await expect(page.locator('canvas.canvas-page')).toHaveCount(16);
  const actual=await page.evaluate(async b=>{
    const {DocxPackage}=await import('/src/engine/docx.js'),{loadCanvasFonts,measureCanvasText}=await import('/src/engine/canvas-text.js'),{layoutDocument}=await import('/src/engine/layout.js'),{pageGeometry}=await import('/src/engine/page-settings.js');
    const p=await DocxPackage.open(Uint8Array.from(atob(b),c=>c.charCodeAt(0)));await loadCanvasFonts(p);const ctx=document.createElement('canvas').getContext('2d');
    const measure=(t,s)=>measureCanvasText(ctx,t,s),legacy=(t,s)=>{const m=measure(t,s);delete m.nativeUnderlineOffset;delete m.nativeUnderlineThickness;return m;};
    const make=fn=>layoutDocument(p.paragraphs,fn,pageGeometry(p.pageSettings),p.numbering,p.tables).lines.filter(l=>l.underlines.length).map(l=>({page:l.page,baseline:l.baseline*.75,rects:l.underlines.map(u=>({x:u.x*.75,y:(l.baseline+u.offset)*.75,width:u.width*.75,height:u.thickness*.75}))}));
    return {current:make(measure),previous:make(legacy)};
  },bytes.toString('base64'));
  expect(actual.current).toHaveLength(ref.cases.length);writeFileSync(info.outputPath('geometry.json'),JSON.stringify(actual,null,2));
  await paintAllPages(page);const paint=await page.evaluate(()=>window.nativeUnderlinePaint);
  for(const [i,row] of ref.cases.entries()){
    const a=actual.current[i],previous=actual.previous[i],label=`${row.font} ${row.size} bold=${row.bold} italic=${row.italic}`;
    expect(a.page,label).toBe(row.page);expect(a.rects,label).toHaveLength(1);
    expect(Math.abs(a.baseline-row.baseline),label+' baseline').toBeLessThan(.2);
    for(const key of ['x','y','height'])expect(Math.abs(a.rects[0][key]-row.rect[key]),label+' '+key).toBeLessThan(.2);
    // The reference also exposes existing width differences (notably Cambria
    // 10pt). Do not claim native advance equivalence or let this ink fix change it.
    expect(a.baseline,label+' unchanged baseline').toBe(previous.baseline);
    for(const key of ['x','width'])expect(a.rects[0][key],label+' unchanged '+key).toBe(previous.rects[0][key]);
    expect(paint.some(p=>p.page===a.page&&['x','y','width','height'].every(k=>Math.abs(p[k]-a.rects[0][k])<1e-5)),label+' painted rectangle').toBe(true);
  }
  for(const i of [0,1,4,8,12])writeFileSync(info.outputPath(`page${i+1}.png`),Buffer.from(await page.locator('canvas.canvas-page').nth(i).evaluate(c=>c.toDataURL().split(',')[1]),'base64'));
  const original=await input.inputValue(),parts=unzipSync(bytes);
  const save=async name=>{const pending=page.waitForEvent('download');await page.getByRole('button',{name:'Download .docx',exact:true}).click();const path=info.outputPath(name+'.docx');await(await pending).saveAs(path);return path;};
  const same=(path,edit=false)=>{const out=unzipSync(readFileSync(path));if(edit)return expectBodyEditParts(out,parts);expect(Object.keys(out).sort()).toEqual(Object.keys(parts).sort());for(const n in parts)if(!edit||n!=='word/document.xml')expect(Buffer.from(out[n]).equals(Buffer.from(parts[n])),n).toBe(true);};
  same(await save('noedit'));await input.press('ControlOrMeta+Home');await page.keyboard.insertText('Edited ');const edited=await save('edited');same(edited,true);await input.press('ControlOrMeta+z');await expect(input).toHaveValue(original);same(await save('undo'));await reopenDocx(page,input,edited,'Edited '+original);expect(errors).toEqual([]);
});

test('uses native vertical metrics for ordinary patterned rules and retains other pattern geometry',async({page})=>{
  const patterns=JSON.parse(readFileSync(root+'pattern-reference.json')),bytes=readFileSync(root+'patterns.docx');
  for(const [data,hash] of [[bytes,patterns.sourceSha256],[readFileSync(root+'patterns-native.pdf'),patterns.pdfSha256]])expect(createHash('sha256').update(data).digest('hex')).toBe(hash);
  await page.goto('/playground.html');
  const available=await page.evaluate(async()=>{const {checkFontAvailability,fontAvailable}=await import('/src/engine/font-availability.js');await checkFontAvailability('Arial');return fontAvailable('Arial');});
  test.skip(!available,'The native pattern reference requires installed Arial.');
  const actual=await page.evaluate(async b=>{
    const {DocxPackage}=await import('/src/engine/docx.js'),{loadCanvasFonts,measureCanvasText}=await import('/src/engine/canvas-text.js'),{layoutDocument}=await import('/src/engine/layout.js'),{pageGeometry}=await import('/src/engine/page-settings.js'),{underlineInk}=await import('/src/engine/underlines.js');
    const p=await DocxPackage.open(Uint8Array.from(atob(b),c=>c.charCodeAt(0)));await loadCanvasFonts(p);const ctx=document.createElement('canvas').getContext('2d');
    const measure=(t,s)=>measureCanvasText(ctx,t,s),legacy=(t,s)=>{const m=measure(t,s);delete m.nativeUnderlineOffset;delete m.nativeUnderlineThickness;return m;};
    const make=fn=>layoutDocument(p.paragraphs,fn,pageGeometry(p.pageSettings),p.numbering,p.tables).lines.filter(l=>l.underlines.length).map(l=>({page:l.page,baseline:l.baseline*.75,ink:l.underlines.map(u=>underlineInk(u)),spans:l.underlines}));
    return {current:make(measure),legacy:make(legacy)};
  },bytes.toString('base64'));
  expect(actual.current).toHaveLength(patterns.cases.length);
  for(const [i,row] of patterns.cases.entries()){
    const line=actual.current[i];
    if(['single','words','dotted','dash','dashLong','dotDash','dotDotDash'].includes(row.pattern)){
      const rects=line.ink.flatMap(i=>i.rects),top=Math.min(...rects.map(r=>r.y))*.75+line.baseline,bottom=Math.max(...rects.map(r=>r.y+r.height))*.75+line.baseline;
      expect(Math.abs(top-row.top),`${row.page} ${row.pattern} top`).toBeLessThan(.2);expect(Math.abs(bottom-row.bottom),`${row.page} ${row.pattern} bottom`).toBeLessThan(.2);
    } else expect(line,`${row.page} ${row.pattern} retained`).toEqual(actual.legacy[i]);
  }
});
