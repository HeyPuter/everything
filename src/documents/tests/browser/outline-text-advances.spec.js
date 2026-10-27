import {test,expect} from '@playwright/test';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {unzipSync} from 'fflate';
import {reopenDocx} from './helpers/reopen-docx.js';
import {paintAllPages} from './helpers/paint-pages.js';
const root='tests/fixtures/outline-text-advances/', path=root+'control.docx', bytes=readFileSync(path);
const reference=JSON.parse(readFileSync(root+'reference.json')), cases=JSON.parse(readFileSync(root+'cases.json'));

test('uses native reference outline advances and preserves the independent document through editing',async({page},info)=>{
 test.setTimeout(120000);expect(createHash('sha256').update(bytes).digest('hex')).toBe(reference.sourceSha256);
 await page.addInitScript(()=>{window.outlineMarkers=[];const original=CanvasRenderingContext2D.prototype.fillText;CanvasRenderingContext2D.prototype.fillText=function(text,x,y,...args){if(this.canvas.classList?.contains('canvas-page')&&/^Control \d\d:.*END$/.test(text)){const m=this.getTransform(),w=this.measureText(text.slice(0,-3)).width;window.outlineMarkers.push({page:Number(text.slice(8,10)),x:(m.a*(x+w)+m.c*y+m.e)/devicePixelRatio*.75});}return original.call(this,text,x,y,...args);};});
 await page.goto('/playground.html');
 const result=await page.evaluate(async({data,cases})=>{
  const {prepareCanvasFont,fontAvailable}=await import('/src/engine/font-availability.js');
  for(const font of ['Cambria','Arial','Calibri']){await prepareCanvasFont(font);if(!fontAvailable(font))return {missing:font};}
  const {DocxPackage}=await import('/src/engine/docx.js'),{validateCanvasLayout,measureCanvasText}=await import('/src/engine/canvas-text.js');
  const {layoutDocument,caretRect,hitTest}=await import('/src/engine/layout.js'),{pageGeometry}=await import('/src/engine/page-settings.js');
  const p=await DocxPackage.open(Uint8Array.from(atob(data),c=>c.charCodeAt(0)));await validateCanvasLayout(p);const c=document.createElement('canvas').getContext('2d');
  const l=layoutDocument(p.paragraphs,(t,s)=>measureCanvasText(c,t,s),pageGeometry(p.pageSettings),p.numbering,p.tables,p.pageStories,{styles:p.styles});
  let calls=0;const nativeMeasure=c.measureText.bind(c);c.measureText=text=>{calls++;return nativeMeasure(text);};
  const markers=cases.map(a=>57.6+measureCanvasText(c,`Control ${String(a.index).padStart(2,'0')}: HAMBURG AVENUE | WINTER 2048`,{fontFamily:a.font,fontSize:a.size,bold:a.bold,ligatures:'none',kerning:0}).width*.75);
  const rows=l.lines.filter(l=>l.fragments.some(f=>f.text)).map(l=>({page:l.page,text:l.fragments.map(f=>f.text||'').join(''),x:l.fragments[0].x*.75,y:l.baseline*.75}));
  const caretHits=l.lines.filter(l=>l.fragments.some(f=>f.text?.startsWith('Control'))).map(line=>{const at=line.start+8,r=caretRect(l,at);return hitTest(l,r.page,r.x,r.y+r.height/2)===at;});
  return {markers,rows,caretHits,pages:l.pageCount,calls};
 },{data:bytes.toString('base64'),cases});
 test.skip(!!result.missing,`Native reference requires ${result.missing}.`);
 expect(result.pages).toBe(24);expect(result.caretHits.every(Boolean)).toBe(true);
 expect(result.calls).toBe(cases.length);
 for(const marker of reference.markers)expect(Math.abs(result.markers[marker.page]-marker.x),JSON.stringify({marker,actual:result.markers[marker.page]})).toBeLessThan(.3);
 expect(result.rows).toHaveLength(reference.rows.length);
 reference.rows.forEach((r,i)=>{const a=result.rows[i];expect(a.text.trim()).toBe(r.text.trim());expect(a.page).toBe(r.page);expect(Math.abs(a.x-r.x)).toBeLessThan(.3);expect(Math.abs(a.y-r.y)).toBeLessThan(.3);});
 await page.getByLabel('Open DOCX file').setInputFiles(path);const input=page.getByRole('textbox',{name:'Document text'});await expect(input).toHaveValue(/^Control 00/);await expect(input).toHaveJSProperty('readOnly',false);await expect(page.locator('canvas.canvas-page')).toHaveCount(24);
 await paintAllPages(page);const painted=await page.evaluate(()=>window.outlineMarkers);for(const marker of reference.markers)expect(painted.some(p=>p.page===marker.page&&Math.abs(p.x-marker.x)<.3),JSON.stringify(marker)).toBe(true);
 const original=await input.inputValue(),parts=unzipSync(bytes),save=async name=>{const pending=page.waitForEvent('download');await page.getByRole('button',{name:'Download .docx',exact:true}).click();const dest=info.outputPath(name+'.docx');await(await pending).saveAs(dest);return dest;};
 expect(unzipSync(readFileSync(await save('noedit')))).toEqual(parts);await input.press('ControlOrMeta+Home');await page.keyboard.insertText('Edited ');const edited=await save('edited'),exported=unzipSync(readFileSync(edited));for(const[n,data]of Object.entries(parts))if(n!=='word/document.xml')expect(exported[n]).toEqual(data);
 await input.press('ControlOrMeta+z');await expect(input).toHaveValue(original);expect(unzipSync(readFileSync(await save('undo')))).toEqual(parts);await reopenDocx(page,input,edited,'Edited '+original);await expect(input).toHaveJSProperty('readOnly',false);
});
