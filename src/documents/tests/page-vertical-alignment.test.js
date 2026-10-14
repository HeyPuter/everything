import {beforeAll,afterAll,it,expect} from 'vitest';
import {JSDOM} from 'jsdom';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {unzipSync,zipSync,strFromU8,strToU8} from 'fflate';
import {DocxPackage,createDocx,W} from '../src/engine/docx.js';
import {TextDocument,paragraph} from '../src/engine/model.js';
import {pageGeometry,validatePageSettings} from '../src/engine/page-settings.js';
import {layoutDocument,caretRect,hitTest} from '../src/engine/layout.js';
import { expectBodyEditParts } from './helpers/expect-body-edit-parts.js';
let dom;
beforeAll(()=>{dom=new JSDOM();globalThis.DOMParser=dom.window.DOMParser;globalThis.XMLSerializer=dom.window.XMLSerializer;});
afterAll(()=>{dom.window.close();delete globalThis.DOMParser;delete globalThis.XMLSerializer;});
const folder='tests/fixtures/page-vertical-alignment/',bytes=readFileSync(folder+'control.docx');
const ref=JSON.parse(readFileSync(folder+'reference.json'));
const model=p=>new TextDocument(p.paragraphs,p.pageSettings,p.numbering,p.styles,p.tables,p.assets);
const measure=(t,s)=>({width:t.length*6,ascent:12,descent:4});
const layout=d=>layoutDocument(d.paragraphs,measure,pageGeometry(d.pageSettings),d.numbering,d.tables);
const save=async(p,d)=>new Uint8Array(await p.export(d.paragraphs,d.pageSettings,d.numbering,d.styles,d.tables,d.assets).arrayBuffer());
const same=(a,b)=>{expect(Object.keys(a)).toEqual(Object.keys(b));for(const n of Object.keys(a))expect(Buffer.from(a[n]).equals(Buffer.from(b[n])),n).toBe(true);};
it('pins the floating-table controls and the final-page specification divergence',()=>{
 const floating=JSON.parse(readFileSync(folder+'floating-reference.json'));
 expect(createHash('sha256').update(readFileSync(folder+'floating.docx')).digest('hex')).toBe(floating.sourceSha256);
 expect(createHash('sha256').update(readFileSync(folder+'floating-native.pdf')).digest('hex')).toBe(floating.pdfSha256);
 expect(floating.pages).toHaveLength(8);
 expect(ref.pages.at(-1).at(-1).y-ref.pages.at(-1)[0].y).toBeGreaterThan(600);
});
it('pins independent reference inputs and preserves section alignments through edit, reopen and exact undo',async()=>{
 expect(createHash('sha256').update(bytes).digest('hex')).toBe(ref.sourceSha256);
 expect(createHash('sha256').update(readFileSync(folder+'native.pdf')).digest('hex')).toBe(ref.pdfSha256);
 const p=await DocxPackage.open(bytes),d=model(p),before=layout(d);
 expect(before.pageCount).toBe(29);same(unzipSync(await save(p,d)),p.parts);
 expect(d.setPageSettings({verticalAlignment:'bottom'})).toBe(true);d.undo();
 d.select(0);d.replace('Edited ');
 const out=await save(p,d),again=await DocxPackage.open(out);
 expect(again.pageSettings.verticalAlignment).toBe('both');expect(model(again).text).toBe(d.text);
 expectBodyEditParts(unzipSync(out),p.parts);
 d.undo();expect(layout(d)).toEqual(before);same(unzipSync(await save(p,d)),p.parts);
},30000);
it('authors and edits single-section alignment without rewriting other package parts',async()=>{
 const authored=new TextDocument([paragraph('Alpha')],{verticalAlignment:'center'});
 const fresh=createDocx(authored.paragraphs,authored.pageSettings);
 const pkg=await DocxPackage.open(await save(fresh,authored)),d=model(pkg);
 expect(pkg.pageSettings.verticalAlignment).toBe('center');d.setPageSettings({verticalAlignment:'bottom'});
 const out=await save(pkg,d),again=await DocxPackage.open(out);expect(again.pageSettings.verticalAlignment).toBe('bottom');
 const parts=unzipSync(out);for(const [n,b]of Object.entries(pkg.parts))if(n!=='word/document.xml')expect(Buffer.from(parts[n]).equals(Buffer.from(b)),n).toBe(true);
 d.undo();same(unzipSync(await save(pkg,d)),pkg.parts);
});
it.each(['center','bottom','both'])('moves caret geometry with %s body alignment',alignment=>{
 const paragraphs=['Alpha','Beta','Gamma'].map(t=>paragraph(t,{format:{lineRule:'exact',lineSpacing:18,spaceAfter:0}}));
 const doc=new TextDocument(paragraphs,{verticalAlignment:alignment}),result=layout(doc);
 for(const line of result.lines){const c=caretRect(result,line.start);expect(hitTest(result,c.page,c.x,c.y+c.height/2)).toBe(line.start);}
 const ys=result.lines.map(l=>l.y*.75);
 expect(ys).toEqual(alignment==='center'?[369,387,405]:alignment==='bottom'?[666,684,702]:[72,387,702]);
});
it.each(['invalid','missing','duplicate','attribute','text'])('rejects %s vertical alignment before editable attachment',async kind=>{
 const parts=unzipSync(bytes),xml=new DOMParser().parseFromString(strFromU8(parts['word/document.xml']),'application/xml');
 const n=xml.getElementsByTagNameNS(W,'vAlign')[0];
 if(kind==='invalid')n.setAttributeNS(W,'w:val','middle');
 if(kind==='missing')n.removeAttributeNS(W,'val');
 if(kind==='duplicate')n.parentElement.append(n.cloneNode(true));
 if(kind==='attribute')n.setAttribute('other','1');
 if(kind==='text')n.append('unexpected');
 parts['word/document.xml']=strToU8(new XMLSerializer().serializeToString(xml));
 await expect(DocxPackage.open(zipSync(parts))).rejects.toThrow(/vertical|page settings/);
});
it('keeps unverified column interactions explicit and validates model values',()=>{
 expect(()=>validatePageSettings({verticalAlignment:'middle'})).toThrow();
 const d=new TextDocument([paragraph('Alpha')],{verticalAlignment:'center',columns:{count:2,equalWidth:true,separator:false,space:720}});
 expect(()=>layout(d)).toThrow(/Vertical page alignment with columns/);
});
