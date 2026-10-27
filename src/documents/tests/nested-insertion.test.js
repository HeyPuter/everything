import {beforeAll,afterAll,it,expect} from 'vitest';
import {JSDOM} from 'jsdom';
import {readFileSync} from 'node:fs';
import {unzipSync,strFromU8} from 'fflate';
import {DocxPackage} from '../src/engine/docx.js';
import {TextDocument} from '../src/engine/model.js';
import {layoutDocument} from '../src/engine/layout.js';
import {pageGeometry} from '../src/engine/page-settings.js';
import {spanWidth} from '../src/engine/tables.js';
let dom;
beforeAll(()=>{dom=new JSDOM();globalThis.DOMParser=dom.window.DOMParser;globalThis.XMLSerializer=dom.window.XMLSerializer;});
afterAll(()=>dom.window.close());
const source=readFileSync('tests/fixtures/nested-tables/nested-clipping-inner-exact.docx');
const model=p=>new TextDocument(p.paragraphs,p.pageSettings,p.numbering,p.styles,p.tables,p.assets);
const save=async(p,d)=>new Uint8Array(await p.export(d.paragraphs,d.pageSettings,d.numbering,d.styles,d.tables,d.assets).arrayBuffer());
const layout=d=>layoutDocument(d.paragraphs,(text,style)=>({width:text.length*style.fontSize*2/3,ascent:style.fontSize,descent:style.fontSize/3}),pageGeometry(d.pageSettings),d.numbering,d.tables);
for(const label of ['Outer before','Inner line 1','Outer after'])for(const position of ['start','middle','end'])it(`inserts a nested table at ${position} of ${label}, retaining the parent paragraph and undo`,async()=>{
 const pkg=await DocxPackage.open(source),doc=model(pkg),original=doc.text;
 const at=doc.text.indexOf(label)+(position==='start'?0:position==='end'?label.length:5);doc.select(at);
 const parent=doc.tableContext,geometry=layout(doc),width=Math.floor(spanWidth(geometry.tableWidths[parent.table.id],parent.column,parent.span)*15-parent.cell.margins.left-parent.cell.margins.right);
 doc.insertTable(2,2,width);
 const inserted=doc.tables.at(-1);expect(inserted.parentCellId).toBe(parent.cell.id);expect(inserted.grid.reduce((a,b)=>a+b,0)).toBe(width-10);
 expect(doc.history).toHaveLength(1);expect(doc.tableContext.table.id).toBe(inserted.id);
 const placed=layout(doc),owner=placed.cells.find(c=>c.id===parent.cell.id);
 for(const border of placed.tableBorders.filter(b=>b.tableId===inserted.id&&!b.guide)){
  expect(border.x).toBeGreaterThanOrEqual(owner.x+parent.cell.margins.left/15-1e-6);
  expect(border.x+border.width).toBeLessThanOrEqual(owner.x+owner.width-parent.cell.margins.right/15+1e-6);
 }
 const suffix=original.slice(at),prefix=original.slice(0,at);
 // At the start of a paragraph the table goes before it; elsewhere, or right after another table
 // (Outer after follows the inner table), the paragraph is split around it.
 expect(doc.text).toBe(prefix+(position==='start'&&label!=='Outer after'?'\n\n\n\n':'\n\n\n\n\n')+suffix);
 const bytes=await save(pkg,doc),reopened=model(await DocxPackage.open(bytes));
 expect(reopened.text).toBe(doc.text);expect(reopened.tables).toHaveLength(3);
 const xml=new DOMParser().parseFromString(strFromU8(unzipSync(bytes)['word/document.xml']),'application/xml');
 for(const cell of xml.getElementsByTagNameNS('*','tc'))expect(cell.lastElementChild.localName).toBe('p');
 const result=layout(reopened);expect(result.cells.some(c=>c.depth===(label.startsWith('Inner')?3:2))).toBe(true);
 doc.undo();expect(doc.text).toBe(original);expect(unzipSync(await save(pkg,doc))).toEqual(unzipSync(source));
 doc.redo();expect(model(await DocxPackage.open(await save(pkg,doc))).text).toBe(reopened.text);
});
it('rejects unresolved or too-narrow parent geometry before mutating',async()=>{
 const pkg=await DocxPackage.open(source),doc=model(pkg);doc.select(doc.text.indexOf('Inner line 1'));const before=doc.snapshot();
 for(const width of [undefined,NaN,Infinity,0,-1,719]){expect(()=>doc.insertTable(2,2,width)).toThrow();expect(doc.snapshot()).toEqual(before);expect(doc.history).toHaveLength(0);}
});
