import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import { DocxPackage, createDocx, W } from '../src/engine/docx.js';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { bookmarkEntries } from '../src/engine/bookmarks.js';
import { hyperlinkRanges } from '../src/engine/hyperlinks.js';
import { layoutDocument, caretRect, hitTest, selectionRects } from '../src/engine/layout.js';
import { hyperlinkAtPoint } from '../src/engine/hyperlink-hit.js';
import { pageGeometry } from '../src/engine/page-settings.js';
import { fontMetrics } from '../src/engine/font-metrics.js';
import { expectBodyEditParts } from './helpers/expect-body-edit-parts.js';
let dom;
beforeAll(() => { dom = new JSDOM(''); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => { dom.window.close(); delete globalThis.DOMParser; delete globalThis.XMLSerializer; });
const source = readFileSync('public/fixtures/bookmarks.docx'), R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const model = p => new TextDocument(p.paragraphs, p.pageSettings, p.numbering, p.styles, p.tables, p.assets);
const save = async (p,d) => new Uint8Array(await p.export(d.paragraphs,d.pageSettings,d.numbering,d.styles,d.tables,d.assets).arrayBuffer());
const select = (d,text) => { const at=d.text.indexOf(text);expect(at).toBeGreaterThanOrEqual(0);d.select(at,at+text.length); };
const entry = (d,name) => d.bookmarks.find(b=>b.name===name);
const contents = (d,name) => { const b=entry(d,name);return b && d.text.slice(b.start,b.end); };
const layout = d => layoutDocument(d.paragraphs,(text,style)=>({...fontMetrics(style),width:[...text].length*style.fontSize*2/3}),pageGeometry(d.pageSettings),d.numbering,d.tables);
function sameParts(a,b,except=[]) { expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());for(const k in b)if(!except.includes(k))expect(Buffer.from(a[k]).equals(Buffer.from(b[k])),k).toBe(true); }
function revise(change) { const parts=unzipSync(source),xml=new DOMParser().parseFromString(strFromU8(parts['word/document.xml']),'application/xml');change(xml);parts['word/document.xml']=strToU8(new XMLSerializer().serializeToString(xml));return zipSync(parts); }
const elements=(xml,tag)=>[...xml.getElementsByTagNameNS(W,tag)];
const starts=xml=>elements(xml,'bookmarkStart');

it('imports paired point, overlapping, cell, hidden and Unicode bookmarks with exact no-edit preservation',async()=>{
  const p=await DocxPackage.open(source),d=model(p);expect(d.bookmarks).toHaveLength(13);expect(contents(d,'Target')).toBe('target á😀');expect(contents(d,'Across')).toBe('two paragraphs with overlapping markers\nand their ');expect(contents(d,'Overlap')).toBe('overlapping markers\nand their last words');expect(contents(d,'_Point')).toBe('');expect(contents(d,'InsideLink')).toBe('middle');expect(contents(d,'CellTarget')).toBe('Cell target');expect(contents(d,'任意の名前 with spaces')).toBe('Unicode bookmark');expect(contents(d,'')).toBe('');
  expect(d.bookmarks.filter(b=>b.name==='Duplicate').map(b=>d.text.slice(b.start,b.end))).toEqual(['First duplicate','Second duplicate']);sameParts(unzipSync(await save(p,d)),p.parts);
});

it('creates point/range bookmarks, renames internal references, and preserves external r:id precedence through undo and reopen',async()=>{
  const p=await DocxPackage.open(source),d=model(p),before=d.snapshot();select(d,'Bookmarks');d.addBookmark('Created');select(d,'target á😀');d.replace('edited target á😀');d.renameBookmark(entry(d,'Target').id,'RenamedTarget');select(d,'jump middle end');expect(d.hyperlink.link.anchor).toBe('RenamedTarget');select(d,'External precedence');expect(d.hyperlink.link.target).toBe('https://example.com/external');
  const bytes=await save(p,d),out=model(await DocxPackage.open(bytes));expect(contents(out,'RenamedTarget')).toBe('edited target á😀');expect(contents(out,'Created')).toBe('Bookmarks');expect(contents(out,'InsideLink')).toBe('middle');expectBodyEditParts(unzipSync(bytes),p.parts);
  d.undo();d.undo();d.undo();expect(d.paragraphs).toEqual(before.paragraphs);sameParts(unzipSync(await save(p,d)),p.parts);d.redo();d.redo();d.redo();expect(contents(d,'RenamedTarget')).toBe('edited target á😀');
});

