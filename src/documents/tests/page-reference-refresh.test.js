import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { TextDocument } from '../src/engine/model.js';
import { bodyFieldRanges } from '../src/engine/body-fields.js';
import { refreshPageReferences } from '../src/engine/page-reference-refresh.js';
import { layoutDocument } from '../src/engine/layout.js';
import { pageGeometry } from '../src/engine/page-settings.js';
let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => { dom.window.close(); delete globalThis.DOMParser; delete globalThis.XMLSerializer; });
const source = readFileSync('tests/fixtures/field-refresh/absent.docx');
const model = p => new TextDocument(p.paragraphs, p.pageSettings, p.numbering, p.styles, p.tables, p.assets);
const save = async (p, d) => new Uint8Array(await p.export(d.paragraphs, d.pageSettings, d.numbering, d.styles, d.tables, d.assets).arrayBuffer());
const layoutOf = p => d => layoutDocument(d.paragraphs, (text, style) => ({ width: text.length * style.fontSize * .6, ascent: style.fontSize * .8, descent: style.fontSize * .2 }), pageGeometry(d.pageSettings), d.numbering, d.tables, p.pageStories, { styles: d.styles });
const values = d => bodyFieldRanges(d.paragraphs).map(r => d.text.slice(r.start, r.end));
const variant = transform => { const parts = unzipSync(source); parts['word/document.xml'] = strToU8(transform(strFromU8(parts['word/document.xml']))); return zipSync(parts); };

