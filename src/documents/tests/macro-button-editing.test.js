import {beforeAll,afterAll,it,expect} from 'vitest';
import {JSDOM} from 'jsdom';
import {readFileSync} from 'node:fs';
import {unzipSync} from 'fflate';
import {DocxPackage} from '../src/engine/docx.js';
import {TextDocument} from '../src/engine/model.js';
import {bodyFieldRanges} from '../src/engine/body-fields.js';
const source=readFileSync('tests/fixtures/macro-buttons/editing.docx');
const native=JSON.parse(readFileSync('tests/fixtures/macro-buttons/native-edits.json','utf8').replace(/^\uFEFF/,''));
let dom;
beforeAll(()=>{dom=new JSDOM();globalThis.DOMParser=dom.window.DOMParser;globalThis.XMLSerializer=dom.window.XMLSerializer;});
afterAll(()=>{dom.window.close();delete globalThis.DOMParser;delete globalThis.XMLSerializer;});
const model=p=>new TextDocument(p.paragraphs,p.pageSettings,p.numbering,p.styles,p.tables,p.assets);
const save=async(p,d)=>new Uint8Array(await p.export(d.paragraphs,d.pageSettings,d.numbering,d.styles,d.tables,d.assets).arrayBuffer());
it('loads all nine instruction-backed prompts editably and preserves an untouched package',async()=>{
 const p=await DocxPackage.open(source),d=model(p);
 expect(p.readOnly).not.toBe(true);expect(bodyFieldRanges(d.paragraphs)).toHaveLength(9);
 expect(d.text).toContain('Cached: Instruction label | end');expect(d.text).not.toContain('Stale cached');
 expect(unzipSync(await save(p,d))).toEqual(p.parts);
 d.select(0);d.replace('Before ');const reopened=model(await DocxPackage.open(await save(p,d)));
 expect(reopened.text).toBe(d.text);expect(bodyFieldRanges(reopened.paragraphs).map(r=>r.field.source)).toEqual(bodyFieldRanges(d.paragraphs).map(r=>r.field.source));
 d.undo();expect(unzipSync(await save(p,d))).toEqual(p.parts);
});
it.each(native.cases.filter(c=>c.name.startsWith('select-replace')))('matches native $name replacement, export/reopen and exact undo',async ref=>{
 const p=await DocxPackage.open(source),d=model(p),r=bodyFieldRanges(d.paragraphs)[ref.field-1];
 d.select(r.start+1);expect(d.range).toEqual([r.start,r.end]);d.replace('Author');
 expect(bodyFieldRanges(d.paragraphs)).toHaveLength(ref.fieldCount);
 const output=await save(p,d),again=model(await DocxPackage.open(output));
 expect(again.text).toBe(d.text);expect(bodyFieldRanges(again.paragraphs).map(r=>r.field.instruction)).toEqual(ref.fields.map(f=>f.code));
 for(const[name,bytes]of Object.entries(p.parts))if(name!=='word/document.xml')expect(unzipSync(output)[name]).toEqual(bytes);
 d.undo();expect(unzipSync(await save(p,d))).toEqual(p.parts);d.redo();expect(d.text).toBe(again.text);
});
it.each([0,1,2,3,4,5])('preserves formatted prompt %i through export and undo',async index=>{
 const p=await DocxPackage.open(source),d=model(p),r=bodyFieldRanges(d.paragraphs)[index];
 d.select(r.start,r.end);d.setRunFormat({italic:true});
 const again=model(await DocxPackage.open(await save(p,d))),range=bodyFieldRanges(again.paragraphs)[index];
 expect(again.text).toBe(d.text);expect(range.field.instruction).toBe(r.field.instruction);
 const selected=again.paragraphs.find(p=>p.id===range.startParagraph);let at=again.paragraphOffset(again.paragraphs.indexOf(selected));
 for(const run of selected.runs){if(at<range.end&&at+run.text.length>range.start)expect(run.italic).toBe(true);at+=run.text.length;}
 d.undo();expect(unzipSync(await save(p,d))).toEqual(p.parts);
});
it('moves across prompts, inserts at boundaries and deletes prompts atomically',async()=>{
 const p=await DocxPackage.open(source),d=model(p),r=bodyFieldRanges(d.paragraphs)[0];
 expect(d.promptBoundary(r.start+1,1)).toBe(r.end);expect(d.promptBoundary(r.end-1,-1)).toBe(r.start);
 d.select(r.end);d.replace('After');expect(bodyFieldRanges(d.paragraphs)[0].end).toBe(r.end);d.undo();
 d.select(r.start);d.replace('Before');expect(bodyFieldRanges(d.paragraphs)[0].start).toBe(r.start+6);d.undo();
 d.select(r.end);d.delete(-1);expect(bodyFieldRanges(d.paragraphs)).toHaveLength(8);expect(d.text).toContain('Unquoted:  | end');
 expect(model(await DocxPackage.open(await save(p,d))).text).toBe(d.text);d.undo();expect(unzipSync(await save(p,d))).toEqual(p.parts);
});
it('replaces a search hit within a prompt as one field and preserves neighboring prompts',async()=>{
 const p=await DocxPackage.open(source),d=model(p);
 expect(d.replaceMatches('label','New',{},true)).toBe(3);expect(bodyFieldRanges(d.paragraphs)).toHaveLength(6);
 const again=model(await DocxPackage.open(await save(p,d)));expect(again.text).toBe(d.text);
 d.undo();expect(unzipSync(await save(p,d))).toEqual(p.parts);
});
it('keeps whole-prompt bookmarks and hyperlinks outside the instruction when exporting',async()=>{
 const p=await DocxPackage.open(source),d=model(p),r=bodyFieldRanges(d.paragraphs)[0];
 d.select(r.start+1,r.end-1);d.addBookmark('Prompt');d.setHyperlink('https://example.com/prompt');
 const again=model(await DocxPackage.open(await save(p,d)));expect(again.text).toBe(d.text);expect(bodyFieldRanges(again.paragraphs)).toHaveLength(9);
 expect(again.bookmarks.find(b=>b.name==='Prompt')).toMatchObject({start:r.start,end:r.end});
 again.select(r.start+1);expect(again.hyperlink.link.target).toBe('https://example.com/prompt');
 again.toggleItalic();expect(model(await DocxPackage.open(await save(p,again))).text).toBe(d.text);
});
it('replaces multiple matches within one prompt only once',async()=>{
 const p=await DocxPackage.open(source),d=model(p);
 const count=d.replaceMatches('a','X',{},true);
 expect(count).toBeGreaterThan(0);expect(()=>bodyFieldRanges(d.paragraphs)).not.toThrow();
 expect(model(await DocxPackage.open(await save(p,d))).text).toBe(d.text);
});
it.each(['tests/fixtures/macro-buttons/editing.docx','public/fixtures/macro-button-labels.docx','tests/fixtures/nested-body-fields/control.docx'])('with Track Changes on, typing over a prompt in %s inserts tracked text and still saves',async path=>{
 const p=await DocxPackage.open(readFileSync(path)),d=model(p);
 const prompts=bodyFieldRanges(d.paragraphs).filter(r=>r.field.type==='MACROBUTTON');
 expect(prompts.length).toBeGreaterThan(0);
 d.trackChanges=true;d.revisionAuthor='Reviewer';
 for(const r of [...prompts].reverse()){d.select(r.start+1);d.replace('Typed');}
 expect(d.revisions.map(r=>[r.type,d.text.slice(r.start,r.end)])).toEqual(prompts.map(()=>['ins','Typed']));
 expect(bodyFieldRanges(d.paragraphs).filter(r=>r.field.type==='MACROBUTTON')).toHaveLength(0);
 const again=model(await DocxPackage.open(await save(p,d)));
 expect(again.text).toBe(d.text);
 expect(again.revisions.map(r=>r.type)).toEqual(prompts.map(()=>'ins'));
 for(let i=0;i<prompts.length;i++)d.undo();
 expect(unzipSync(await save(p,d))).toEqual(p.parts);
});