it('changes link destination kinds, writes internal anchors without relationships and keeps imported formatting',async()=>{
  const p=await DocxPackage.open(source),d=model(p);select(d,'External precedence');d.setHyperlink({anchor:'Target'});expect(d.runFormatting).toMatchObject({color:'0563C1',underline:true});select(d,'Missing target');d.setHyperlink('https://example.com/new');select(d,'Top link');d.setHyperlink({anchor:'_Point'});
  const bytes=await save(p,d),out=model(await DocxPackage.open(bytes));select(out,'External precedence');expect(out.hyperlink.link).toMatchObject({anchor:'Target'});expect(out.hyperlink.link.target).toBeUndefined();select(out,'Missing target');expect(out.hyperlink.link.target).toBe('https://example.com/new');select(out,'Top link');expect(out.hyperlink.link.anchor).toBe('_Point');
  const d2=new TextDocument([paragraph('Jump Destination')]),p2=createDocx(d2.paragraphs);d2.select(5,16);d2.addBookmark('Place');d2.select(0,4);d2.setHyperlink({anchor:'Place'});const parts=unzipSync(await save(p2,d2));expect(strFromU8(parts['word/_rels/document.xml.rels']||new Uint8Array())).not.toContain('/hyperlink');
});

it('keeps markers inside one hyperlink wrapper across formatting changes and text edits',async()=>{
  const p=await DocxPackage.open(source),d=model(p);select(d,'middle');d.setRunFormat({italic:true});d.replace('middle edited');expect(contents(d,'InsideLink')).toBe('middle edited');const bytes=await save(p,d),xml=new DOMParser().parseFromString(strFromU8(unzipSync(bytes)['word/document.xml']),'application/xml');const link=elements(xml,'hyperlink').find(n=>n.textContent==='jump middle edited end');expect(link).toBeTruthy();expect(elements(link,'bookmarkStart')[0].getAttributeNS(W,'name')).toBe('InsideLink');expect(elements(link,'bookmarkEnd')).toHaveLength(1);expect(elements(xml,'hyperlink')).toHaveLength(8);const out=model(await DocxPackage.open(bytes));expect(contents(out,'InsideLink')).toBe('middle edited');
});

it('excludes edge typing, includes interior typing and keeps point bookmarks together',()=>{
  const d=new TextDocument([paragraph('abcdef')]);d.select(1,5);d.addBookmark('Range');d.select(1);d.replace('L');expect(contents(d,'Range')).toBe('bcde');d.select(entry(d,'Range').end);d.replace('R');expect(contents(d,'Range')).toBe('bcde');d.select(entry(d,'Range').start+2);d.replace('X');expect(contents(d,'Range')).toBe('bcXde');
  d.select(0);d.addBookmark('Point');d.replace('A');expect(entry(d,'Point')).toMatchObject({start:1,end:1});d.select(0,3);d.replace('new');expect(entry(d,'Point')).toMatchObject({start:3,end:3});
});

it('tracks partial/whole replacements and deletion, retaining collapsed targets and exact undo',()=>{
  const d=new TextDocument([paragraph('abcdefgh')]);d.select(2,6);d.addBookmark('Range');const before=d.snapshot();d.select(1,4);d.replace('XYZ');expect(contents(d,'Range')).toBe('XYZef');d.undo();d.select(2,6);d.replace('Q');expect(contents(d,'Range')).toBe('Q');d.undo();d.select(0,8);d.replace('');expect(entry(d,'Range')).toMatchObject({start:0,end:0});d.undo();expect(d.snapshot()).toEqual({...before,selection:{anchor:0,focus:8}});
});

it('preserves overlapping ranges through paragraph splits/merges and Unicode edits',async()=>{
  const p=await DocxPackage.open(source),d=model(p);select(d,'overlapping');d.select(d.range[0]+4);d.insertParagraph();expect(contents(d,'Across')).toContain('over\nlapping');expect(contents(d,'Overlap')).toContain('over\nlapping');d.delete(-1);expect(contents(d,'Overlap')).toBe('overlapping markers\nand their last words');
  select(d,'target á😀');d.select(d.range[0]+7);d.replace('!');const out=model(await DocxPackage.open(await save(p,d)));expect(contents(out,'Target')).toBe(contents(d,'Target'));expect(contents(out,'Across')).toBe(contents(d,'Across'));
});

it('keeps source marker offsets inside a combining cluster without affecting caret or shaping geometry',async()=>{
  const p=await DocxPackage.open(revise(xml=>{const s=starts(xml)[0],next=s.nextElementSibling,text=elements(next,'t')[0];text.textContent='\u0301';s.previousElementSibling.querySelector('t')?.remove();const r=xml.createElementNS(W,'w:r'),t=xml.createElementNS(W,'w:t');t.textContent='a';r.append(t);s.before(r);})),d=model(p);expect(contents(d,'Target')).toBe('́');select(d,'after');d.setRunFormat({bold:true});const out=model(await DocxPackage.open(await save(p,d)));expect(contents(out,'Target')).toBe('́');
});