it('matches explicit native update, preserves unrelated parts, selection and one-step undo/redo', async () => {
  const p = await DocxPackage.open(source), d = model(p);
  d.select(d.text.length - 5, d.text.length - 1); d.typingFormat = { italic: true };
  const selected = d.text.slice(...d.range), result = refreshPageReferences(d, layoutOf(p), p.pageStories);
  expect(result).toEqual({ changed: 3, issues: [] }); expect(values(d)).toEqual(['2', '2', '2', '66']);
  expect(d.text.slice(...d.range)).toBe(selected); expect(d.typingFormat).toEqual({ italic: true }); expect(d.history).toHaveLength(1);
  const output = await save(p, d), again = model(await DocxPackage.open(output)); expect(values(again)).toEqual(values(d));
  expect(bodyFieldRanges(again.paragraphs).some(r => r.field.dirty)).toBe(false);
  for (const [name, bytes] of Object.entries(p.parts)) if (name !== 'word/document.xml') expect(unzipSync(output)[name]).toEqual(bytes);
  d.undo(); expect(unzipSync(await save(p, d))).toEqual(p.parts); d.redo(); expect(values(d)).toEqual(['2', '2', '2', '66']);
});
it('dirty-only refresh keeps clean and locked caches', async () => {
  const p = await DocxPackage.open(source), d = model(p);
  expect(refreshPageReferences(d, layoutOf(p), p.pageStories, { dirtyOnly: true }).changed).toBe(1);
  expect(values(d)).toEqual(['99', '88', '2', '66']);
  expect(refreshPageReferences(d, layoutOf(p), p.pageStories, { dirtyOnly: true }).changed).toBe(0); expect(d.history).toHaveLength(1);
});
it.each(['absent', 'false', 'true'])('reads %s updateFields without changing the source package', async name => {
  const p = await DocxPackage.open(readFileSync(`tests/fixtures/field-refresh/${name}.docx`));
  expect(p.updateFields).toBe(name === 'true'); expect(unzipSync(await save(p, model(p)))).toEqual(p.parts);
});
it('uses section numbering without headers and honors a field format override', async () => {
  const p = await DocxPackage.open(variant(xml => xml.replace('</w:sectPr>', '<w:pgNumType w:fmt="lowerRoman" w:start="9"/></w:sectPr>').replace(' PAGEREF Target ', ' PAGEREF Target \\* Arabic '))), d = model(p);
  expect(p.pageStories.sections[0].pageNumbering).toMatchObject({ format: 'lowerRoman', start: 9 });
  refreshPageReferences(d, layoutOf(p), p.pageStories); expect(values(d)).toEqual(['10', 'x', 'x', '66']);
});
it('retains numeric picture formatting and refills an empty result', async () => {
  const p = await DocxPackage.open(variant(xml => xml.replace(' PAGEREF Target ', ' PAGEREF Target \\# &quot;000&quot; ').replace('>99<', '><'))), d = model(p);
  refreshPageReferences(d, layoutOf(p), p.pageStories); expect(values(d)).toEqual(['002', '2', '2', '66']);
  expect(values(model(await DocxPackage.open(await save(p, d))))).toEqual(values(d));
});
it('honors a locked enclosing TOC field while refreshing independent references', async () => {
  const p = await DocxPackage.open(variant(xml => xml.replace('<w:fldSimple w:instr=" PAGEREF Target ">', '<w:fldSimple w:instr=" TOC " w:fldLock="true"><w:fldSimple w:instr=" PAGEREF Target ">').replace('</w:fldSimple>', '</w:fldSimple></w:fldSimple>'))), d = model(p);
  const result = refreshPageReferences(d, layoutOf(p), p.pageStories); expect(result.changed).toBe(2); expect(values(d)).toEqual(['99', '99', '2', '2', '66']);
  expect(values(model(await DocxPackage.open(await save(p, d))))).toEqual(values(d));
});
it('updates PAGEREF children without regenerating enclosing TOC text', async () => {
  const p = await DocxPackage.open(variant(xml => xml.replace('<w:fldSimple w:instr=" PAGEREF Target ">', '<w:fldSimple w:instr=" TOC "><w:r><w:t xml:space="preserve">Title </w:t></w:r><w:fldSimple w:instr=" PAGEREF Target ">').replace('</w:fldSimple>', '</w:fldSimple><w:r><w:t xml:space="preserve"> tail</w:t></w:r></w:fldSimple>'))), d = model(p);
  refreshPageReferences(d, layoutOf(p), p.pageStories); expect(values(d)).toEqual(['Title 2 tail', '2', '2', '2', '66']);
  expect(values(model(await DocxPackage.open(await save(p, d))))).toEqual(values(d)); d.undo(); expect(unzipSync(await save(p, d))).toEqual(p.parts);
});
it('isolates unsupported switches while updating healthy fields', async () => {
  const p = await DocxPackage.open(variant(xml => xml.replace(' PAGEREF Target ', ' PAGEREF Target \\unsupported '))), d = model(p);
  const result = refreshPageReferences(d, layoutOf(p), p.pageStories); expect(result.changed).toBe(2); expect(result.issues).toHaveLength(1);
  expect(values(d)).toEqual(['99', '2', '2', '66']); expect(result.issues[0].message).toContain('cached result is retained');
});
it('creates a hyperlink for the h switch and preserves its field envelope through export', async () => {
  const p = await DocxPackage.open(variant(xml => xml.replace(' PAGEREF Target ', ' PAGEREF Target \\h '))), d = model(p);
  refreshPageReferences(d, layoutOf(p), p.pageStories); const range = bodyFieldRanges(d.paragraphs)[0]; d.select(range.start, range.end);
  expect(d.hyperlink.link.anchor).toBe('Target');
  const again = model(await DocxPackage.open(await save(p, d))), reopened = bodyFieldRanges(again.paragraphs)[0]; again.select(reopened.start, reopened.end);
  expect(again.hyperlink.link.anchor).toBe('Target'); expect(reopened.field.instruction).toContain('\\h'); expect(values(again)).toEqual(['2', '2', '2', '66']);
  expect(refreshPageReferences(again, layoutOf(p), p.pageStories).changed).toBe(0);
  d.undo(); expect(unzipSync(await save(p, d))).toEqual(p.parts);
});
it.each([['different page', false, 'on page 2'], ['same page below', true, 'below']])('implements p position switch: %s', async (_, samePage, expected) => {
  const p = await DocxPackage.open(variant(xml => {
    xml = xml.replace(' PAGEREF Target ', ' PAGEREF Target \\p ');
    return samePage ? xml.replace('<w:pPr><w:pageBreakBefore/></w:pPr>', '') : xml;
  })), d = model(p);
  refreshPageReferences(d, layoutOf(p), p.pageStories); expect(values(d)[0]).toBe(expected);
});
it('implements p above for a bookmark earlier on the same page', async () => {
  const p = await DocxPackage.open(variant(xml => xml.replace('<w:p>', '<w:p><w:bookmarkStart w:id="1" w:name="Earlier"/><w:bookmarkEnd w:id="1"/>').replace(' PAGEREF Target ', ' PAGEREF Earlier \\p '))), d = model(p);
  refreshPageReferences(d, layoutOf(p), p.pageStories); expect(values(d)[0]).toBe('above');
});
it('returns a missing-bookmark error without discarding the field', async () => {
  const p = await DocxPackage.open(variant(xml => xml.replace(' PAGEREF Target ', ' PAGEREF Missing '))), d = model(p);
  refreshPageReferences(d, layoutOf(p), p.pageStories); expect(values(d)[0]).toBe('Error! Bookmark not defined.');
  const again = model(await DocxPackage.open(await save(p, d)));
  expect(values(again)[0]).toBe('Error! Bookmark not defined.');
});
it('rolls back layout failure including history, dirty flags and selection', async () => {
  const p = await DocxPackage.open(source), d = model(p); d.select(3); d.replace('X');
  const before = d.snapshot(), history = structuredClone(d.history), revision = d.revision; let passes = 0;
  expect(() => refreshPageReferences(d, current => { if (++passes === 2) throw new Error('layout failure'); return layoutOf(p)(current); }, p.pageStories)).toThrow('layout failure');
  expect(d.snapshot()).toEqual(before); expect(d.revision).toBe(revision); expect(d.history).toEqual(history);
});
it('recalculates against changed pagination instead of making a single stale pass', async () => {
  const p = await DocxPackage.open(source), d = model(p); let passes = 0;
  const result = refreshPageReferences(d, current => { passes++; const layout = layoutOf(p)(current); if (values(current)[0] !== '99') layout.pageSections = [null, 0]; return layout; }, p.pageStories);
  expect(passes).toBe(3); expect(result.changed).toBe(3); expect(values(d)).toEqual(['1', '1', '1', '66']); expect(d.history).toHaveLength(1);
});
it('refreshes page references with Track Changes on, leaving no tracked change', async () => {
  const p = await DocxPackage.open(source), d = new TextDocument(p.paragraphs, p.pageSettings, p.numbering, p.styles, p.tables, p.assets, { trackChanges: true });
  expect(refreshPageReferences(d, layoutOf(p), p.pageStories)).toEqual({ changed: 3, issues: [] });
  expect(values(d)).toEqual(['2', '2', '2', '66']);
  expect(d.trackChanges).toBe(true);
  expect(d.revisions).toEqual([]);
  const again = model(await DocxPackage.open(await save(p, d)));
  expect(values(again)).toEqual(['2', '2', '2', '66']);
  expect(again.revisions).toEqual([]);
});
