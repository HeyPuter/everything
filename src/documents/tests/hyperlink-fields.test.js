import {beforeAll,afterAll,it,expect} from 'vitest';
import {JSDOM} from 'jsdom';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {unzipSync,zipSync,strFromU8,strToU8} from 'fflate';
import {DocxPackage} from '../src/engine/docx.js';
import {TextDocument} from '../src/engine/model.js';
import {bodyFieldRanges} from '../src/engine/body-fields.js';
import {bodyFieldInstruction} from '../src/engine/docx-body-fields.js';
import {openableHyperlink} from '../src/engine/hyperlinks.js';
let dom;beforeAll(()=>{dom=new JSDOM();globalThis.DOMParser=dom.window.DOMParser;globalThis.XMLSerializer=dom.window.XMLSerializer;});
afterAll(()=>{dom.window.close();delete globalThis.DOMParser;delete globalThis.XMLSerializer;});
const source=readFileSync('tests/fixtures/hyperlink-fields/control.docx');
const model=p=>new TextDocument(p.paragraphs,p.pageSettings,p.numbering,p.styles,p.tables,p.assets);
const save=async(p,d)=>new Uint8Array(await p.export(d.paragraphs,d.pageSettings,d.numbering,d.styles,d.tables,d.assets).arrayBuffer());

it('matches independent native reference hyperlink destinations, flags and empty results',async()=>{
 const native=JSON.parse(readFileSync('tests/fixtures/hyperlink-fields/native-links.json','utf8').replace(/^\uFEFF/,'')),reference=JSON.parse(readFileSync('tests/fixtures/hyperlink-fields/reference.json','utf8'));
 const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
 expect(native.sourceSha256).toBe(hash(source));expect(reference.sourceSha256).toBe(hash(source));expect(reference.pdfSha256).toBe(hash(readFileSync('tests/fixtures/hyperlink-fields/native.pdf')));
 const d=model(await DocxPackage.open(source)),fields=bodyFieldRanges(d.paragraphs).filter(r=>r.field.type==='HYPERLINK');
 expect(fields).toHaveLength(native.links.length);
 for(const [i,r]of fields.entries()){
  const link=r.field.resultLink,expected=native.links[i];
  expect(d.text.slice(r.start,r.end)).toBe((expected.text||'').replaceAll('\r','\n'));
  expect({address:link.target||null,anchor:link.anchor||null,tooltip:link.tooltip||null,frame:link.frame||null}).toEqual({address:expected.address,anchor:expected.anchor,tooltip:expected.tooltip,frame:expected.frame});
 }
});

it('imports simple, complex, empty and paragraph-spanning field links without changing the package',async()=>{
 const p=await DocxPackage.open(source),d=model(p),ranges=bodyFieldRanges(d.paragraphs);
 expect(ranges).toHaveLength(8);expect(ranges.filter(r=>r.field.type==='HYPERLINK')).toHaveLength(7);
 expect(unzipSync(await save(p,d))).toEqual(p.parts);
 d.select(ranges[0].start+1);expect(d.hyperlink.link).toMatchObject({anchor:'Target',fieldId:ranges[0].field.id,tooltip:'Jump to target'});
 d.select(ranges[3].start+1);expect(d.hyperlink.link).toMatchObject({target:'https://example.com/reference?q=a%20b',frame:'_blank'});
});

for(const index of [0,1,2,3,4,6,7])it(`edits field ${index+1} without adding duplicate wrappers or losing instructions`,async()=>{
 const p=await DocxPackage.open(source),d=model(p),r=bodyFieldRanges(d.paragraphs)[index],codes=bodyFieldRanges(d.paragraphs).map(r=>r.field.instruction);
 d.select(r.start===r.end?r.start:r.start+1);d.replace('Inserted');const out=await save(p,d),again=model(await DocxPackage.open(out));
 expect(again.text).toBe(d.text);expect(bodyFieldRanges(again.paragraphs).map(r=>r.field.instruction)).toEqual(codes);
 expect(again.paragraphs.flatMap(p=>p.runs).filter(r=>r.text.includes('Inserted')).every(r=>r.link?.fieldId)).toBe(true);
 expect(strFromU8(unzipSync(out)['word/document.xml'])).not.toContain('<w:hyperlink');
 for(const[name,bytes]of Object.entries(p.parts))if(name!=='word/document.xml')expect(unzipSync(out)[name]).toEqual(bytes);
 d.undo();expect(unzipSync(await save(p,d))).toEqual(p.parts);
});

it.each(['remove','retarget'])('converts a cross-paragraph field to explicit links when choosing %s on only one paragraph',async action=>{
 const p=await DocxPackage.open(source),d=model(p),r=bodyFieldRanges(d.paragraphs)[4];d.select(r.start+1);
 if(action==='remove')d.removeHyperlink();else d.setHyperlink('https://example.com/changed');
 const out=await save(p,d),again=model(await DocxPackage.open(out));expect(again.text).toBe(d.text);expect(bodyFieldRanges(again.paragraphs)).toHaveLength(7);
 again.select(r.start+1);expect(again.hyperlink?.link.target).toBe(action==='remove'?undefined:'https://example.com/changed');
 again.select(r.end-1);expect(again.hyperlink.link.anchor).toBe('Target');
 expect(bodyFieldRanges(again.paragraphs).find(r=>r.field.type==='PAGEREF')).toMatchObject({startLink:{anchor:'Target'},endLink:{anchor:'Target'}});
 d.undo();expect(unzipSync(await save(p,d))).toEqual(p.parts);
});

