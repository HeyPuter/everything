import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import { createDocx, DocxPackage, W } from '../src/engine/docx.js';
import { TextDocument, paragraph, paragraphFormat } from '../src/engine/model.js';
import { emptyNumbering, newList, levelFor, listMarkers } from '../src/engine/numbering.js';
import { layoutDocument, caretRect, hitTest, selectionRects } from '../src/engine/layout.js';
import { pageGeometry } from '../src/engine/page-settings.js';
import { expectBodyEditParts } from './helpers/expect-body-edit-parts.js';

let dom;
beforeAll(() => { dom = new JSDOM(''); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => { dom.window.close(); delete globalThis.DOMParser; delete globalThis.XMLSerializer; });
const bytes = async blob => new Uint8Array(await blob.arrayBuffer());
const docOf = pkg => new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering);
const exportDoc = (pkg, doc) => bytes(pkg.export(doc.paragraphs, doc.pageSettings, doc.numbering));
const labels = doc => listMarkers(doc.paragraphs, doc.numbering).map(m => m?.text ?? null);
const measure = (text, style) => ({ width: [...text].length * 8 * style.fontSize / 12, ascent: 15 * style.fontSize / 12, descent: 5 * style.fontSize / 12, underlineOffset: 2, underlineThickness: 1 });
const layout = doc => layoutDocument(doc.paragraphs, measure, pageGeometry(doc.pageSettings), doc.numbering);
const fixture = () => DocxPackage.open(new Uint8Array(readFileSync('public/fixtures/numbering.docx')));
const indexed = (doc, i) => doc.paragraphs.slice(0, i).reduce((n, p) => n + p.runs.reduce((a, r) => a + r.text.length, 0) + 1, 0);
const sameParts = (a, b) => { expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort()); for (const name of Object.keys(a)) expect(Buffer.from(a[name]).equals(Buffer.from(b[name])), name).toBe(true); };
async function rewrite(pkg, mutate) {
  const parts = { ...pkg.parts };
  const xmls = {};
  for (const path of ['word/document.xml', 'word/numbering.xml', 'word/styles.xml']) xmls[path] = new DOMParser().parseFromString(strFromU8(parts[path]), 'application/xml');
  mutate(xmls);
  for (const [path, doc] of Object.entries(xmls)) parts[path] = strToU8(new XMLSerializer().serializeToString(doc));
  return DocxPackage.open(zipSync(parts));
}
const el = (doc, name, value) => { const n = doc.createElementNS(W, 'w:' + name); if (value !== undefined) n.setAttributeNS(W, 'w:val', String(value)); return n; };
const nodes = (doc, name) => [...doc.getElementsByTagNameNS(W, name)];

