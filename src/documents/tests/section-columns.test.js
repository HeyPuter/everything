import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { unzipSync, strFromU8, zipSync } from 'fflate';
import { readSectionColumns, sectionColumnIntervals } from '../src/engine/section-columns.js';
import { DocxPackage } from '../src/engine/docx.js';
import { TextDocument } from '../src/engine/model.js';
import { layoutDocument, hitTest, verticalLine } from '../src/engine/layout.js';
import { pageGeometry } from '../src/engine/page-settings.js';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => { dom.window.close(); delete globalThis.DOMParser; delete globalThis.XMLSerializer; });
const parse = xml => new dom.window.DOMParser().parseFromString(xml, 'application/xml');
const declaration = xml => readSectionColumns(parse(`<w:cols xmlns:w="${W}" ${xml}/>`).documentElement);

it('resolves positioned drawings in the section and column owning the anchor', async () => {
  const pkg = await DocxPackage.open(readFileSync('tests/fixtures/mixed-section-drawings/control.docx'));
  const measure = text => ({ width: text.length * 6, ascent: 12, descent: 4 });
  const render = () => layoutDocument(pkg.paragraphs, measure, pageGeometry(pkg.pageSettings), pkg.numbering, pkg.tables);
  const layout = render();
  expect(layout.pageCount).toBe(3);
  expect(layout.floatingObjects.map(f => f.page)).toEqual([0, 2]);
  const right = layout.lines.find(l => l.fragments.some(f => f.text === 'Right column'));
  expect(right.page).toBe(1); expect(right.column).toBe(1);
  const anchor = pkg.paragraphs[0].runs.find(r => r.image);
  const columns = pkg.paragraphs.find(p => p.runs.some(r => r.text === 'Left column'));
  const moved = structuredClone(anchor); columns.runs.push(moved);
  // The host has an explicit column break. An unwrapped picture after it is
  // anchored in the new flow segment (docs/conformance.md, unwrapped positioned
  // pictures across hard breaks). A wrapped picture sharing this text paragraph
  // stays guarded; positioned-breaks.test.js covers the wrapped hard-break guard.
  expect(render().floatingObjects.map(f => f.page)).toEqual([0, 1, 2]);
  // The picture is page-positioned; square-wrapped, it excludes text like any side-wrapped picture,
  // and those are guarded in section columns.
  moved.image.anchor.wrap = 'square';
  expect(render).toThrow('Square-wrapped drawings and floating tables in section columns are not supported yet.');
});

for (const name of ['short', 'equal-flow', 'unequal', 'separator', 'explicit-break', 'wide-table']) {
  it(`resolves ${name} column origins independently measured in the native reference`, () => {
    const source = readFileSync(`tests/fixtures/column-flow/${name}.docx`);
    const xml = parse(strFromU8(unzipSync(source)['word/document.xml']));
    const c = readSectionColumns(xml.getElementsByTagNameNS(W, 'cols')[0]);
    const intervals = sectionColumnIntervals(c, 720, 5760);
    expect(intervals).toHaveLength(2);
    expect(intervals[0].left).toBe(720);
    const ref = JSON.parse(readFileSync(`tests/fixtures/column-flow/${name}-reference.json`));
    const hash = bytes => createHash('sha256').update(bytes).digest('hex');
    expect(hash(source)).toBe(ref.sourceSha256);
    expect(hash(readFileSync(`tests/fixtures/column-flow/${name}.pdf`))).toBe(ref.pdfSha256);
    if (name !== 'wide-table') {
      for (const line of ref.lines) {
        expect(Math.min(...intervals.map(i => Math.abs(i.left/20-line.x)))).toBeLessThan(.1);
      }
    } else {
      // A table may overflow a text column. Do not enlarge the body interval
      // merely to contain the table's second cell.
      expect(intervals[0].right/20).toBe(162);
      expect(ref.lines.find(l => l.text === 'Right cell').x).toBeGreaterThan(162);
    }
    expect(c.separator).toBe(name === 'separator');
  });
}

it('uses equal-width attributes even when stale child widths are retained', () => {
  const xml = parse(`<w:cols xmlns:w="${W}" w:num="2" w:equalWidth="1" w:space="720"><w:col w:w="50"/><w:col w:w="70"/></w:cols>`);
  expect(sectionColumnIntervals(readSectionColumns(xml.documentElement), 720, 5760)).toEqual([
    { left: 720, right: 3240, space: 720 }, { left: 3960, right: 6480, space: 0 },
  ]);
});

it('retains the explicit-width fallback when num refers to missing width entries', () => {
  const xml = parse(`<w:cols xmlns:w="${W}" w:num="9" w:equalWidth="0" w:space="900"><w:col w:w="1in" w:space="36pt"/><w:col w:w="2.5in" w:space="999"/></w:cols>`);
  expect(sectionColumnIntervals(readSectionColumns(xml.documentElement), 720, 5760)).toEqual([
    { left: 720, right: 2160, space: 720 }, { left: 2880, right: 6480, space: 0 },
  ]);
});

