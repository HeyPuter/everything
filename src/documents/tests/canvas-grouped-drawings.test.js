import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { DocxPackage, W } from '../src/engine/docx.js';
import { TextDocument } from '../src/engine/model.js';
import { layoutDocument, imageAtPoint, selectionRects } from '../src/engine/layout.js';
import { pageGeometry } from '../src/engine/page-settings.js';
import { MC, WPG, WPS } from '../src/engine/docx-compatibility.js';
import { A, WP } from '../src/engine/docx-images.js';
import { layoutShapeText } from '../src/engine/canvas-shapes.js';
import { expectBodyEditParts } from './helpers/expect-body-edit-parts.js';
let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => { dom.window.close(); delete globalThis.DOMParser; delete globalThis.XMLSerializer; });
const source = readFileSync('public/fixtures/grouped-drawings.docx');
const model = p => new TextDocument(p.paragraphs, p.pageSettings, p.numbering, p.styles, p.tables, p.assets);
const save = async (p, d) => new Uint8Array(await p.export(d.paragraphs, d.pageSettings, d.numbering, d.styles, d.tables, d.assets).arrayBuffer());
const measure = (t, s) => ({ width: t.length * s.fontSize * .6, ascent: s.fontSize, descent: s.fontSize / 3 });
const layout = d => layoutDocument(d.paragraphs, measure, pageGeometry(d.pageSettings), d.numbering, d.tables);
const node = (r, ns, name) => r.getElementsByTagNameNS(ns, name)[0];
const drawings = d => d.paragraphs.flatMap(p => p.runs.filter(r => r.image).map(r => r.image));
function changed(change) {
  const parts = unzipSync(source), xml = new DOMParser().parseFromString(strFromU8(parts['word/document.xml']), 'application/xml');
  change(xml); parts['word/document.xml'] = strToU8(new XMLSerializer().serializeToString(xml)); return zipSync(parts);
}
function retained(bytes, parts, edited = false) {
  const out = unzipSync(bytes); expect(Object.keys(out).sort()).toEqual(Object.keys(parts).sort());
  for (const [name, value] of Object.entries(parts)) if (!edited || name !== 'word/document.xml') expect(Buffer.from(out[name]).equals(Buffer.from(value)), name).toBe(true);
}

it('reads nested group transforms, paths, text, picture references and section geometry from an independent fixture', async () => {
  const pkg = await DocxPackage.open(source), doc = model(pkg), images = drawings(doc);
  expect(images).toHaveLength(3); expect(images.every(i => i.kind === 'drawing' && i.retainedDrawing)).toBe(true);
  const scene = pkg.assets[images[0].assetId].scene;
  expect(scene).toMatchObject({ type: 'group', width: 2743200, childX: 1000, childY: 2000, childWidth: 1371600 });
  expect(scene.children[0].children[0]).toMatchObject({ type: 'shape', fill: '#C2CB93', paths: [{ points: [['M', 0, 0], ['L', 100, 0], ['L', 90, 100], ['L', 0, 100], ['Z']] }] });
  expect(scene.children[0].children[0].text.paragraphs[0].runs[0].text).toBe('Group text');
  expect(scene.children[0].children[1].type).toBe('picture');
  expect(doc.paragraphs.find(p => p.sectionEnd).sectionEnd.top).toBe(360); expect(doc.pageSettings.top).toBe(1440);
  retained(await save(pkg, doc), pkg.parts);
});

it('edits drawing host paragraphs, splits their section mark, reopens both MCE branches and undoes to exact source parts', async () => {
  const pkg = await DocxPackage.open(source), doc = model(pkg);
  const at = doc.text.indexOf('Behind'); doc.select(at); doc.replace('Updated ');
  const i = doc.paragraphs.findIndex(p => p.sectionEnd); doc.select(doc.paragraphOffset(i)); doc.toggleBold(); doc.insertParagraph();
  expect(doc.paragraphs.filter(p => p.sectionEnd)).toHaveLength(1);
  expect(doc.paragraphs[i].sectionEnd).toBeUndefined(); expect(doc.paragraphs[i + 1].sectionEnd).toBeDefined();
  const saved = await save(pkg, doc), reopened = await DocxPackage.open(saved);
  expect(model(reopened).text).toBe(doc.text); expect(drawings(reopened)).toHaveLength(3);
  expect(reopened.paragraphs.filter(p => p.sectionEnd)).toHaveLength(1);
  const xml = new DOMParser().parseFromString(strFromU8(unzipSync(saved)['word/document.xml']), 'application/xml');
  expect([...node(xml, W, 'sectPr').parentElement.children].map(n => n.localName)).toEqual(['rPr', 'sectPr']);
  expect(drawings(reopened).every(i => i.shell.includes('Fallback') && i.shell.includes('Requires="wpg"'))).toBe(true);
  expectBodyEditParts(unzipSync(saved), pkg.parts);
  while (doc.history.length) doc.undo(); retained(await save(pkg, doc), pkg.parts);
});