describe('original numbering projection and editing', () => {
  it('counts nested levels and separate instances across interruptions without modifying text', async () => {
    const doc = docOf(await fixture()), text = doc.text;
    expect(labels(doc)).toEqual(['3.', '4.', '4.a)', '4.b)', '5.', '7.', '8.', '•', '•', null, '•']);
    expect(doc.text).toBe(text); expect(doc.paragraphs[9].list).toBeNull();
    expect(doc.paragraphs[0].markFormat.italic).toBe(true);
    expect(doc.paragraphs[0].runs[0].italic).toBe(true);
    doc.paragraphs.splice(2, 0, paragraph('An interruption'));
    expect(labels(doc).slice(0, 5)).toEqual(['3.', '4.', null, '4.a)', '4.b)']);
  });
  it('supports starts, level restarts, never-restart and native suppression of deeper references', () => {
    const numbering = emptyNumbering(), numId = newList(numbering, 'number'), levels = numbering.abstracts[1].levels;
    levels[0].format = 'upperRoman'; levels[0].start = 3;
    levels[1].format = 'lowerLetter'; levels[1].text = '%1/%2/%3'; levels[1].restart = 0;
    levels[2].text = '%1.%2.%3'; levels[2].legal = true; levels[2].restart = 1;
    const ps = [0, 1, 2, 1, 2, 0, 1, 2].map(level => paragraph('x', { list: { numId, level } }));
    // Independently recorded reference controls live in fixtures/none-numbering.
    expect(listMarkers(ps, numbering).map(m => m.text)).toEqual(['III.', '', '3..1', '', '3..2', 'IV.', '', '4..1']);
    expect(listMarkers(ps, numbering).at(-2).counters[1]).toBe(3);
    levels[1].restart = undefined;
    expect(listMarkers(ps, numbering).at(-2).counters[1]).toBe(1);
    levels[1].restart = 9; // Invalid later restart levels are ignored, so the default applies.
    expect(listMarkers(ps, numbering).at(-2).counters[1]).toBe(1);
    levels[0].format = 'bullet'; levels[0].text = '•';
    levels[1].text = '%1/%2';
    expect(listMarkers(ps, numbering)[1].text).toBe('/a');
  });
  it('uses repeated-letter alphabetic numbering past Z and decimal-zero labels', () => {
    const numbering = emptyNumbering(), numId = newList(numbering, 'number'), level = numbering.abstracts[1].levels[0];
    level.format = 'upperLetter'; level.start = 26;
    const ps = [0, 1, 2].map(() => paragraph('', { list: { numId, level: 0 } }));
    expect(listMarkers(ps, numbering).map(m => m.text)).toEqual(['Z.', 'AA.', 'BB.']);
    level.format = 'decimalZero'; level.start = 8;
    expect(listMarkers(ps, numbering).map(m => m.text)).toEqual(['08.', '09.', '10.']);
  });
  it('toggles selected paragraphs, continues the preceding sequence, and undoes definitions and selection atomically', () => {
    const doc = new TextDocument([paragraph('One'), paragraph('Two'), paragraph('Three')]);
    doc.select(0, 4); const before = doc.snapshot();
    doc.toggleList('number'); expect(labels(doc)).toEqual(['1.', null, null]); expect(doc.history).toHaveLength(1);
    expect(doc.selection).toEqual(before.selection);
    doc.select(4, 8); doc.toggleList('number'); expect(labels(doc)).toEqual(['1.', '2.', null]);
    doc.select(0, doc.text.length); expect(doc.listFormatting).toBe('mixed');
    doc.toggleList('bullet'); expect(labels(doc)).toEqual(['•', '•', '•']);
    doc.toggleList('bullet'); expect(labels(doc)).toEqual([null, null, null]);
    doc.undo(); expect(labels(doc)).toEqual(['•', '•', '•']); doc.redo(); expect(labels(doc)).toEqual([null, null, null]);
    while (doc.undo()) {} expect(doc.snapshot()).toEqual(before);
  });
  it('inherits lists when splitting, exits empty items with Enter or Backspace, and keeps the first paragraph on merge', () => {
    const doc = new TextDocument([paragraph('First')]); doc.toggleList('number');
    doc.select(doc.text.length); doc.insertParagraph(); doc.replace('Second');
    expect(labels(doc)).toEqual(['1.', '2.']);
    doc.insertParagraph(); expect(labels(doc)).toEqual(['1.', '2.', '3.']);
    doc.insertParagraph(); expect(labels(doc)).toEqual(['1.', '2.', null]);
    doc.undo(); expect(labels(doc)).toEqual(['1.', '2.', '3.']);
    doc.delete(-1); expect(labels(doc)).toEqual(['1.', '2.', null]);
    doc.undo(); doc.select(3, 8); doc.replace('X');
    expect(doc.paragraphs).toHaveLength(2); expect(labels(doc)).toEqual(['1.', '2.']);
    doc.undo(); expect(labels(doc)).toEqual(['1.', '2.', '3.']);
  });
  it('steps an empty nested item out one level with Enter, and ends the list only at the top level', () => {
    const doc = new TextDocument([paragraph('First')]); doc.toggleList('number');
    doc.select(doc.text.length); doc.insertParagraph(); doc.changeListLevel(1); doc.replace('Inner');
    doc.insertParagraph(); expect(labels(doc)).toEqual(['1.', '1.1.', '1.2.']);
    // Enter on the empty nested item makes it the next item one level up, rather than leaving the list.
    doc.insertParagraph(); expect(labels(doc)).toEqual(['1.', '1.1.', '2.']); expect(doc.paragraphs).toHaveLength(3);
    doc.insertParagraph(); expect(labels(doc)).toEqual(['1.', '1.1.', null]);
    doc.undo(); expect(labels(doc)).toEqual(['1.', '1.1.', '2.']);
    doc.undo(); expect(labels(doc)).toEqual(['1.', '1.1.', '1.2.']);
  });
  it('restarts a nested sequence without changing ancestor numbers or the following shallower sequence', async () => {
    const pkg = await fixture(), doc = docOf(pkg); doc.select(indexed(doc, 3)); doc.restartNumbering();
    expect(labels(doc).slice(0, 7)).toEqual(['3.', '4.', '4.a)', '4.a)', '5.', '7.', '8.']);
    expect(labels(docOf(await DocxPackage.open(await exportDoc(pkg, doc))))).toEqual(labels(doc));
    doc.undo(); expect(labels(doc)[3]).toBe('4.b)');
  });
  it('changes selected levels and restarts the remaining contiguous list without touching another instance', async () => {
    const doc = docOf(await fixture()); doc.select(indexed(doc, 1));
    const before = doc.snapshot(); doc.restartNumbering();
    expect(labels(doc).slice(0, 7)).toEqual(['3.', '1.', '1.a)', '1.b)', '2.', '7.', '8.']);
    expect(doc.history).toHaveLength(1); expect(doc.selection).toEqual(before.selection);
    doc.select(indexed(doc, 3)); doc.changeListLevel(1);
    expect(labels(doc).slice(1, 5)).toEqual(['1.', '1.a)', '1.a.1.', '2.']);
    expect(doc.paragraphFormatting.indentLeft).toBe(2160);
    doc.undo(); doc.undo(); expect(doc.paragraphs).toEqual(before.paragraphs); expect(doc.numbering).toEqual(before.numbering);
    doc.redo(); expect(labels(doc)[1]).toBe('1.');
  });
});