it('keeps typing outside a field from inheriting its hidden link ownership',async()=>{
 const p=await DocxPackage.open(source),d=model(p),r=bodyFieldRanges(d.paragraphs)[0];d.select(r.end);d.replace('Outside');
 expect(d.paragraphs.flatMap(p=>p.runs).find(r=>r.text.includes('Outside'))?.link?.fieldId).toBeUndefined();
 expect(model(await DocxPackage.open(await save(p,d))).text).toBe(d.text);
});

it.each(['HYPERLINK "javascript:alert(1)"','HYPERLINK "vbscript:msgbox(1)"','HYPERLINK "data:text/html,x"','HYPERLINK \\m "x"','HYPERLINK \\l','HYPERLINK "https://example.com" \\l "Target"'])('keeps unsupported destination %s guarded',instruction=>expect(()=>bodyFieldInstruction(instruction)).toThrow());

it.each(['HYPERLINK "javascript:alert(1)"','HYPERLINK "vbscript:msgbox(1)"'])('names a script link, %s, plainly in the read-only notice',instruction=>{
 expect(()=>bodyFieldInstruction(instruction)).toThrow(/This document contains a HYPERLINK field to a script or data address,/);
});

// Like a w:hyperlink element with the same target, a HYPERLINK field to a file, relative path or UNC path is kept
// as it is: the document stays editable, the link is shown but never followed, and the field saves unchanged.
it.each([['relative.docx','relative.docx'],['file:///C:/docs/report.pdf','file:///C:/docs/report.pdf'],['\\\\\\\\server\\\\share\\\\report.pdf','\\\\server\\share\\report.pdf']])('retains a field link to %s, not followed',async(code,target)=>{
 expect(bodyFieldInstruction(`HYPERLINK "${code}"`).hyperlink).toMatchObject({target,retainedTarget:true});
 const parts=unzipSync(source),xml=strFromU8(parts['word/document.xml']);
 const at=xml.indexOf('<w:body>')+'<w:body>'.length;
 parts['word/document.xml']=strToU8(xml.slice(0,at)+`<w:p><w:r><w:t xml:space="preserve">See </w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> HYPERLINK "${code}" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>the report</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`+xml.slice(at));
 const bytes=zipSync(parts),p=await DocxPackage.open(bytes),d=model(p);
 expect(p.readOnly).toBeFalsy();
 expect(unzipSync(await save(p,d))).toEqual(unzipSync(bytes));
 d.select(d.text.indexOf('the report')+4);expect(d.hyperlink.link).toMatchObject({target,retainedTarget:true});expect(openableHyperlink(d.hyperlink.link)).toBe(false);
 d.replace('final ');
 const again=model(await DocxPackage.open(await save(p,d)));
 expect(again.text.startsWith('See the final report\n')).toBe(true);
 expect(bodyFieldRanges(again.paragraphs)[0].field.instruction).toBe(` HYPERLINK "${code}" `);
});

it('renames linked bookmarks through repeated edits and split instruction runs',async()=>{
 const W='http://schemas.openxmlformats.org/wordprocessingml/2006/main',parts=unzipSync(source),doc=new DOMParser().parseFromString(strFromU8(parts['word/document.xml']),'application/xml');
 const text=doc.getElementsByTagNameNS(W,'instrText')[0],value=text.textContent,at=value.indexOf('Target')+6,tail=text.parentNode.cloneNode(true);
 text.textContent=value.slice(0,at);tail.getElementsByTagNameNS(W,'instrText')[0].textContent=value.slice(at);text.parentNode.after(tail);
 parts['word/document.xml']=strToU8(new XMLSerializer().serializeToString(doc));
 const p=await DocxPackage.open(zipSync(parts)),d=model(p),id=d.bookmarks[0].id;
 for(const name of ['TargetExtended','T']){
  d.renameBookmark(id,name);const out=await save(p,d),again=model(await DocxPackage.open(out));
  expect(again.bookmarks[0].name).toBe(name);expect(bodyFieldRanges(again.paragraphs).filter(r=>r.field.bookmark).every(r=>r.field.bookmark===name)).toBe(true);
  expect(again.paragraphs.flatMap(p=>p.runs).filter(r=>r.link?.anchor).every(r=>r.link.anchor===name)).toBe(true);
  const written=new DOMParser().parseFromString(strFromU8(unzipSync(out)['word/document.xml']),'application/xml');
  expect(written.getElementsByTagNameNS(W,'instrText').length).toBe(doc.getElementsByTagNameNS(W,'instrText').length);
 }
 d.undo();d.undo();expect(unzipSync(await save(p,d))).toEqual(p.parts);
});