it('adds rows/columns and splits cells without cloning marker IDs',async()=>{
  const p=await DocxPackage.open(source),d=model(p);select(d,'Header target');d.insertTableRow();expect(d.bookmarks).toHaveLength(13);select(d,'Header target');d.insertTableColumn();expect(d.bookmarks).toHaveLength(13);const out=model(await DocxPackage.open(await save(p,d)));expect(out.bookmarks).toHaveLength(13);expect(contents(out,'HeaderTarget')).toBe('Header target');d.undo();d.undo();sameParts(unzipSync(await save(p,d)),p.parts);
});

it('retains surviving bookmarked content when a vertical cell merge reorders its endpoint paragraphs',async()=>{
  const p=await DocxPackage.open(source),d=model(p);select(d,'Header link');const a=d.range[0];select(d,'Cell target');d.select(a,d.range[1]);d.addBookmark('Moving');select(d,'Header target');d.mergeCellBelow();const text=contents(d,'Moving');expect(text).toContain('Cell target');expect(text).toContain('Header link');const out=model(await DocxPackage.open(await save(p,d)));expect(contents(out,'Moving')).toBe(text);d.undo();expect(contents(d,'Moving')).toBe('Header link\nCell target');d.undo();sameParts(unzipSync(await save(p,d)),p.parts);
});

it('trims ranges to surviving content after row/column/table removal and restores deleted targets with undo',async()=>{
  const p=await DocxPackage.open(source),d=model(p);select(d,'Cell target');d.deleteTablePart('column');expect(entry(d,'CellTarget')).toBeUndefined();expect(contents(d,'IntoTable')).toContain('Before the table');expect(contents(d,'IntoTable')).toContain('Header link');await DocxPackage.open(await save(p,d));d.undo();select(d,'Cell target');d.deleteTablePart('table');expect(entry(d,'HeaderTarget')).toBeUndefined();expect(contents(d,'IntoTable')).toBe('Before the table');await DocxPackage.open(await save(p,d));d.undo();sameParts(unzipSync(await save(p,d)),p.parts);
});

it('tracks ranges during cross-cell text replacement without merging cells and undoes the edit in one step',async()=>{
  const p=await DocxPackage.open(source),d=model(p),table=structuredClone(d.tables);const range=entry(d,'IntoTable');d.select(range.start,range.end);const before=d.snapshot();d.replace('Replacement');expect(d.tables).toEqual(table);expect(contents(d,'IntoTable')).toContain('Replacement');expect(d.bookmarks).toHaveLength(13);await DocxPackage.open(await save(p,d));d.undo();expect(d.snapshot()).toEqual(before);sameParts(unzipSync(await save(p,d)),p.parts);
});

it('writes bookmarks in an empty paragraph and preserves signed/zero-padded imported identifiers without numeric rounding',async()=>{
  const d=new TextDocument([paragraph()]),p=createDocx(d.paragraphs);d.addBookmark('Empty');const out=model(await DocxPackage.open(await save(p,d)));expect(entry(out,'Empty')).toMatchObject({start:0,end:0});
  const imported=await DocxPackage.open(revise(xml=>{starts(xml)[0].setAttributeNS(W,'w:id','+0009007199254740993');elements(xml,'bookmarkEnd')[0].setAttributeNS(W,'w:id','9007199254740993');})),m=model(imported);expect(entry(m,'Target').id).toBe('9007199254740993');select(m,'Before');m.setRunFormat({bold:true});const bytes=await save(imported,m);expect(strFromU8(unzipSync(bytes)['word/document.xml'])).toContain('+0009007199254740993');expect(contents(model(await DocxPackage.open(bytes)),'Target')).toBe('target á😀');
});

it('follows the first duplicate name per ECMA, renaming only links to the active duplicate',async()=>{
  const p=await DocxPackage.open(source),d=model(p),duplicates=d.bookmarks.filter(b=>b.name==='Duplicate');d.renameBookmark(duplicates[1].id,'Second');select(d,'Duplicate link');expect(d.hyperlink.link.anchor).toBe('Duplicate');d.renameBookmark(duplicates[0].id,'First');expect(d.hyperlink.link.anchor).toBe('First');d.removeBookmark(duplicates[0].id);expect(d.hyperlink.link.anchor).toBe('First');expect(entry(d,'First')).toBeUndefined();await DocxPackage.open(await save(p,d));
});