describe('numbering layout and source geometry', () => {
  it('positions markers and hanging continuations without introducing caret offsets, and paints each marker once', async () => {
    const doc = docOf(await fixture()), result = layout(doc);
    const first = result.lines[0];
    expect(first.marker).toMatchObject({ text: '3.', x: 72 });
    expect(first.stops[0]).toMatchObject({ x: 96, offset: 0 });
    expect(hitTest(result, first.page, first.marker.x, first.y + 10)).toBe(0);
    const wrapped = result.lines.filter(l => l.paragraphId === doc.paragraphs[8].id);
    expect(wrapped.length).toBeGreaterThan(1); expect(wrapped.filter(l => l.marker)).toHaveLength(1);
    expect(wrapped.every(l => l.stops[0].x === 96)).toBe(true);
    for (const line of result.lines) for (const stop of line.stops) {
      const caret = caretRect(result, stop.offset);
      expect(hitTest(result, caret.page, caret.x, caret.y + 8)).toBe(stop.offset);
    }
    expect(new Set(selectionRects(result, 0, doc.text.length).map(r => r.page)).size).toBeGreaterThan(1);
  });
  it('uses label metrics, left/center/right alignment and suffix spacing, preserving geometry after save/reopen', async () => {
    for (const alignment of ['left', 'center', 'right']) for (const suffix of ['space', 'nothing', 'tab']) {
      const doc = new TextDocument([paragraph('text')]); doc.toggleList('number');
      const level = doc.numbering.abstracts[1].levels[0]; level.alignment = alignment; level.suffix = suffix; level.markerStyle = { fontSize: 24, italic: true, underline: true };
      const before = layout(doc), line = before.lines[0];
      // Layout uses the tall label's ascent (30), then the text descent (5).
      expect(line.height).toBe(35); expect(line.marker.x).toBe(120 - { left: 0, center: 16, right: 32 }[alignment]);
      expect(line.stops[0].x).toBeGreaterThanOrEqual(line.marker.x + line.marker.width);
      const reopened = docOf(await DocxPackage.open(await exportDoc(createDocx(), doc)));
      expect(reopened.text).toBe(doc.text); expect(labels(reopened)).toEqual(labels(doc));
      expect(layout(reopened).lines[0]).toMatchObject({ marker: line.marker, y: line.y, height: line.height, stops: line.stops });
    }
  });
  it('preserves paragraph keeps, manual breaks, indent edits and undo on numbered paragraphs', () => {
    const doc = new TextDocument([paragraph('Heading'), paragraph('word '.repeat(100))], { height: 5760, top: 720, bottom: 720 });
    doc.select(0, doc.text.length); doc.toggleList('number'); doc.setParagraphFormat({ keepNext: true });
    const before = layout(doc); doc.setParagraphFormat({ indentLeft: 2160, firstLine: -720 });
    expect(doc.paragraphFormatting.indentLeft).toBe(2160); doc.undo(); expect(layout(doc)).toEqual(before);
    doc.select(3); doc.replace('\f');
    expect(layout(doc).lines.filter(l => l.paragraphId === doc.paragraphs[0].id && l.marker)).toHaveLength(1);
    expect(layout(doc).lines.find(l => l.start === 4).page).toBe(1);
  });
});