it('retains text-box paragraph spacing for either edge-spacing flag without mutating the source', async () => {
  const pkg = await DocxPackage.open(source), shape = pkg.assets[drawings(pkg)[0].assetId].scene.children[0].children[0];
  expect(shape.text.edgeSpacing).toBe(false);
  Object.assign(shape.text.paragraphs[0].format, { spaceBefore: 18, spaceAfter: 12 });
  const before = structuredClone(shape), normal = layoutShapeText(shape, measure);
  expect(shape).toEqual(before);
  const spaced = layoutShapeText({ ...shape, text: { ...shape.text, edgeSpacing: true } }, measure);
  expect(normal.layout.lines[0].y).toBeCloseTo(24);
  expect(spaced.layout.lines[0].y).toBe(normal.layout.lines[0].y);
  expect(spaced.layout.endY).toBe(normal.layout.endY);
  const explicit = await DocxPackage.open(changed(xml => node(xml, WPS, 'bodyPr').setAttribute('spcFirstLastPara', 'true')));
  expect(explicit.assets[drawings(explicit)[0].assetId].scene.children[0].children[0].text.edgeSpacing).toBe(true);
});

it('lays out grouped shape text in physical coordinates with fixed point sizes and insets', async () => {
  const pkg = await DocxPackage.open(readFileSync('public/fixtures/group-text-scaling.docx'));
  const cases = [[1, 1], [2, 2], [4, .5], [4, 1]];
  const results = drawings(pkg).map((image, i) => {
    let shape = pkg.assets[image.assetId].scene;
    while (shape.type === 'group') shape = shape.children[0];
    const before = structuredClone(shape), [x, y] = cases[i];
    const result = layoutShapeText(shape, measure, { x, y });
    expect(shape).toEqual(before);
    return result;
  });
  const lines = result => result.layout.lines.map(l => ({ text: l.fragments.map(f => f.text).join(''), width: l.width, baseline: l.baseline }));
  for (const result of results) expect(lines(result)).toEqual(lines(results[0]));
  expect(results[0].shift).toBe(0); expect(results[1].shift).toBe(0);
  expect(results[2].shift).toBeGreaterThan(0);
  expect(results[3].shift).toBeCloseTo(results[2].shift * 2);
});

it('uses the transformed frame for writing-space validation and overflowing vertical anchors', async () => {
  const pkg = await DocxPackage.open(source), original = pkg.assets[drawings(pkg)[0].assetId].scene.children[0].children[0];
  const shape = structuredClone(original);
  shape.width = 9525 * 30; shape.height = 9525 * 2;
  Object.assign(shape.text, { left: 9525 * 20, right: 9525 * 20, top: 0, bottom: 0 });
  expect(() => layoutShapeText(shape, measure)).toThrow(/no writing space/);
  const scale = { x: 4, y: .25 };
  const top = layoutShapeText(shape, measure, scale);
  shape.text.anchor = 'ctr'; const center = layoutShapeText(shape, measure, scale);
  shape.text.anchor = 'b'; const bottom = layoutShapeText(shape, measure, scale);
  expect(top.shift).toBe(0); expect(center.shift).toBe(0);
  expect(bottom.shift).toBe(0); // Layout clips overflow and keeps the first line.
  expect(top.clip.height).toBeLessThan(top.layout.endY);
  expect(top.layout.lines).toEqual(center.layout.lines);
  expect(top.layout.lines).toEqual(bottom.layout.lines);
  // Shrinking a valid source frame can also eliminate its writing space.
  shape.width = 9525 * 100;
  expect(() => layoutShapeText(shape, measure, { x: .25, y: 4 })).toThrow(/no writing space/);
});

it('keeps grouped drawings atomic through deletion and undo and rejects property edits without creating history', async () => {
  const pkg = await DocxPackage.open(source), doc = model(pkg), at = doc.text.indexOf('\ufffc');
  doc.select(at, at + 1); expect(() => doc.setImageProperties({ width: 1000000 })).toThrow(/complete objects/); expect(doc.history).toHaveLength(0);
  doc.replace(''); expect(drawings(doc)).toHaveLength(2); doc.undo(); expect(drawings(doc)).toHaveLength(3);
  retained(await save(pkg, doc), pkg.parts); doc.redo(); expect(drawings(await DocxPackage.open(await save(pkg, doc)))).toHaveLength(2);
});

