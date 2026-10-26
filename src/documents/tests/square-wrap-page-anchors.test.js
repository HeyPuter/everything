import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { zipSync, unzipSync, strFromU8 } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { TextDocument } from '../src/engine/model.js';
import { pageGeometry } from '../src/engine/page-settings.js';
import { layoutDocument, imageAtPoint } from '../src/engine/layout.js';
import { moveDrawings } from '../src/engine/drawing-arrange.js';
import { squareWrapDocx as docx, offset, align } from './helpers/square-wrap-docx.js';

// Templates often place a square-wrapped picture against the page or margin, or align it there
// (§20.4.2.10 positionH, §20.4.2.11 positionV, §20.4.2.17 wrapSquare). Such a document opens for
// editing: the picture sits where its coordinates say, text on its page flows around it, and the
// drawing's XML is saved as authored.
let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());

const model = p => new TextDocument(p.paragraphs, p.pageSettings, p.numbering, p.styles, p.tables, p.assets);
const measure = (text, style) => ({ width: text.length * style.fontSize * .5, ascent: style.fontSize, descent: style.fontSize / 3 });
const layout = d => layoutDocument(d.paragraphs, measure, pageGeometry(d.pageSettings), d.numbering, d.tables);
const save = async (p, d) => new Uint8Array(await p.export(d.paragraphs, d.pageSettings, d.numbering, d.styles, d.tables, d.assets).arrayBuffer());
const anchorXml = parts => strFromU8(parts['word/document.xml']).match(/<wp:anchor[\s\S]*?<\/wp:anchor>/)[0];
// Text never runs under the picture: each line segment beside it ends before its left side
// (less the 0.125 in distance) or starts after its right side.
function expectWrappedAround(placed, frame) {
  const beside = placed.lines.filter(l => l.page === frame.page && l.y < frame.y + frame.height && l.y + l.height > frame.y && l.fragments.some(f => f.text?.trim()));
  expect(beside.length).toBeGreaterThan(0);
  for (const line of beside) for (const f of line.fragments) if (f.text?.trim() && !f.image) {
    expect(f.x + f.width <= frame.x - 12 + 1e-6 || f.x >= frame.x + frame.width + 12 - 1e-6, `fragment "${f.text}" at ${f.x}`).toBe(true);
  }
}

// Letter page, 1 in margins: 96 px per inch; the picture is 1.5 in by 1 in (144 by 96 px).
it.each([
  ['right of the margin, below the paragraph top', ['margin', align('right')], ['paragraph', offset(0)], 816 - 96 - 144, null],
  ['at page offsets', ['page', offset(914400)], ['page', offset(1828800)], 96, 192],
  ['at the margin top left', ['margin', align('left')], ['margin', align('top')], 96, 96],
  ['centred on the page, at the bottom margin', ['page', align('center')], ['margin', align('bottom')], (816 - 144) / 2, 1056 - 96 - 96],
  ['in the column, at a page offset', ['column', offset(457200)], ['page', offset(2743200)], 96 + 48, 288],
])('opens a square-wrapped picture %s for editing and keeps its XML', async (_, h, v, x, y) => {
  const bytes = docx(h, v), pkg = await DocxPackage.open(bytes), doc = model(pkg);
  expect(pkg.readOnly).toBeFalsy();
  const image = doc.paragraphs.flatMap(p => p.runs).find(r => r.image).image;
  expect(image.anchor).toMatchObject({ horizontal: h[0], vertical: v[0], wrap: 'square', wrapText: 'bothSides' });
  const placed = layout(doc), [frame] = placed.floatingObjects;
  expect(frame.x).toBeCloseTo(x, 5);
  if (y !== null) expect(frame.y).toBeCloseTo(y, 5);
  else expect(frame.y).toBeCloseTo(placed.lines.find(l => l.paragraphId === doc.paragraphs[1].id).y, 5);
  expect([frame.width, frame.height]).toEqual([144, 96]);
  expect(imageAtPoint(placed, frame.page, frame.x + 4, frame.y + 4)?.image.id).toBe(image.id);
  expectWrappedAround(placed, frame);
  // An unchanged save keeps the package; an edit keeps the drawing's XML and geometry.
  expect(unzipSync(await save(pkg, doc))).toEqual(unzipSync(bytes));
  doc.select(0); doc.replace('Edited ');
  const edited = unzipSync(await save(pkg, doc));
  expect(anchorXml(edited)).toBe(anchorXml(unzipSync(bytes)));
  const again = model(await DocxPackage.open(zipSync(edited))), reopened = layout(again).floatingObjects[0];
  expect([reopened.page, reopened.x, reopened.y]).toEqual([frame.page, frame.x, frame.y]);
});

it('moves a margin-aligned square-wrapped picture to an offset on the same base', async () => {
  const pkg = await DocxPackage.open(docx(['margin', align('right')], ['page', align('top')])), doc = model(pkg);
  const image = doc.paragraphs.flatMap(p => p.runs).find(r => r.image).image;
  expect(moveDrawings(doc, [{ image, x: 914400, y: 457200 }])).toBe(true);
  const out = unzipSync(await save(pkg, doc)), xml = anchorXml(out);
  expect(xml).toContain('<wp:positionH relativeFrom="margin"><wp:posOffset>914400</wp:posOffset></wp:positionH>');
  expect(xml).toContain('<wp:positionV relativeFrom="page"><wp:posOffset>457200</wp:posOffset></wp:positionV>');
  const again = model(await DocxPackage.open(zipSync(out))), placed = layout(again), [frame] = placed.floatingObjects;
  expect([frame.x, frame.y]).toEqual([96 + 96, 48]);
  expectWrappedAround(placed, frame);
});

it('keeps line-relative and paragraph-aligned square wrapping out of the editing subset', async () => {
  for (const v of [['line', offset(0)], ['paragraph', align('top')]]) {
    await expect(DocxPackage.open(docx(['margin', align('right')], v))).rejects.toThrow(/unsupported positionV/);
    expect((await DocxPackage.open(docx(['margin', align('right')], v), { bestEffort: true })).readOnly).toBe(true);
  }
});
