import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { TextDocument } from '../src/engine/model.js';
import { layoutDocument, hitTest, verticalLine } from '../src/engine/layout.js';
import { pageGeometry } from '../src/engine/page-settings.js';
let dom;
beforeAll(() => { dom=new JSDOM(); globalThis.DOMParser=dom.window.DOMParser; globalThis.XMLSerializer=dom.window.XMLSerializer; });
afterAll(() => { dom.window.close(); delete globalThis.DOMParser; delete globalThis.XMLSerializer; });

const names = ['balanced', 'explicit', 'overflow', 'one', 'table', 'keep', 'stories', 'full', 'tight', 'stories-overflow'];
for (const name of names) it(`matches the native reference continuous-section flow and preserves edits: ${name}`, async () => {
 const folder='tests/fixtures/continuous-sections/';
 const ref=JSON.parse(readFileSync(folder+name+'-reference.json'));
 const pkg=await DocxPackage.open(readFileSync(folder+name+'.docx'));
 const doc=new TextDocument(pkg.paragraphs,pkg.pageSettings,pkg.numbering,pkg.styles,pkg.tables,pkg.assets);
 const geometry=()=>layoutDocument(doc.paragraphs,text=>({width:text.length*6,ascent:12.8,descent:3.2}),pageGeometry(doc.pageSettings),doc.numbering,doc.tables);
 const layout=geometry(), lines=layout.lines.filter(l=>l.fragments.some(f=>f.text.trim()));
 const expected=ref.lines.filter(l=>!l.text.startsWith('Header'));
 expect(layout.pageCount).toBe(ref.pages);expect(lines).toHaveLength(expected.length);
 expected.forEach((e,i)=>{
  const line=lines[i];expect(line.fragments.map(f=>f.text).join('')).toBe(e.text);
  expect(line.page).toBe(e.page);expect(Math.abs(line.stops[0].x*.75-e.x)).toBeLessThan(.15);
  expect(hitTest(layout,line.page,line.stops[0].x+.1,line.y+line.height/2)).toBe(line.start);
 });
 expect(layout.pageRegions[name==='full'?1:0].length).toBeGreaterThan(1);
 const save=async()=>new Uint8Array(await pkg.export(doc.paragraphs,doc.pageSettings,doc.numbering,doc.styles,doc.tables,doc.assets).arrayBuffer());
 expect(unzipSync(await save())).toEqual(pkg.parts);
 doc.select(0);doc.replace('X');expect(geometry().pageCount).toBe(ref.pages);
 const edited=await save(),parts=unzipSync(edited),reopened=await DocxPackage.open(edited);
 expect(new TextDocument(reopened.paragraphs,reopened.pageSettings,reopened.numbering,reopened.styles,reopened.tables,reopened.assets).text).toBe(doc.text);
 for(const key of Object.keys(pkg.parts))if(key!=='word/document.xml')expect(parts[key],key).toEqual(pkg.parts[key]);
 expect(reopened.paragraphs.filter(p=>p.sectionEnd).map(p=>p.sectionEnd.sectionType)).toEqual(['nextPage','continuous']);
 expect(reopened.pageSettings.sectionType).toBe('continuous');
 doc.undo();expect(unzipSync(await save())).toEqual(pkg.parts);
});

it('keeps vertical navigation in source order when an unbalanced final column is shorter', async () => {
 const pkg=await DocxPackage.open(readFileSync('tests/fixtures/continuous-sections/overflow.docx'));
 const paragraphs=structuredClone(pkg.paragraphs.slice(0,-1));
 const settings=paragraphs.at(-1).sectionEnd;
 delete paragraphs.at(-1).sectionEnd;delete paragraphs.at(-1).sectionProperties;
 const layout=layoutDocument(paragraphs,text=>({width:text.length*6,ascent:12.8,descent:3.2}),pageGeometry(settings),pkg.numbering,pkg.tables);
 const lines=layout.lines.filter(line=>!line.virtual && line.fragments.some(f=>f.text.trim()));
 expect(layout.pageRegions[0].length).toBe(2);
 for(let i=0;i<lines.length-1;i++)expect(verticalLine(layout,lines[i],1,lines[i].stops[0].x)?.start).toBe(lines[i+1].start);
});

it('keeps lines together and avoids an orphan at the start of a continuous section, as within one section', async () => {
 const { paragraph } = await import('../src/engine/model.js');
 const { validatePageSettings } = await import('../src/engine/page-settings.js');
 const measure = text => ({ width: text.length * 8, ascent: 15, descent: 5 });
 const base = { width: 4320, height: 4320, top: 720, bottom: 720, left: 720, right: 720 };
 const first = validatePageSettings(base), next = validatePageSettings({ ...base, sectionType: 'continuous' });
 const lines = (n, format = {}) => paragraph(Array.from({ length: n }, (_, i) => `Line ${i}`).join('\v'), { format: { spaceAfter: 0, ...format } });
 // Nine lines fit a page: eight above leave room for one more line at the foot of the first page.
 for (const format of [{}, { keepLines: true }, { widowControl: false, keepLines: true }]) {
  const target = lines(4, format), single = layoutDocument([lines(8), target], measure, pageGeometry(first));
  const sectioned = layoutDocument([Object.assign(lines(8), { sectionEnd: first }), target], measure, pageGeometry(next));
  const pages = result => result.lines.filter(l => l.paragraphId === target.id).map(l => l.page);
  expect(pages(single)).toEqual([1, 1, 1, 1]);
  expect(pages(sectioned)).toEqual([1, 1, 1, 1]);
 }
 // In columns, the other columns on the shared page are just as short: the paragraph moves to the next page.
 const columns = validatePageSettings({ ...base, sectionType: 'continuous', columns: { count: 2, space: 360, equalWidth: true, separator: false } });
 const kept = lines(4, { keepLines: true });
 const flowed = layoutDocument([Object.assign(lines(8), { sectionEnd: first }), kept, lines(30)], measure, pageGeometry(columns));
 expect(flowed.lines.filter(l => l.paragraphId === kept.id).map(l => [l.page, l.column])).toEqual([[1, 0], [1, 0], [1, 0], [1, 0]]);
 // A paragraph that may split still fills the shared page.
 const free = lines(4, { widowControl: false });
 expect(layoutDocument([Object.assign(lines(7), { sectionEnd: first }), free], measure, pageGeometry(next)).lines.filter(l => l.paragraphId === free.id).map(l => l.page)).toEqual([0, 0, 1, 1]);
});
