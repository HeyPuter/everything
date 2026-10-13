import {beforeAll,afterAll,it,expect} from 'vitest';
import {JSDOM} from 'jsdom';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {unzipSync,zipSync,strFromU8,strToU8} from 'fflate';
import {DocxPackage} from '../src/engine/docx.js';
import {TextDocument} from '../src/engine/model.js';
import {bodyFieldRanges} from '../src/engine/body-fields.js';
let dom;
beforeAll(()=>{dom=new JSDOM();globalThis.DOMParser=dom.window.DOMParser;globalThis.XMLSerializer=dom.window.XMLSerializer;});
afterAll(()=>{dom.window.close();delete globalThis.DOMParser;delete globalThis.XMLSerializer;});
const source=readFileSync('tests/fixtures/nested-page-fields/control.docx');
const model=p=>new TextDocument(p.paragraphs,p.pageSettings,p.numbering,p.styles,p.tables,p.assets);
const save=async(p,d)=>new Uint8Array(await p.export(d.paragraphs,d.pageSettings,d.numbering,d.styles,d.tables,d.assets).arrayBuffer());
const results=d=>bodyFieldRanges(d.paragraphs).map(r=>({code:r.field.instruction,text:d.text.slice(r.start,r.end)}));

it('imports all nested combinations and preserves an untouched package',async()=>{
 const p=await DocxPackage.open(source),d=model(p),ranges=bodyFieldRanges(d.paragraphs);
 expect(ranges).toHaveLength(17);expect(unzipSync(await save(p,d))).toEqual(p.parts);
 expect(results(d).slice(0,4)).toEqual([{code:' PAGE ',text:'A42Z'},{code:' NUMPAGES ',text:'42'},{code:' PAGE ',text:'A42Z'},{code:' NUMPAGES ',text:'42'}]);
 expect(results(d).slice(-2)).toEqual([{code:' PAGE ',text:'A4\n2Z'},{code:' NUMPAGES ',text:'4\n2'}]);
 expect(d.bookmarks).toHaveLength(4);
});

for(const label of ['complex/complex','complex/simple','simple/complex','simple/simple','Across'])
for(const action of ['insert','replace','empty-refill','split','format','remove-child'])
it(`${label}: ${action} keeps enclosing fields, export, bookmarks and undo`,async()=>{
 const p=await DocxPackage.open(source),d=model(p),at=d.text.indexOf(label+': [')+(label+': [').length;
 const before=results(d),outer=bodyFieldRanges(d.paragraphs).find(r=>r.start===at),inner=bodyFieldRanges(d.paragraphs).find(r=>r.start===at+1);
 expect(outer).toBeTruthy();expect(inner).toBeTruthy();let undos=1;
 if(action==='insert'){d.select(inner.start+1);d.replace('X');}
 if(action==='replace'){d.select(inner.start,inner.end);d.replace('Edited');}
 if(action==='empty-refill'){d.select(inner.start,inner.end);d.replace('');d.select(inner.start);d.replace('Filled');undos=2;}
 if(action==='split'){d.select(inner.start+1);d.replace('\n');}
 if(action==='format'){d.select(inner.start,inner.end);d.toggleItalic();}
 if(action==='remove-child'){d.select(outer.start,outer.end);d.replace('Gone');}
 const out=await save(p,d),again=model(await DocxPackage.open(out));
 expect(again.text).toBe(d.text);expect(results(again)).toEqual(results(d));
 expect(bodyFieldRanges(again.paragraphs)).toHaveLength(action==='remove-child'?16:17);
 const changed=results(d).filter((r,i)=>JSON.stringify(r)!==JSON.stringify(before[i]));expect(changed.length).toBeGreaterThanOrEqual(action==='format'?0:action==='remove-child'?1:2);
 for(const[name,bytes]of Object.entries(p.parts))if(name!=='word/document.xml')expect(unzipSync(out)[name]).toEqual(bytes);
 while(undos--)d.undo();expect(unzipSync(await save(p,d))).toEqual(p.parts);
});