it('preserves section boundaries during body edits, undoes edits crossing them exactly and applies paper settings to one section', async () => {
  const doc = model(await DocxPackage.open(source)), index = doc.paragraphs.findIndex(p => p.sectionEnd);
  // Edits across a section mark follow native ownership (section-editing.test.js); here they must undo exactly.
  doc.select(doc.paragraphOffset(index), doc.paragraphOffset(index + 1)); const crossing = doc.snapshot();
  expect(doc.replace('x')).toBe(true); doc.undo(); expect(doc.snapshot()).toEqual(crossing);
  expect(() => doc.editParagraphStyle('Normal', { run: { bold: true } })).toThrow(/Named styles are retained/);
  const sectioned = doc.snapshot();
  expect(doc.setPageSettings({ top: 720 })).toBe(true); expect(doc.sectionSettings.filter(s => s.top === 720)).toHaveLength(1);
  doc.undo(); expect(doc.snapshot()).toEqual(sectioned);
  const result = layout(doc), next = result.lines.find(l => l.paragraphId === doc.paragraphs[index + 1].id);
  expect(next.page).toBe(1); expect(next.y).toBe(96); expect(result.pages.map(p => p.top)).toEqual([24, 96]);
});

it('places positioned drawings independently of inline text and exposes hit/selection rectangles', async () => {
  const doc = model(await DocxPackage.open(source)), result = layout(doc), [behind, band] = result.floatingObjects;
  const host = result.lines.find(l => l.start <= behind.start && l.end >= behind.end);
  expect(behind.y).toBe(host.y); expect(behind.x).toBe(58); expect(host.height).toBeLessThan(behind.height);
  expect(behind.image.anchor.behind).toBe(true);
  // Ordinary clicks retain text priority. Explicit picture selection still
  // uses the independent floating frame, including for retained groups.
  expect(imageAtPoint(result, behind.page, behind.x + 2, behind.y + 2)).toBeNull();
  expect(imageAtPoint(result, behind.page, behind.x + 2, behind.y + 2, { includeBehindText: true })).toEqual(behind);
  expect(selectionRects(result, behind.start, behind.end)).toContainEqual({ page: behind.page, x: behind.x, y: behind.y, width: behind.width, height: behind.height });
  const after = result.lines.find(l => l.start > band.end); expect(after.y).toBeGreaterThanOrEqual(band.y + band.height);
});

it('selects the first understood Choice, ignoring unsupported and inactive branches without discarding them on export', async () => {
  const bytes = changed(xml => {
    const alt = node(xml, MC, 'AlternateContent'), unsupported = xml.createElementNS(MC, 'mc:Choice');
    unsupported.setAttributeNS('http://www.w3.org/2000/xmlns/', 'xmlns:future', 'urn:future'); unsupported.setAttribute('Requires', 'future');
    unsupported.append(xml.createElementNS(W, 'w:sectPr')); alt.prepend(unsupported);
    node(alt, MC, 'Fallback').append(xml.createElementNS(W, 'w:vanish'));
  });
  const pkg = await DocxPackage.open(bytes), doc = model(pkg); doc.select(1); doc.replace('x');
  expect(drawings(await DocxPackage.open(await save(pkg, doc)))).toHaveLength(3);
  expectBodyEditParts(unzipSync(await save(pkg, doc)), pkg.parts);
});

it('uses a standard fallback for an unknown extension instead of interpreting the unknown Choice', async () => {
  const pkg = await DocxPackage.open(changed(xml => { const c = node(xml, MC, 'Choice'); c.setAttributeNS('http://www.w3.org/2000/xmlns/', 'xmlns:future', 'urn:future'); c.setAttribute('Requires', 'future'); }));
  expect(drawings(pkg)[0].kind).toBeUndefined(); expect(drawings(pkg)[0].retainedDrawing).toBe(true);
});

