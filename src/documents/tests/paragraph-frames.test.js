import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { TextDocument } from '../src/engine/model.js';
import { layoutDocument, hitTest, caretRect } from '../src/engine/layout.js';
import { pageGeometry } from '../src/engine/page-settings.js';
import { layoutPageStories } from '../src/engine/page-story-layout.js';
let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => { dom.window.close(); delete globalThis.DOMParser; delete globalThis.XMLSerializer; });
for (const name of ['page', 'margin', 'style', 'grouped', 'different', 'around', 'not-beside', 'text-anchor', 'inline', 'auto-width', 'zero-width', 'aligned', 'aligned-relative']) it(`${name} frame source survives import, text editing, export and undo`, async () => {
  const bytes = readFileSync(`tests/fixtures/paragraph-frames/${name}.docx`), pkg = await DocxPackage.open(bytes);
  const d = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
  const save = async () => new Uint8Array(await pkg.export(d.paragraphs, d.pageSettings, d.numbering, d.styles, d.tables, d.assets).arrayBuffer());
  expect(unzipSync(await save())).toEqual(unzipSync(bytes));
  d.select(d.text.indexOf('Framed first line') + 7); d.replace('Edited ');
  const output = await save(), again = await DocxPackage.open(output);
  expect(again.paragraphs.flatMap(p => p.runs.map(r => r.text)).join(' ')).toContain('Edited');
  const parts = unzipSync(output);
  for (const [part, content] of Object.entries(pkg.parts)) if (part !== 'word/document.xml') expect(parts[part]).toEqual(content);
  d.undo(); expect(unzipSync(await save())).toEqual(unzipSync(bytes));
});
for (const name of ['around', 'not-beside', 'text-anchor', 'inline', 'auto-width', 'zero-width', 'aligned', 'aligned-relative']) it(`${name} native paragraph positions are hash-bound independent frame evidence`, () => {
  const bytes = readFileSync(`tests/fixtures/paragraph-frames/${name}.docx`);
  const native = JSON.parse(readFileSync(`tests/fixtures/paragraph-frames/${name}-native.json`, 'utf8').replace(/^\uFEFF/, ''));
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(native.sourceSha256);
  expect(native.pages).toBe(1); expect(native.frames).toHaveLength(1);
  const target=native.paragraphs.find(p=>p.text==='Framed first line\r');
  expect(target.x).toBe(name==='aligned-relative'?234:144);
  expect(target.y).toBe(name==='aligned-relative'?720:name==='text-anchor'?85.5:name==='inline'?229.5:['around','not-beside'].includes(name)?72:144);
  if(name==='auto-width'||name==='zero-width') { expect(native.frames[0].width).toBe(-1); expect(native.frames[0].height).toBe(-1); }
  if(name==='not-beside') expect(native.paragraphs[0].y).toBe(150);
  if(name==='around') expect(native.paragraphs[0].x).toBe(300);
});
for (const name of ['page', 'margin', 'style', 'grouped', 'different']) it(`${name} native frame metadata is hash-bound and establishes placement/grouping`, () => {
  const source = readFileSync(`tests/fixtures/paragraph-frames/${name}.docx`);
  const native = JSON.parse(readFileSync(`tests/fixtures/paragraph-frames/${name}-native.json`, 'utf8').replace(/^\uFEFF/, ''));
  expect(createHash('sha256').update(source).digest('hex')).toBe(native.sourceSha256);
  expect(native.pages).toBe(1); expect(native.frames).toHaveLength(name === 'different' ? 2 : 1);
  const frame = native.frames[0]; expect(frame.width).toBe(144); expect(frame.height).toBe(72);
  expect(Math.abs(frame.x - 144)).toBeLessThan(.1); expect(Math.abs(frame.y - 144)).toBeLessThan(.1);
  expect(frame.horizontalBase).toBe(name === 'margin' ? 0 : 1); expect(frame.verticalBase).toBe(name === 'margin' ? 0 : 1);
  expect(frame.text).toBe(name === 'grouped' ? 'Framed first line\rFramed second line' : 'Framed first line');
  if (name === 'different') { expect(native.frames[1].text).toBe('Framed second line'); expect(native.frames[1].height).toBeGreaterThan(frame.height); }
});

const measure = text => ({ width: text.length * 7, ascent: 12, descent: 4 });
const layout = d => layoutDocument(d.paragraphs, measure, pageGeometry(d.pageSettings), d.numbering, d.tables);
it('frame edits retain source offsets, change grouping when paragraph formatting is cleared, and undo restores layout', async () => {
  const pkg = await DocxPackage.open(readFileSync('tests/fixtures/paragraph-frames/grouped.docx'));
  const d = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
  const before = layout(d), offset = d.text.indexOf('Framed second line');
  expect(before.paragraphFrames).toHaveLength(1);
  expect(before.lines.find(l => l.paragraphId === d.paragraphs[2].id).start).toBe(offset);
  const line = before.lines.find(l => l.start === offset);
  expect(hitTest(before, line.page, line.stops[3].x, line.y + 4)).toBe(offset + 3);
  expect(caretRect(before, offset + 3).x).toBe(line.stops[3].x);
  d.select(offset); d.replace('Edited ');
  expect(layout(d).paragraphFrames).toHaveLength(1);
  d.undo(); expect(layout(d).lines).toEqual(before.lines);
  d.select(offset); d.clearDirectParagraphFormatting();
  const cleared = layout(d);
  expect(cleared.paragraphFrames[0].paragraphIds).toHaveLength(1);
  expect(cleared.lines.find(l=>l.start===offset).stops[0].x).toBe(pageGeometry(d.pageSettings).left);
  d.undo(); expect(layout(d).lines).toEqual(before.lines);
});
it('unsupported frame placement preserves all other layout in a localized preview', async () => {
  const pkg = await DocxPackage.open(readFileSync('tests/fixtures/paragraph-frames/page.docx'));
  pkg.paragraphs[1].frameProperties = { ...pkg.paragraphs[1].frameProperties, dropCap: 'drop', lines: '0' };
  expect(() => layoutDocument(pkg.paragraphs, measure, pageGeometry(pkg.pageSettings))).toThrow('Drop-cap');
  const preview = layoutDocument(pkg.paragraphs, measure, pageGeometry(pkg.pageSettings), pkg.numbering, pkg.tables, undefined, { bestEffort: true });
  expect(preview.frameApproximations).toHaveLength(1);
  expect(preview.lines.flatMap(l => l.fragments.map(f => f.text)).join(' ')).toContain('Healthy after');
  expect(pkg.paragraphs[1].frameProperties.dropCap).toBe('drop');
});
it('inherited frame declarations do not replace a shape text-box flow', async () => {
  const pkg = await DocxPackage.open(readFileSync('tests/fixtures/paragraph-frames/style.docx'));
  pkg.paragraphs.forEach(p=>p.drawingText=true);
  const result=layoutDocument(pkg.paragraphs,measure,pageGeometry(pkg.pageSettings));
  expect(result.paragraphFrames).toHaveLength(0);
  expect(result.lines.map(l=>l.stops[0].x)).toEqual([96,96,96]);
  expect(pkg.paragraphs[1].frameProperties).toBeDefined();
});

