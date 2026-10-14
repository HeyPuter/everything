import {beforeAll,afterAll,it,expect} from 'vitest';
import {JSDOM} from 'jsdom';
import {readFileSync} from 'node:fs';
import {unzipSync,zipSync,strFromU8,strToU8} from 'fflate';
import {DocxPackage,W} from '../src/engine/docx.js';
import {TextDocument} from '../src/engine/model.js';
import {effectiveCellBorders} from '../src/engine/cell-borders.js';
import {layoutDocument} from '../src/engine/layout.js';
import {pageGeometry} from '../src/engine/page-settings.js';

const source=readFileSync('tests/fixtures/table-row-exceptions/controls.docx');
let dom;
beforeAll(()=>{dom=new JSDOM();globalThis.DOMParser=dom.window.DOMParser;globalThis.XMLSerializer=dom.window.XMLSerializer;});
afterAll(()=>{dom.window.close();delete globalThis.DOMParser;delete globalThis.XMLSerializer;});
const model=p=>new TextDocument(p.paragraphs,p.pageSettings,p.numbering,p.styles,p.tables,p.assets);
const save=async(p,d)=>new Uint8Array(await p.export(d.paragraphs,d.pageSettings,d.numbering,d.styles,d.tables,d.assets).arrayBuffer());
const borders=(t,row=1)=>effectiveCellBorders(t,t.rows[row].cells[0],row,0,1,t.rows[row].cells[0].rowSpan ?? 1);

it('applies partial row overrides below direct cell borders and distinguishes none/nil from omission',async()=>{
 const p=await DocxPackage.open(source);
 expect(borders(p.tables[1]).top.color).toBe('008090');
 expect(borders(p.tables[1]).bottom.color).toBe('008090');
 expect(borders(p.tables[3]).left.color).toBe('208020');
 expect(borders(p.tables[3]).top.color).toBe('303030');
 expect(borders(p.tables[4]).left.style).toBe('none');
 expect(borders(p.tables[5]).left.style).toBe('nil');
 expect(borders(p.tables[6]).left).toMatchObject({color:'B08000',size:4});
 expect(borders(p.tables[6]).top).toMatchObject({color:'B08000',size:4});
});

it('scopes conditional-style look exceptions to their physical rows',async()=>{
 const p=await DocxPackage.open(source);
 const fills=i=>p.tables[i].rows.map(r=>r.cells.map(c=>c.fill));
 expect(fills(11)).toEqual([[null,null],['#B0E8B0',null],[null,null]]);
 expect(fills(12)).toEqual([[null,null],['#B0E8B0',null],['#B0E8B0',null]]);
 expect(fills(13)).toEqual([[null,null],['#E8D0B0','#E8D0B0'],[null,null]]);
});

it('recomputes banding after inserting a row with inherited look exceptions',async()=>{
 const p=await DocxPackage.open(source),d=model(p),t=d.tables[13];
 d.selectCell(t.rows[1].cells[0].id);d.insertTableRow();
 expect(t.rows[1].cells[0].fill).toBe('#E8D0B0');
 expect(t.rows[2].cells[0].fill).toBe('#B0D0E8');
 const r=model(await DocxPackage.open(await save(p,d))).tables[13];
 expect(r.rows[2].styleLook).toEqual(t.rows[1].styleLook);
 expect(r.rows[2].cells[0].fill).toBe('#B0D0E8');
});

it.each([
 ['duplicate border',xml=>{const n=xml.querySelector('tblPrEx tblBorders top');n.parentNode.append(n.cloneNode(true));}],
 ['invalid border size',xml=>xml.querySelector('tblPrEx tblBorders top').setAttributeNS(W,'w:sz','invalid')],
 ['invalid look mask',xml=>xml.querySelector('tblPrEx tblLook').setAttributeNS(W,'w:val','invalid')],
 ['invalid look flag',xml=>xml.querySelector('tblPrEx tblLook').setAttributeNS(W,'w:firstRow','invalid')],
])('rejects malformed row exceptions: %s',async(_,change)=>{
 const parts=unzipSync(source),xml=new DOMParser().parseFromString(strFromU8(parts['word/document.xml']),'application/xml');
 change(xml);parts['word/document.xml']=strToU8(new XMLSerializer().serializeToString(xml));
 await expect(DocxPackage.open(zipSync(parts))).rejects.toMatchObject({name:'UnsupportedDocumentError'});
});

it('preserves exception XML and semantics through row insertion, edits, deletion and exact undo',async()=>{
 const p=await DocxPackage.open(source),d=model(p),t=d.tables[1];
 d.selectCell(t.rows[1].cells[0].id);d.insertTableRow();
 expect(t.rows[2].borderExceptions).toEqual(t.rows[1].borderExceptions);
 d.replace('Inserted');
 const reopened=model(await DocxPackage.open(await save(p,d)));
 expect(reopened.tables[1].rows[2].borderExceptions).toEqual(t.rows[1].borderExceptions);
 expect(reopened.text).toContain('Inserted');
 d.deleteTablePart('row');expect(t.rows).toHaveLength(3);
 d.undo();d.undo();d.undo();
 const a=unzipSync(source),b=unzipSync(await save(p,d));
 expect(Object.keys(b).sort()).toEqual(Object.keys(a).sort());
 for(const name of Object.keys(a))expect(Buffer.from(a[name]).equals(Buffer.from(b[name])),name).toBe(true);
});

it('clips merged side segments to each physical page and uses the row outer border at a page cut',async()=>{
 const p=await DocxPackage.open(source),d=model(p);
 const l=layoutDocument(d.paragraphs,(text,s)=>({width:text.length*s.fontSize*.5,ascent:s.fontSize,descent:s.fontSize/3}),pageGeometry(d.pageSettings),d.numbering,d.tables);
 for(const table of d.tables.slice(-2)){
  const cells=l.cells.filter(c=>c.tableId===table.id),pages=[...new Set(cells.map(c=>c.page))].sort((a,b)=>a-b);
  expect(pages).toHaveLength(2);
  for(const c of cells)for(const segment of c.sideBorders||[]){expect(segment.start).toBeGreaterThanOrEqual(0);expect(segment.end).toBeLessThanOrEqual(c.height+1e-6);}
  const cut=l.tableBorders.filter(b=>b.tableId===table.id&&b.page===pages[0]&&b.border?.color==='2040D0');
  expect(cut.length).toBeGreaterThan(0);
  expect(cut.every(b=>b.horizontal)).toBe(true);
 }
});

it('Table Style Options replace row look exceptions in the editor and in the saved rows', async () => {
 const { setTableLook, tableLook } = await import('../src/engine/table-styles.js');
 const p=await DocxPackage.open(source),d=model(p),t=d.tables[13];
 expect(t.rows.some(row=>row.styleLook)).toBe(true);
 d.selectCell(t.rows[1].cells[0].id);
 expect(setTableLook(d,{noHBand:!tableLook(t).noHBand})).toBe(true);
 expect(t.rows.some(row=>row.styleLook)).toBe(false);
 const r=model(await DocxPackage.open(await save(p,d))).tables[13];
 expect(r.rows.some(row=>row.styleLook)).toBe(false);
 expect(r.rows.map(row=>row.cells[0].fill)).toEqual(t.rows.map(row=>row.cells[0].fill));
});