const native=JSON.parse(readFileSync('tests/fixtures/nested-page-fields/native-edits.json','utf8').replace(/^\uFEFF/,''));
it('binds the native observations to the exact source',()=>expect(native.sourceSha256.toLowerCase()).toBe(createHash('sha256').update(source).digest('hex')));
it.each(native.cases)('matches the native reference nested result edit $name and imports its native XML',async ref=>{
 const p=await DocxPackage.open(source),d=model(p),para=d.paragraphs[ref.outer];
 const ranges=bodyFieldRanges(d.paragraphs),outer=ranges.find(r=>r.startParagraph===para.id),inner=ranges[ranges.indexOf(outer)+ref.depth];
 if(ref.name==='insert'){d.select(inner.start+1);d.replace('X');}
 else if(ref.name==='split'){d.select(inner.start+1);d.replace('\n');}
 else {d.select(inner.start,inner.end);d.replace(ref.name==='replace'?'Edited':ref.name==='delete-all'?'':'Filled');}
 const current=bodyFieldRanges(d.paragraphs),a=current.find(r=>r.field.id===outer.field.id),b=current.find(r=>r.field.id===inner.field.id);
 expect(d.text.slice(a.start,a.end)).toBe((ref.outerResult||'').replaceAll('\r','\n'));
 expect(d.text.slice(b.start,b.end)).toBe((ref.innerResult||'').replaceAll('\r','\n'));
 const W='http://schemas.openxmlformats.org/wordprocessingml/2006/main',parts=unzipSync(source),doc=new DOMParser().parseFromString(strFromU8(parts['word/document.xml']),'application/xml');
 doc.documentElement.replaceChild(doc.importNode(new DOMParser().parseFromString(ref.documentXml,'application/xml').documentElement,true),doc.getElementsByTagNameNS(W,'body')[0]);
 parts['word/document.xml']=strToU8(new XMLSerializer().serializeToString(doc));
 const fromWord=model(await DocxPackage.open(zipSync(parts)));
 expect(results(fromWord)).toEqual(results(d));expect(fromWord.text).toBe(d.text);
});

it('preserves every nested lock when rewriting the locked visual control',async()=>{
 const p=await DocxPackage.open(readFileSync('tests/fixtures/nested-page-fields/locked.docx')),d=model(p);
 expect(bodyFieldRanges(d.paragraphs).every(r=>r.field.locked)).toBe(true);
 const inner=bodyFieldRanges(d.paragraphs)[1];d.select(inner.start+1);d.replace('X');
 const again=model(await DocxPackage.open(await save(p,d)));
 expect(bodyFieldRanges(again.paragraphs)).toHaveLength(17);expect(bodyFieldRanges(again.paragraphs).every(r=>r.field.locked)).toBe(true);expect(again.text).toBe(d.text);
});

it('rejects crossing, duplicate and cell boundaries but retains nested fields across sections',()=>{
 const a={id:'a'},b={id:'b'},marker=(field,type,offset,order)=>({field,type,offset,order});
 const outer=marker(a,'start',0,0),inner=marker(b,'start',0,1),innerEnd=marker(b,'end',1,2),outerEnd=marker(a,'end',1,3);
 const p={id:'p',runs:[{text:'x'}],fieldMarkers:[outer,inner,innerEnd,outerEnd]};
 expect(bodyFieldRanges([p]).map(r=>r.parentId)).toEqual([undefined,'a']);
 expect(()=>bodyFieldRanges([{...p,fieldMarkers:[outer,inner,{...outerEnd,order:2},{...innerEnd,order:3}]}])).toThrow('Unmatched');
 expect(()=>bodyFieldRanges([{...p,fieldMarkers:[outer,{...inner,field:a},innerEnd,outerEnd]}])).toThrow('Duplicated');
 const open={...p,fieldMarkers:[outer,inner]},close={...p,id:'q',fieldMarkers:[innerEnd,outerEnd]};
 expect(bodyFieldRanges([{...open,sectionEnd:true},close]).map(r=>r.parentId)).toEqual([undefined,'a']);
 expect(()=>bodyFieldRanges([{...open,cellId:'a'},{...close,cellId:'b'}])).toThrow('table cells');
});

it.each(['empty-start','empty-end','all-empty'])('refills %s without crossing its ancestors',async label=>{
 const p=await DocxPackage.open(source),d=model(p),at=d.text.indexOf(label+': [')+(label+': [').length;
 const empty=bodyFieldRanges(d.paragraphs).find(r=>r.start>=at&&r.start===r.end);
 d.select(empty.start);d.replace('Filled');const again=model(await DocxPackage.open(await save(p,d)));
 expect(again.text).toBe(d.text);expect(results(again)).toEqual(results(d));expect(bodyFieldRanges(again.paragraphs)).toHaveLength(17);
 const ancestors=bodyFieldRanges(again.paragraphs).filter(r=>r.start<=empty.start&&r.end>=empty.start+6);
 expect(ancestors).toHaveLength(label==='all-empty'?3:2);
 d.undo();expect(unzipSync(await save(p,d))).toEqual(p.parts);
});

it('rejects a partial nested boundary edit atomically',async()=>{
 const p=await DocxPackage.open(source),d=model(p),inner=bodyFieldRanges(d.paragraphs)[1];
 d.select(inner.start-1,inner.start+1);const before=d.snapshot();expect(()=>d.replace('X')).toThrow('body field boundary');expect(d.snapshot()).toEqual(before);
});

it.each([
 ['instruction nesting',x=>x.replace('<w:instrText xml:space="preserve"> PAGE </w:instrText>','<w:fldChar w:fldCharType="begin"/>'),'body field instruction'],
 ['unterminated child',x=>x.replace('<w:fldChar w:fldCharType="end"/>',''),'body field'],
])('rejects %s',async(_,change,message)=>{
 const parts=unzipSync(source);parts['word/document.xml']=strToU8(change(strFromU8(parts['word/document.xml'])));
 await expect(DocxPackage.open(zipSync(parts))).rejects.toThrow(message);
});
