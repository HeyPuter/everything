import {beforeAll,afterAll,it,expect} from 'vitest';
import {JSDOM} from 'jsdom';
import {readFileSync} from 'node:fs';
import {unzipSync,zipSync,strFromU8,strToU8} from 'fflate';
import {DocxPackage} from '../src/engine/docx.js';
import {TextDocument} from '../src/engine/model.js';
import {bodyFieldRanges} from '../src/engine/body-fields.js';
let dom;
beforeAll(()=>{dom=new JSDOM();globalThis.DOMParser=dom.window.DOMParser;globalThis.XMLSerializer=dom.window.XMLSerializer;});
afterAll(()=>{dom.window.close();delete globalThis.DOMParser;delete globalThis.XMLSerializer;});
const source=readFileSync('tests/fixtures/body-page-fields/control.docx');
const native=JSON.parse(readFileSync('tests/fixtures/body-page-fields/native-edits.json','utf8').replace(/^\uFEFF/,''));
const model=p=>new TextDocument(p.paragraphs,p.pageSettings,p.numbering,p.styles,p.tables,p.assets);
const save=async(p,d)=>new Uint8Array(await p.export(d.paragraphs,d.pageSettings,d.numbering,d.styles,d.tables,d.assets).arrayBuffer());
const W='http://schemas.openxmlformats.org/wordprocessingml/2006/main';
for(const ref of native.cases)it(`matches native ${ref.name}, including field boundaries, export and undo`,async()=>{
 const p=await DocxPackage.open(source),d=model(p),first=bodyFieldRanges(d.paragraphs)[0];
 expect(unzipSync(await save(p,d))).toEqual(p.parts);
 switch(ref.name){
  case 'insert':d.select(first.start+1);d.replace('X');break;
  case 'replace':d.select(first.start,first.end);d.replace('Edited');break;
  case 'delete-all':d.select(first.start,first.end);d.replace('');break;
  case 'split':d.select(first.start+1);d.replace('\n');break;
  case 'format':d.select(first.start,first.end);d.toggleItalic();break;
 }
 const out=await save(p,d),again=model(await DocxPackage.open(out));
 for(const current of [d,again]){
  const ranges=bodyFieldRanges(current.paragraphs);expect(ranges).toHaveLength(ref.fieldCount);
  expect(current.text.slice(ranges[0].start,ranges[0].end)).toBe((ref.firstResult??'').replaceAll('\r','\n'));
  expect(ranges[0].field.instruction.trim()).toBe(ref.firstCode.trim());
  if(ref.name==='format')expect(current.paragraphs.find(p=>p.id===ranges[0].startParagraph).runs.find(r=>r.text==='99')).toMatchObject({italic:true,bold:true,fontSize:14});
 }
 expect(again.text).toBe(d.text);
 for(const[name,bytes]of Object.entries(p.parts))if(name!=='word/document.xml')expect(unzipSync(out)[name]).toEqual(bytes);
 d.undo();expect(unzipSync(await save(p,d))).toEqual(p.parts);
 d.redo();expect(d.text).toBe(again.text);
},30000);
it('refills an empty result without losing the field',async()=>{
 const p=await DocxPackage.open(source),d=model(p),r=bodyFieldRanges(d.paragraphs)[0];d.select(r.start,r.end);d.replace('');d.select(r.start);d.replace('Filled');
 const again=model(await DocxPackage.open(await save(p,d))),a=bodyFieldRanges(again.paragraphs)[0];expect(again.text.slice(a.start,a.end)).toBe('Filled');expect(bodyFieldRanges(again.paragraphs)).toHaveLength(15);
});
it('keeps search replacement inside the result and removes a fully surrounded field',async()=>{
 const p=await DocxPackage.open(source),d=model(p);expect(d.replaceMatches('99','7',{},true)).toBe(14);
 const again=model(await DocxPackage.open(await save(p,d)));expect(bodyFieldRanges(again.paragraphs)).toHaveLength(15);expect(again.text).toBe(d.text);
 d.undo();const r=bodyFieldRanges(d.paragraphs)[0];d.select(r.start-1,r.end+1);d.replace('Gone');expect(bodyFieldRanges(d.paragraphs)).toHaveLength(14);
 expect(bodyFieldRanges(model(await DocxPackage.open(await save(p,d))).paragraphs)).toHaveLength(14);
 d.undo();expect(unzipSync(await save(p,d))).toEqual(p.parts);
});
it('rejects unsupported partial boundary edits and table insertion atomically',async()=>{
 const p=await DocxPackage.open(source),d=model(p),r=bodyFieldRanges(d.paragraphs)[0];
 d.select(r.start-1,r.start+1);const before=d.snapshot();expect(()=>d.replace('X')).toThrow('body field boundary');expect(d.snapshot()).toEqual(before);
 d.select(r.start+1);const at=d.snapshot();expect(()=>d.insertTable(2,2,6000)).toThrow('inside body fields');expect(d.snapshot()).toEqual(at);
});
it.each(native.cases)('imports native $name field boundaries, not just its own exports',async ref=>{
 const parts=unzipSync(source),doc=new DOMParser().parseFromString(strFromU8(parts['word/document.xml']),'application/xml');
 const body=new DOMParser().parseFromString(ref.documentXml,'application/xml').documentElement;
 doc.documentElement.replaceChild(doc.importNode(body,true),doc.getElementsByTagNameNS(W,'body')[0]);parts['word/document.xml']=strToU8(new XMLSerializer().serializeToString(doc));
 const p=await DocxPackage.open(zipSync(parts)),d=model(p),ranges=bodyFieldRanges(d.paragraphs);
 expect(ranges).toHaveLength(ref.fieldCount);expect(d.text.slice(ranges[0].start,ranges[0].end)).toBe((ref.firstResult??'').replaceAll('\r','\n'));
 d.select(0);d.replace('Before ');const again=model(await DocxPackage.open(await save(p,d)));expect(again.text).toBe(d.text);expect(bodyFieldRanges(again.paragraphs)).toHaveLength(15);
 d.undo();expect(unzipSync(await save(p,d))).toEqual(p.parts);
});
it.each(['row','column','table'])('preserves field ownership through table %s operations',async kind=>{
 const p=await DocxPackage.open(source),d=model(p),r=bodyFieldRanges(d.paragraphs)[5];d.select(r.start);
 if(kind==='row')d.insertTableRow();else if(kind==='column')d.insertTableColumn();else d.deleteTablePart('table');
 const again=model(await DocxPackage.open(await save(p,d)));expect(again.text).toBe(d.text);expect(bodyFieldRanges(again.paragraphs)).toHaveLength(kind==='table'?13:15);
 d.undo();expect(unzipSync(await save(p,d))).toEqual(p.parts);
});
it('keeps a bookmark inside the field result when editing its paragraph',async()=>{
 const parts=unzipSync(source),doc=new DOMParser().parseFromString(strFromU8(parts['word/document.xml']),'application/xml');
 const field=doc.getElementsByTagNameNS(W,'fldChar')[0].parentNode.parentNode,sep=[...field.children].find(r=>r.getElementsByTagNameNS(W,'fldChar')[0]?.getAttributeNS(W,'fldCharType')==='separate');
 const start=doc.createElementNS(W,'w:bookmarkStart');start.setAttributeNS(W,'w:id','77');start.setAttributeNS(W,'w:name','FieldResult');
 const end=doc.createElementNS(W,'w:bookmarkEnd');end.setAttributeNS(W,'w:id','77');field.insertBefore(start,sep.nextSibling);field.insertBefore(end,field.lastElementChild.previousSibling);
 parts['word/document.xml']=strToU8(new XMLSerializer().serializeToString(doc));const p=await DocxPackage.open(zipSync(parts)),d=model(p),r=bodyFieldRanges(d.paragraphs)[0];d.select(r.start+1);d.replace('X');
 const out=await save(p,d),xml=new DOMParser().parseFromString(strFromU8(unzipSync(out)['word/document.xml']),'application/xml');
 const paragraph=xml.getElementsByTagNameNS(W,'bookmarkStart')[0].parentNode;
 const order=[...paragraph.children].flatMap(n=>n.localName.startsWith('bookmark')?[n.localName]:[...n.getElementsByTagNameNS(W,'fldChar')].map(f=>f.getAttributeNS(W,'fldCharType')));
 expect(order).toEqual(['begin','separate','bookmarkStart','bookmarkEnd','end']);
 const again=model(await DocxPackage.open(out));expect(again.text).toBe(d.text);expect(again.bookmarks[0].name).toBe('FieldResult');
});
it('guards bookmarks inside field instructions instead of moving them into the result',async()=>{
 const parts=unzipSync(source),doc=new DOMParser().parseFromString(strFromU8(parts['word/document.xml']),'application/xml');
 const code=doc.getElementsByTagNameNS(W,'instrText')[0].parentNode;
 for(const name of ['bookmarkStart','bookmarkEnd']){
  const marker=doc.createElementNS(W,`w:${name}`);marker.setAttributeNS(W,'w:id','88');
  if(name==='bookmarkStart')marker.setAttributeNS(W,'w:name','Instruction');code.parentNode.insertBefore(marker,code);
 }
 parts['word/document.xml']=strToU8(new XMLSerializer().serializeToString(doc));
 await expect(DocxPackage.open(zipSync(parts))).rejects.toThrow('bookmarks inside a body field instruction');
});
it('retains a simple wrapper for result edits and converts it only when split across paragraphs',async()=>{
 const p=await DocxPackage.open(source),d=model(p),r=bodyFieldRanges(d.paragraphs)[2];d.select(r.start,r.end);d.replace('42');
 const edited=await save(p,d),xml=new DOMParser().parseFromString(strFromU8(unzipSync(edited)['word/document.xml']),'application/xml');
 expect(xml.getElementsByTagNameNS(W,'fldSimple')).toHaveLength(4);
 d.select(r.start+1);d.replace('\n');const split=await save(p,d),again=model(await DocxPackage.open(split)),field=bodyFieldRanges(again.paragraphs)[2];expect(again.text.slice(field.start,field.end)).toBe('4\n2');expect(field.field.simple).toBeUndefined();
 d.undo();d.undo();expect(unzipSync(await save(p,d))).toEqual(p.parts);
});

// Restoring a version while co-editing replaces the content of a model that may have had no fields.
it('keeps a restored version\'s fields in place as the text around them is edited',async()=>{
 const p=await DocxPackage.open(source),version=model(p),fields=bodyFieldRanges(version.paragraphs).map(r=>version.text.slice(r.start,r.end));
 const current=new TextDocument([{id:'plain',runs:[{text:'Plain text',properties:'',overrides:{}}]}]);
 current.restore({...version.snapshot(),selection:{anchor:0,focus:0}});
 // Typed in the first field's paragraph, before the field.
 const at=current.text.indexOf('Body PAGE:');current.select(at);current.replace('Typed first. ');
 expect(bodyFieldRanges(current.paragraphs).map(r=>current.text.slice(r.start,r.end))).toEqual(fields);
 const bytes=await save(p,current),again=model(await DocxPackage.open(bytes));
 expect(bodyFieldRanges(again.paragraphs).map(r=>again.text.slice(r.start,r.end))).toEqual(fields);
});