it('defaults to one full-width column and rejects unusable declarations', () => {
  expect(sectionColumnIntervals(readSectionColumns(null), 720, 5760)).toEqual([{ left: 720, right: 6480, space: 0 }]);
  for (const xml of ['w:num="0"', 'w:num="2.5"', 'w:space="-1"', 'w:sep="perhaps"', 'w:equalWidth="0"']) {
    expect(() => declaration(xml), xml).toThrow();
  }
  expect(() => sectionColumnIntervals(declaration('w:num="2" w:space="5760"'), 720, 5760)).toThrow();
  expect(() => sectionColumnIntervals(declaration('w:num="999999"'), 720, 5760)).toThrow();
});

it('serializes edited unequal widths and separators without flattening the declaration', async () => {
  const pkg=await DocxPackage.open(readFileSync('tests/fixtures/column-flow/unequal.docx'));
  const doc=new TextDocument(pkg.paragraphs,pkg.pageSettings,pkg.numbering,pkg.styles,pkg.tables,pkg.assets);
  const columns={...doc.pageSettings.columns,separator:true,entries:[{width:1800,space:360},{width:3600,space:0}]};
  // Layout → Columns edits a single section's columns as one undoable change.
  expect(doc.setPageSettings({columns})).toBe(true);
  expect(doc.pageSettings.columns).toEqual(columns);
  const bytes=new Uint8Array(await pkg.export(doc.paragraphs,doc.pageSettings,doc.numbering,doc.styles,doc.tables,doc.assets).arrayBuffer());
  expect((await DocxPackage.open(bytes)).pageSettings.columns).toEqual(columns);
  expect(doc.undo()).toBe(true);
  expect(doc.pageSettings.columns).toEqual(pkg.pageSettings.columns);
});

it('places an unwrapped picture in the second column without using the full-page alignment span', async () => {
  const parts=unzipSync(readFileSync('tests/fixtures/mixed-section-drawings/control.docx'));
  const pkg=await DocxPackage.open(zipSync(parts));
  const anchor=structuredClone(pkg.paragraphs[0].runs.find(r=>r.image));
  anchor.image.anchor={...anchor.image.anchor,wrap:'none',horizontal:'column',vertical:'paragraph',x:0,y:0,xAlign:'right'};
  const host=pkg.paragraphs.find(p=>p.runs.some(r=>r.text==='Right column'));
  host.runs.push(anchor);
  const placed=layoutDocument(pkg.paragraphs,t=>({width:t.length*6,ascent:12,descent:4}),pageGeometry(pkg.pageSettings),pkg.numbering,pkg.tables);
  const f=placed.floatingObjects.find(f=>f.page===1);
  const line=placed.lines.find(l=>l.paragraphId===host.id);
  expect(line.column).toBe(1);expect(f.x+f.width).toBeCloseTo(line.columnRight);
});

for (const name of ['short', 'equal-flow', 'wide-table', 'unequal', 'separator']) {
  it(`flows ${name} on physical pages and retains columns through edit/undo`, async () => {
    const pkg = await DocxPackage.open(readFileSync(`tests/fixtures/column-flow/${name}.docx`));
    const doc = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
    const layout = layoutDocument(doc.paragraphs, text => ({ width: text.length * 6, ascent: 12, descent: 4 }), pageGeometry(doc.pageSettings), doc.numbering, doc.tables);
    expect(layout.pageCount).toBe(['equal-flow','unequal','separator'].includes(name) ? 2 : 1);
    expect(layout.pages[0].width).toBe(480);
    if (name === 'equal-flow') {
      const second = layout.lines.find(l => l.fragments.some(f => f.text === 'Line 09'));
      expect(second.page).toBe(0); expect(second.column).toBe(1); expect(second.stops[0].x).toBe(264);
      expect(hitTest(layout, second.page, second.stops[0].x, second.y + 5)).toBe(second.start);
      const previous = layout.lines.find(l => l.fragments.some(f => f.text === 'Line 08'));
      expect(verticalLine(layout, previous, 1, previous.stops[0].x)).toBe(second);
    }
    const save = async () => new Uint8Array(await pkg.export(doc.paragraphs, doc.pageSettings, doc.numbering, doc.styles, doc.tables, doc.assets).arrayBuffer());
    expect(unzipSync(await save())).toEqual(pkg.parts);
    doc.select(0); doc.replace('Edit ');
    const edited = await save(); const reopened = await DocxPackage.open(edited);
    expect(reopened.pageSettings.columns).toEqual(pkg.pageSettings.columns);
    const parts = unzipSync(edited);
    for (const key of Object.keys(pkg.parts)) if (key !== 'word/document.xml') expect(parts[key], key).toEqual(pkg.parts[key]);
    doc.undo(); expect(unzipSync(await save())).toEqual(pkg.parts);
  });
}