it('preserves column hints outside tables and displacement hints without custom XML, where the standard says they have no effect',async()=>{
  const p=await DocxPackage.open(revise(xml=>{const n=starts(xml)[0];n.setAttributeNS(W,'w:colFirst','1');n.setAttributeNS(W,'w:colLast','2');n.setAttributeNS(W,'w:displacedByCustomXml','next');})),d=model(p);select(d,'Before');d.setRunFormat({bold:true});const bytes=await save(p,d),xml=new DOMParser().parseFromString(strFromU8(unzipSync(bytes)['word/document.xml']),'application/xml');expect(starts(xml)[0].getAttributeNS(W,'colFirst')).toBe('1');expect(starts(xml)[0].getAttributeNS(W,'displacedByCustomXml')).toBe('next');expect(contents(model(await DocxPackage.open(bytes)),'Target')).toBe('target á😀');
});

it.each(['https://example.com/\ufffe','https://example.com/\uffff',{anchor:'bad\ufffe'},{anchor:'bad\uffff'}])('rejects XML noncharacters in authored link targets before history mutation: %j',target=>{const d=new TextDocument([paragraph('Link')]);d.select(0,4);const before=d.snapshot();expect(()=>d.setHyperlink(target)).toThrow();expect(d.snapshot()).toEqual(before);expect(d.history).toHaveLength(0);});

it('has zero layout width and preserves source caret positions, selection and repeated-header link hits',async()=>{
  const p=await DocxPackage.open(source),d=model(p),before=layout(d);expect(before.repeatedLines.length).toBeGreaterThan(0);const link=hyperlinkRanges(d.paragraphs).find(r=>d.text.slice(r.start,r.end)==='Header link'),rects=selectionRects(before,link.start,link.end);expect(rects.length).toBeGreaterThan(1);for(const r of rects)expect(hyperlinkAtPoint(before,d.paragraphs,r.page,r.x+r.width/2,r.y+r.height/2)?.link.anchor).toBe('Target');const pos=entry(d,'Target').start+9,c=caretRect(before,pos);expect(hitTest(before,c.page,c.x,c.y+c.height/2)).toBe(pos);for(const b of [...d.bookmarks])d.removeBookmark(b.id);expect(layout(d)).toEqual(before);
});

it.each(['', '1bad','two words','a-b','a'.repeat(41)])('rejects invalid authored bookmark names without changing text/history: %s',name=>{const d=new TextDocument([paragraph('text')]),before=d.snapshot();expect(()=>d.addBookmark(name)).toThrow();expect(d.snapshot()).toEqual(before);expect(d.history).toHaveLength(0);});

it.each([
  ['unmatched start',xml=>elements(xml,'bookmarkEnd')[0].remove()],
  ['unmatched end',xml=>starts(xml)[0].remove()],
  ['reversed markers',xml=>starts(xml)[0].before(elements(xml,'bookmarkEnd')[0])],
  ['duplicate id',xml=>starts(xml)[1].setAttributeNS(W,'w:id','1')],
  ['missing name',xml=>starts(xml)[0].removeAttributeNS(W,'name')],
  ['invalid id',xml=>starts(xml)[0].setAttributeNS(W,'w:id','1.5')],
  ['unpaired columns',xml=>starts(xml)[0].setAttributeNS(W,'w:colFirst','0')],
  ['invalid displaced marker',xml=>starts(xml)[0].setAttributeNS(W,'w:displacedByCustomXml','sideways')],
  ['marker content',xml=>starts(xml)[0].append(xml.createCDATASection('text'))],
])('rejects unsupported %s before editable open',async(label,change)=>{await expect(DocxPackage.open(revise(change))).rejects.toThrow(/bookmark/i);});

it('adds and renames bookmarks named with letters of any script, as word processors allow',async()=>{
  const p=await DocxPackage.open(source),d=model(p);
  select(d,'Bookmarks');d.addBookmark('Закладка');
  const target=contents(d,'Target');d.renameBookmark(entry(d,'Target').id,'Résumé_2');
  d.select(0);d.addBookmark('書籤');
  // A decomposed accent belongs to its letter; 40 UTF-16 units at most, as the format's readers count them.
  d.select(1);d.addBookmark('café');d.select(2);d.addBookmark('я'.repeat(40));
  const out=model(await DocxPackage.open(await save(p,d)));
  expect(contents(out,'Закладка')).toBe('Bookmarks');expect(contents(out,'Résumé_2')).toBe(target);expect(contents(out,'書籤')).toBe('');expect(contents(out,'café')).toBe('');
  for(const name of ['1st','with space','x'.repeat(41),'я'.repeat(41),'-dash','́accent','a-b'])expect(()=>d.addBookmark(name),name).toThrow();
});