describe('numbering codec and preservation', () => {
  it('keeps every unedited package byte and preserves numbering/styles after text-only edits', async () => {
    const pkg = await fixture(), doc = docOf(pkg);
    sameParts(unzipSync(await exportDoc(pkg, doc)), pkg.parts);
    doc.replace('Edited '); const parts = unzipSync(await exportDoc(pkg, doc));
    expectBodyEditParts(parts, pkg.parts);
    const reopened = docOf(await DocxPackage.open(zipSync(parts)));
    expect(labels(reopened)).toEqual(labels(doc)); expect(reopened.text).toBe(doc.text);
    doc.undo(); sameParts(unzipSync(await exportDoc(pkg, doc)), pkg.parts);
  });
  it('preserves unused unsupported overrides when restarting an imported instance', async () => {
    const pkg = await rewrite(await fixture(), xmls => {
      const xml = xmls['word/numbering.xml'], instance = nodes(xml, 'num').find(n => n.getAttributeNS(W, 'numId') === '42');
      const override = el(xml, 'lvlOverride'); override.setAttributeNS(W, 'w:ilvl', '8');
      const level = el(xml, 'lvl'); level.setAttributeNS(W, 'w:ilvl', '8'); level.append(el(xml, 'lvlPicBulletId', '99')); override.append(level); instance.append(override);
    });
    const doc = docOf(pkg); doc.restartNumbering();
    const reopened = await DocxPackage.open(await exportDoc(pkg, doc));
    expect(labels(docOf(reopened))[0]).toBe('1.');
    const xml = new DOMParser().parseFromString(strFromU8(reopened.parts['word/numbering.xml']), 'application/xml');
    expect(nodes(xml, 'lvlPicBulletId')).toHaveLength(2); // Original plus preserved restart clone.
    doc.restartNumbering(8);
    expect(labels(docOf(await DocxPackage.open(await exportDoc(pkg, doc))))[0]).toBe('8.');
  });
  it('handles UTF-16 numbering parts and exports edits as correctly declared UTF-8', async () => {
    const pkg = await fixture(), parts = { ...pkg.parts };
    const text = strFromU8(parts['word/numbering.xml']).replace(/encoding=['"]UTF-8['"]/, 'encoding="UTF-16"');
    parts['word/numbering.xml'] = new Uint8Array(Buffer.concat([Buffer.from([255, 254]), Buffer.from(text, 'utf16le')]));
    const opened = await DocxPackage.open(zipSync(parts)), doc = docOf(opened); doc.restartNumbering();
    const reopened = docOf(await DocxPackage.open(await exportDoc(opened, doc)));
    expect(labels(reopened)[0]).toBe('1.');
  });
  it('creates a numbering part and collision-free relationship, round trips new lists and explicit removal', async () => {
    const pkg = createDocx([paragraph('One'), paragraph('Two')]);
    pkg.parts['word/_rels/document.xml.rels'] = strToU8(strFromU8(pkg.parts['word/_rels/document.xml.rels']).replace('</Relationships>', '<Relationship Id="rNumbering" Type="https://example.org/retained" Target="keep.xml"/></Relationships>'));
    const doc = docOf(pkg); doc.select(0, doc.text.length); doc.toggleList('number');
    let opened = await DocxPackage.open(await exportDoc(pkg, doc));
    expect(labels(docOf(opened))).toEqual(['1.', '2.']);
    expect(strFromU8(opened.parts['word/_rels/document.xml.rels'])).toContain('Id="rNumbering_"');
    expect(paragraphFormat(opened.paragraphs[0], opened.numbering).indentLeft).toBe(720);
    const imported = docOf(await fixture()); imported.select(0); imported.toggleList('number');
    expect(imported.paragraphs[0].list).toBeNull();
    opened = await DocxPackage.open(await exportDoc(await fixture(), imported));
    expect(docOf(opened).paragraphs[0].list).toBeNull(); expect(labels(docOf(opened))[1]).toBe('3.');
  });
  it('resolves style-level associations and direct geometry at the right precedence', async () => {
    const pkg = await rewrite(await fixture(), xmls => {
      const styles = xmls['word/styles.xml'], style = nodes(styles, 'style').find(n => n.getAttributeNS(W, 'styleId') === 'CanvasList');
      const ppr = nodes(style, 'pPr')[0], ind = el(styles, 'ind'); ind.setAttributeNS(W, 'w:left', '1080'); ppr.append(ind);
      nodes(style, 'numPr')[0].prepend(el(styles, 'ilvl', '0')); // Explicit style level, honored by the native reference.
      const main = xmls['word/document.xml'], direct = nodes(main, 'p')[2];
      const directInd = el(main, 'ind'); directInd.setAttributeNS(W, 'w:left', '1800'); nodes(direct, 'pPr')[0].append(directInd);
    });
    const doc = docOf(pkg);
    expect(doc.paragraphs[0].list.level).toBe(0);
    expect(paragraphFormat(doc.paragraphs[0], doc.numbering).indentLeft).toBe(1080);
    expect(paragraphFormat(doc.paragraphs[2], doc.numbering).indentLeft).toBe(1800);
    doc.select(0); doc.changeListLevel(1); expect(doc.paragraphFormatting.indentLeft).toBe(1440); // Direct numbering overrides style indent.
    doc.select(indexed(doc, 2)); doc.changeListLevel(1); expect(doc.paragraphFormatting.indentLeft).toBe(1800); // Direct indents still win.
  });
  it('does not infer another level from a stale paragraph-style association', async () => {
    const pkg = await rewrite(await fixture(), xmls => {
      const xml = xmls['word/numbering.xml'];
      const base = nodes(xml, 'abstractNum').find(n => n.getAttributeNS(W, 'abstractNumId') === '41');
      nodes(base, 'lvl')[1].append(el(xml, 'pStyle', 'CanvasDerivedList'));
    });
    expect(pkg.paragraphs[0].list.level).toBe(0);
    expect(pkg.paragraphs[2].list.level).toBe(1); // Explicit paragraph level still wins.
  });
  it('uses legacy numbering tabs for label suffixes without applying them to tabs within the body text', async () => {
    const pkg = await rewrite(await fixture(), xmls => {
      const xml = xmls['word/numbering.xml'];
      const base = nodes(xml, 'abstractNum').find(n => n.getAttributeNS(W, 'abstractNumId') === '41');
      nodes(base, 'tab')[0].setAttributeNS(W, 'w:pos', '1800');
      nodes(base, 'ind')[0].setAttributeNS(W, 'w:hanging', '0');
      const main = xmls['word/document.xml'], text = nodes(nodes(main, 'p')[0], 't')[0];
      text.textContent = 'a'; text.after(el(main, 'tab'), el(main, 't')); text.nextSibling.nextSibling.textContent = 'b';
    });
    const doc = docOf(pkg), first = layout(doc).lines[0];
    expect(first.stops[0].x).toBe(168); // Numbering-only tab at 1.25 inches.
    expect(first.stops.find(s => s.offset === 2).x).toBe(192); // Automatic body tab.
    doc.select(indexed(doc, 0)); doc.toggleList('number');
    const ordinary = layout(doc).lines[0];
    expect(ordinary.stops[0].x).toBe(48);
    expect(ordinary.stops.find(s => s.offset === 2).x).toBe(96);
  });
  it('serializes clears for removed numbering tab stops and retains inherited geometry after reopening', async () => {
    const pkg = await fixture(), doc = docOf(pkg); doc.select(indexed(doc, 2));
    doc.setParagraphFormat({ tabs: [] });
    const opened = await DocxPackage.open(await exportDoc(pkg, doc));
    expect(paragraphFormat(opened.paragraphs[2], opened.numbering).tabs).toEqual([]);
    expect(strFromU8(opened.parts['word/document.xml'])).toContain('w:val="clear"');
  });
  it('activates a full override child start when startOverride is declared and defaults omitted abstract starts to zero', async () => {
    const pkg = await rewrite(await fixture(), xmls => {
      const xml = xmls['word/numbering.xml'], instance = nodes(xml, 'num').find(n => n.getAttributeNS(W, 'numId') === '43'), override = nodes(instance, 'lvlOverride')[0];
      const base = nodes(xml, 'abstractNum').find(n => n.getAttributeNS(W, 'abstractNumId') === '41');
      const level = nodes(base, 'lvl')[0].cloneNode(true); nodes(level, 'start')[0].setAttributeNS(W, 'w:val', '12'); override.append(level);
      nodes(base, 'start')[0].remove();
    });
    // Independent reference controls in numbering-override-sequences establish
    // that a declared startOverride activates the child start when present.
    expect(labels(docOf(pkg)).slice(0, 7)).toEqual(['0.', '1.', '1.a)', '1.b)', '2.', '12.', '13.']);
  });
  it.each(['lvlPicBulletId', 'numFmt', 'numStyleLink'])('rejects an unsupported referenced %s before attaching an editor', async kind => {
    await expect(rewrite(await fixture(), xmls => {
      const xml = xmls['word/numbering.xml'], base = nodes(xml, 'abstractNum').find(n => n.getAttributeNS(W, 'abstractNumId') === '41');
      if (kind === 'numFmt') nodes(base, 'numFmt')[0].setAttributeNS(W, 'w:val', 'chicago');
      else if (kind === 'numStyleLink') base.append(el(xml, kind, 'Linked'));
      else nodes(base, 'lvl')[0].append(el(xml, kind, '1'));
    })).rejects.toMatchObject({ name: 'UnsupportedDocumentError' });
  });
});

it('gives a restarted list a new instance without repeating the source durable identifier', async () => {
  const CID = 'http://schemas.microsoft.com/office/word/2016/wordml/cid';
  const base = await fixture();
  const pkg = await rewrite(base, xmls => {
    const root = xmls['word/numbering.xml'].documentElement;
    root.setAttributeNS('http://www.w3.org/2000/xmlns/', 'xmlns:w16cid', CID);
    [...root.getElementsByTagNameNS(W, 'num')].forEach((num, i) => num.setAttributeNS(CID, 'w16cid:durableId', String(1000 + i)));
  });
  const doc = docOf(pkg); doc.select(indexed(doc, 3)); doc.restartNumbering();
  const saved = await exportDoc(pkg, doc);
  const numbering = new DOMParser().parseFromString(strFromU8(unzipSync(saved)['word/numbering.xml']), 'application/xml');
  const nums = [...numbering.getElementsByTagNameNS(W, 'num')];
  const ids = nums.map(num => num.getAttributeNS(CID, 'durableId')).filter(Boolean);
  expect(nums.length).toBeGreaterThan(ids.length);
  expect(new Set(ids).size).toBe(ids.length);
  expect(labels(docOf(await DocxPackage.open(saved)))).toEqual(labels(doc));
});