it.each([
  ['unbound MCE requirements', x => node(x, MC, 'Choice').setAttribute('Requires', 'absent')],
  ['empty MCE requirements', x => node(x, MC, 'Choice').setAttribute('Requires', '')],
  ['invalid branch ordering', x => { const alt = node(x, MC, 'AlternateContent'); alt.prepend(node(alt, MC, 'Fallback')); }],
  ['unsupported alternate preprocessing', x => node(x, MC, 'AlternateContent').setAttributeNS(MC, 'mc:ProcessContent', 'wps:wsp')],
  ['unsupported selected branch', x => node(x, WPG, 'wgp').append(x.createElementNS(WPG, 'wpg:graphicFrame'))],
  ['malformed group rotation', x => node(x, A, 'xfrm').setAttribute('rot', '1.5')],
  ['negative child space', x => node(x, A, 'chExt').setAttribute('cx', '-1')],
  ['guide formulas', x => node(x, A, 'gdLst').append(x.createElementNS(A, 'a:gd'))],
  ['unsupported shape fills', x => node(x, WPS, 'spPr').append(x.createElementNS(A, 'a:gradFill'))],
  ['hidden shape', x => node(x, WPS, 'cNvPr').setAttribute('hidden', '1')],
  ['vertical body', x => node(x, WPS, 'bodyPr').setAttribute('vert', 'vert270')],
  ['linked text box', x => node(x, WPS, 'txbx').setAttribute('id', '1')],
  ['complex text formatting', x => node(node(x, WPS, 'txbx'), W, 'rPr').append(x.createElementNS(W, 'w:strike'))],
  ['next-column sections', x => { const s = [...x.getElementsByTagNameNS(W, 'sectPr')].at(-1); for (const old of [...s.getElementsByTagNameNS(W, 'type')]) old.remove(); const n = x.createElementNS(W, 'w:type'); n.setAttributeNS(W, 'w:val', 'nextColumn'); s.prepend(n); }],
  ['invalid paper sizes', x => node(x, W, 'pgSz').setAttributeNS(W, 'w:w', '0')],
])('rejects %s before returning an editable package', async (_, alter) => {
  await expect(DocxPackage.open(changed(alter))).rejects.toThrow();
});

it('lays out continuous drawing sections with changed margins', async () => {
  const input = changed(x => {
    const s = [...x.getElementsByTagNameNS(W, 'sectPr')].at(-1);
    for (const old of [...s.getElementsByTagNameNS(W, 'type')]) old.remove();
    const n = x.createElementNS(W, 'w:type'); n.setAttributeNS(W, 'w:val', 'continuous'); s.prepend(n);
  });
  const pkg = await DocxPackage.open(input), doc = model(pkg);
  expect(pkg.pageSettings.sectionType).toBe('continuous');
  expect(drawings(doc)).toHaveLength(3);
  retained(await save(pkg, doc), unzipSync(input));
  const placed = layout(doc);
  expect(placed.floatingObjects).toHaveLength(2);
  expect(placed.lines.flatMap(l => l.fragments).filter(f => f.image)).toHaveLength(3);
  expect(placed.pages.every(p => p.width > 0 && p.height > 0)).toBe(true);
});


it('keeps text on either side of a top-and-bottom exclusion band, including wrapped lines', async () => {
  const pkg = await DocxPackage.open(source), doc = model(pkg), p = doc.paragraphs.find(p => p.runs.some(r => r.image?.anchor?.wrap === 'topAndBottom'));
  p.runs.find(r => r.image).image.anchor.y = 30 * 9525;
  doc.select(doc.paragraphOffset(doc.paragraphs.indexOf(p))); doc.replace('word '.repeat(70));
  const result = layout(doc), band = result.floatingObjects.find(f => f.image.anchor.wrap === 'topAndBottom');
  const lines = result.lines.filter(l => l.paragraphId === p.id);
  expect(lines.length).toBeGreaterThan(2);
  for (const line of lines) for (const f of line.fragments.filter(f => !f.image)) {
    expect(line.baseline + f.descent <= band.y + 1e-6 || line.baseline - f.ascent >= band.y + band.height - 1e-6).toBe(true);
  }
});

it('deletes across section breaks with Backspace and Delete and restores selection and content on undo', async () => {
  const doc = model(await DocxPackage.open(source)), i = doc.paragraphs.findIndex(p => p.sectionEnd);
  for (const [position, direction] of [[doc.paragraphOffset(i + 1), -1], [doc.paragraphOffset(i + 1) - 1, 1]]) {
    doc.select(position); const before = doc.snapshot();
    doc.delete(direction); expect(doc.history).toHaveLength(1);
    doc.undo(); expect(doc.snapshot()).toEqual(before); expect(doc.history).toHaveLength(0);
  }
});

it('retains identity alpha modifiers on grouped picture fills', async () => {
  const bytes = changed(xml => node(xml, A, 'blip').append(xml.createElementNS(A, 'a:alphaModFix')));
  const pkg = await DocxPackage.open(bytes); retained(await save(pkg, model(pkg)), pkg.parts);
});

it('rejects an unknown required namespace even when the drawing itself has a known Choice', async () => {
  await expect(DocxPackage.open(changed(xml => {
    xml.documentElement.setAttributeNS('http://www.w3.org/2000/xmlns/', 'xmlns:future', 'urn:future');
    xml.documentElement.setAttributeNS(MC, 'mc:MustUnderstand', 'future');
  }))).rejects.toThrow(/MustUnderstand/);
});