for (const name of ['terminal-page','terminal-text','terminal-empty-inline','footer-inline','footer-inline-text','footer-page','footer-text','footer-grouped','inline-flow','cell-inline']) it(`${name} terminal/story evidence matches the untouched original source`, async () => {
 const bytes=readFileSync(`tests/fixtures/paragraph-frames/${name}.docx`);
 const native=JSON.parse(readFileSync(`tests/fixtures/paragraph-frames/${name}-native.json`,'utf8').replace(/^\uFEFF/,''));
 expect(createHash('sha256').update(bytes).digest('hex')).toBe(native.sourceSha256);
 const pkg=await DocxPackage.open(bytes),d=new TextDocument(pkg.paragraphs,pkg.pageSettings,pkg.numbering,pkg.styles,pkg.tables,pkg.assets);
 expect(unzipSync(new Uint8Array(await pkg.export(d.paragraphs,d.pageSettings,d.numbering,d.styles,d.tables,d.assets).arrayBuffer()))).toEqual(unzipSync(bytes));
 const placed=layout(d);expect(placed.pageCount).toBe(native.pages);
 expect(placed.paragraphFrames.length).toBe(native.frames.length);
 if(name==='terminal-text')expect(placed.paragraphFrames[0].top).toBe(112);
});
it('paragraph borders cannot join across an ordinary-flow/frame boundary',async()=>{
 const pkg=await DocxPackage.open(readFileSync('tests/fixtures/paragraph-frames/bordered.docx'));
 const placed=layoutDocument(pkg.paragraphs,measure,pageGeometry(pkg.pageSettings));
 expect(placed.paragraphBorders).toHaveLength(12);
 expect(placed.paragraphBorders.filter(b=>b.frameId)).toHaveLength(4);
});

it('page-relative footer frame borders and clipping stay at physical page coordinates',async()=>{
 const pkg=await DocxPackage.open(readFileSync('tests/fixtures/paragraph-frames/footer-bordered.docx'));
 const body=layoutDocument(pkg.paragraphs,measure,pageGeometry(pkg.pageSettings));
 const placed=layoutPageStories(body,pkg.pageStories,[pkg.pageSettings],measure,pkg.numbering);
 const line=placed.lines.find(l=>l.frameId),borders=placed.borders.filter(b=>b.paragraphId===line.paragraphId);
 expect(borders).toHaveLength(4);expect(borders.every(b=>b.y<300)).toBe(true);
 expect(borders.every(b=>b.cellClip.top===line.cellClip.top)).toBe(true);
});
it('an unsupported footer frame preserves its text and neighboring footer in best-effort recovery',async()=>{
 const pkg=await DocxPackage.open(readFileSync('tests/fixtures/paragraph-frames/footer-grouped.docx'));
 const footer=Object.values(pkg.pageStories.stories)[0];footer.paragraphs[0].frameProperties.dropCap='drop';footer.paragraphs[0].frameProperties.lines='0';
 const body=layoutDocument(pkg.paragraphs,measure,pageGeometry(pkg.pageSettings));
 const placed=layoutPageStories(body,pkg.pageStories,[pkg.pageSettings],measure,pkg.numbering,{bestEffort:true});
 expect(placed.lines.flatMap(l=>l.fragments.map(f=>f.text)).join(' ')).toContain('Framed first line');
 expect(placed.lines.flatMap(l=>l.fragments.map(f=>f.text)).join(' ')).toContain('Healthy after');
 expect(placed.unsupported.length).toBeGreaterThan(0);
 expect(footer.paragraphs[0].frameProperties.dropCap).toBe('drop');
});

it('unbordered frame shading fills the authored width and height without enlarging line boxes',async()=>{
 const pkg=await DocxPackage.open(readFileSync('tests/fixtures/paragraph-frames/shaded.docx'));
 const placed=layoutDocument(pkg.paragraphs,measure,pageGeometry(pkg.pageSettings));
 const frame=placed.paragraphFrames[0],line=placed.lines.find(l=>l.frameId);
 expect(line.paragraphBackground.x).toBe(frame.left);
 expect(line.paragraphBackground.width).toBe(frame.right-frame.left);
 expect(line.y+line.height+line.paragraphBackground.after).toBe(frame.bottom);
 expect(line.height).toBe(16);
});
