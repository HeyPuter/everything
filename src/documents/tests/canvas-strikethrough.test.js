import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import { DocxPackage, createDocx, W } from '../src/engine/docx.js';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { layoutDocument, caretRect, hitTest, selectionRects } from '../src/engine/layout.js';
import { pageGeometry } from '../src/engine/page-settings.js';
import { fontMetrics } from '../src/engine/font-metrics.js';
import { resolveStrike, strikeSpans } from '../src/engine/strikethrough.js';
import { expectBodyEditParts } from './helpers/expect-body-edit-parts.js';
let dom;
beforeAll(() => { dom = new JSDOM(''); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => { dom.window.close(); delete globalThis.DOMParser; delete globalThis.XMLSerializer; });
const source = readFileSync('public/fixtures/strikethrough.docx');
const model = pkg => new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
const save = async (pkg, doc) => new Uint8Array(await pkg.export(doc.paragraphs, doc.pageSettings, doc.numbering, doc.styles, doc.tables, doc.assets).arrayBuffer());
const measure = (text, style) => ({ ...fontMetrics(style), width: [...text].length * style.fontSize * 2 / 3 });
const layout = doc => layoutDocument(doc.paragraphs, measure, pageGeometry(doc.pageSettings), doc.numbering, doc.tables);
const select = (doc, text) => { const at = doc.text.indexOf(text); expect(at).toBeGreaterThanOrEqual(0); doc.select(at, at + text.length); };
const mode = (doc, text) => doc.paragraphs.flatMap(p => p.runs).find(r => r.text === text)?.strikethrough;
const geometry = result => ({ pages: result.pageCount, lines: [...result.lines, ...result.repeatedLines].map(l => [l.start, l.end, l.page, l.y, l.height, l.baseline, l.stops, l.fragments.map(f => [f.text, f.x, f.width]), l.strikes]), cells: result.cells.map(c => [c.page, c.x, c.y, c.width, c.height]) });
function sameParts(actual, expected, except = []) { expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort()); for (const name of Object.keys(expected)) if (!except.includes(name)) expect(Buffer.from(actual[name]).equals(Buffer.from(expected[name])), name).toBe(true); }
function revise(part, change, bytes = source) { const parts = unzipSync(bytes), xml = new DOMParser().parseFromString(strFromU8(parts[part]), 'application/xml'); change(xml); parts[part] = strToU8(new XMLSerializer().serializeToString(xml)); return zipSync(parts); }
const node = (xml, tag, val) => { const n = xml.createElementNS(W, 'w:' + tag); if (val !== undefined) n.setAttributeNS(W, 'w:val', val); return n; };
const style = (xml, id) => [...xml.getElementsByTagNameNS(W, 'style')].find(s => s.getAttributeNS(W, 'styleId') === id);

it('imports direct modes, independent off declarations, style toggles, marks, numbering and table inheritance with byte-exact preservation', async () => {
  const pkg = await DocxPackage.open(source), doc = model(pkg);
  for (const [text, expected] of [['Direct single', 'single'], ['Direct double', 'double'], ['Paragraph single', 'single'], ['Child off', 'none'], ['Character reversed', 'none'], ['Character kept', 'single'], ['Double child stays on', 'double'], ['Double direct off', 'none'], ['Switch double on single', 'double'], ['Switch single on double', 'single'], ['Single off keeps double', 'double'], ['Header double', 'double'], ['Header single', 'single']]) expect(mode(doc, text), text).toBe(expected);
  expect(doc.paragraphs[14].markFormat.strikethrough).toBe('double'); expect(layout(doc).lines.find(l => l.marker).marker.strikethrough).toBe('double'); sameParts(unzipSync(await save(pkg, doc)), pkg.parts);
});

it('switches and clears direct modes over either inherited form, removes the old XML property and restores byte-exact full undo', async () => {
  const pkg = await DocxPackage.open(source), doc = model(pkg); select(doc, 'Paragraph single'); const before = doc.snapshot(), original = layout(doc);
  doc.setRunFormat({ strikethrough: 'double' }); let out = model(await DocxPackage.open(await save(pkg, doc))); expect(mode(out, 'Paragraph single')).toBe('double');
  doc.setRunFormat({ strikethrough: 'none' }); out = model(await DocxPackage.open(await save(pkg, doc))); expect(mode(out, 'Paragraph single')).toBe('none');
  select(doc, 'Double child stays on'); doc.setRunFormat({ strikethrough: 'single' }); doc.setRunFormat({ strikethrough: 'none' });
  const bytes = await save(pkg, doc); out = model(await DocxPackage.open(bytes)); expect(mode(out, 'Double child stays on')).toBe('none'); expect(geometry(layout(out))).toEqual(geometry(layout(doc))); sameParts(unzipSync(bytes), pkg.parts, ['word/document.xml']);
  const xml = new DOMParser().parseFromString(strFromU8(unzipSync(bytes)['word/document.xml']), 'application/xml'); for (const r of xml.getElementsByTagNameNS(W, 'rPr')) expect(r.getElementsByTagNameNS(W, 'strike').length + r.getElementsByTagNameNS(W, 'dstrike').length).toBeLessThanOrEqual(1);
  doc.undo(); doc.undo(); doc.undo(); doc.undo(); expect(doc.snapshot()).toEqual(before); expect(layout(doc)).toEqual(original); sameParts(unzipSync(await save(pkg, doc)), pkg.parts);
});

it('edits and removes shared declarations, preserves direct overrides and restores each history state', async () => {
  const pkg = await DocxPackage.open(source), doc = model(pkg); const before = layout(doc);
  doc.editParagraphStyle('StrikeSingle', { run: { strikethrough: 'singleOff' } }); expect(mode(doc, 'Paragraph single')).toBe('none'); expect(mode(doc, 'Character reversed')).toBe('single'); expect(mode(doc, 'Direct single')).toBe('single');
  doc.editCharacterStyle('StrikeCharacter', { run: { strikethrough: null } }); expect(mode(doc, 'Character reversed')).toBe('none');
  doc.editParagraphStyle('StrikeOff', { run: { strikethrough: null } }); expect(mode(doc, 'Child off')).toBe('none');
  const bytes = await save(pkg, doc), out = model(await DocxPackage.open(bytes)); expect(geometry(layout(out))).toEqual(geometry(layout(doc))); sameParts(unzipSync(bytes), pkg.parts, ['word/document.xml', 'word/styles.xml']);
  doc.undo(); doc.undo(); doc.undo(); expect(layout(doc)).toEqual(before); sameParts(unzipSync(await save(pkg, doc)), pkg.parts); doc.redo(); expect(mode(doc, 'Character reversed')).toBe('single');
});

it.each([false, true])('applies character single toggles relative to document default=%s while double remains ordinary', async enabled => {
  const pkg = await DocxPackage.open(revise('word/styles.xml', xml => xml.getElementsByTagNameNS(W, 'rPrDefault')[0].firstElementChild.prepend(node(xml, 'strike', enabled ? '1' : '0')))), doc = model(pkg);
  expect(mode(doc, 'Character reversed')).toBe(enabled ? 'single' : 'none'); expect(mode(doc, 'Character kept')).toBe(enabled ? 'none' : 'single'); expect(mode(doc, 'Double child stays on')).toBe('double');
  expect(resolveStrike('double', 'double', true, enabled ? 'single' : 'none')).toBe('double');
  select(doc, 'Strikethrough Á😀'); doc.setRunFormat({ strikethrough: 'none' }); expect(mode(model(await DocxPackage.open(await save(pkg, doc))), 'Strikethrough Á😀')).toBe('none');
});

it('keeps strike changes out of shaping, wrapping, pagination, caret/selection geometry and AutoFit widths', async () => {
  const doc = model(await DocxPackage.open(source)); select(doc, 'Direct single'); const before = layout(doc), at = doc.range[0] + 3, caret = caretRect(before, at), rects = selectionRects(before, at, at + 3);
  doc.setRunFormat({ strikethrough: 'double' }); const after = layout(doc); expect(after.pageCount).toBe(before.pageCount); expect(after.tableWidths).toEqual(before.tableWidths); expect(after.lines.map(l => [l.start, l.end, l.page, l.y, l.height, l.width])).toEqual(before.lines.map(l => [l.start, l.end, l.page, l.y, l.height, l.width])); expect(caretRect(after, at)).toEqual(caret); expect(hitTest(after, caret.page, caret.x, caret.y + caret.height / 2)).toBe(at); expect(selectionRects(after, at, at + 3)).toEqual(rects);
  const p = paragraph('', { runs: [{ text: 'AV', strikethrough: 'single' }, { text: 'ATAR', strikethrough: 'double', color: 'FF0000' }] }); const line = layoutDocument([p], measure).lines[0]; expect(line.fragments).toHaveLength(1); expect(line.strikes).toHaveLength(3); expect(line.strikes.map(s => s.width)).toEqual([16, 32, 32]);
});

it('uses font strike metrics through scripts, baseline shifts and width transforms and covers tabs and trailing spaces', () => {
  for (const strikethrough of ['single', 'double']) {
    const p = paragraph('', { runs: [{ text: 'AB\tCD' + ' '.repeat(100), strikethrough, fontSize: 24, verticalAlign: 'superscript', baselineShift: 3, textScale: 150, underline: true, color: 'FF0000', highlight: 'yellow' }] }); const result = layoutDocument([p], measure), line = result.lines[0], thickness = 32 * .05 * .6, center = -32 * .322 * .6 - 32 * .35 - 4;
    expect(line.strikes.length).toBe(strikethrough === 'single' ? 3 : 6);
    for (const s of line.strikes) { expect(s.thickness).toBeCloseTo(thickness); expect(s.color).toBe('FF0000'); expect(s.highlight).toBe('yellow'); expect(s.x + s.width).toBeLessThanOrEqual(720); }
    expect(line.strikes[0].offset).toBeCloseTo(center - (strikethrough === 'double' ? thickness : 0));
    expect(Math.max(...line.strikes.map(s => s.x + s.width))).toBe(720);
  }
});

it('retains source boundaries during Unicode typing, paragraph splits/merges and mixed selections', async () => {
  const pkg = createDocx(), doc = model(pkg); doc.setRunFormat({ strikethrough: 'double' }); doc.replace('Á😀'); doc.insertParagraph(); doc.replace('Tail'); expect(doc.paragraphs.every(p => p.runs.every(r => r.strikethrough === 'double'))).toBe(true);
  doc.select(4, 5); doc.replace(''); expect(doc.text).toBe('Á😀Tail'); const before = doc.snapshot(); doc.select(0, 2); doc.setRunFormat({ strikethrough: 'single' }); doc.select(0, doc.text.length); expect(doc.runFormatting.strikethrough).toBeNull(); doc.setRunFormat({ strikethrough: 'none' }); expect(model(await DocxPackage.open(await save(pkg, doc))).runFormatting.strikethrough).toBe('none'); doc.undo(); doc.undo(); expect(doc.paragraphs).toEqual(before.paragraphs);
});

it('strikes repeated-header copies and numbering labels without changing their source hit targets', async () => {
  const doc = model(await DocxPackage.open(source)), result = layout(doc), repeat = result.repeatedLines.find(l => l.strikes.length), caret = caretRect(result, repeat.start + 2, 'forward', repeat.page);
  expect(repeat.strikes).toHaveLength(2); expect(hitTest(result, repeat.page, caret.x, caret.y + caret.height / 2)).toBe(repeat.start + 2); expect(selectionRects(result, repeat.start, repeat.start + 2).some(r => r.page === repeat.page)).toBe(true);
  const marker = result.lines.find(l => l.marker).marker; expect(strikeSpans(marker, marker, marker.x, marker.width)).toHaveLength(2);
  const pkg = createDocx([paragraph('Item')]), fresh = model(pkg); fresh.toggleList('number'); Object.values(fresh.numbering.abstracts)[0].levels[0].markerStyle.strikethrough = 'double'; expect(layout(model(await DocxPackage.open(await save(pkg, fresh)))).lines[0].marker.strikethrough).toBe('double');
});

// Give each independent DOCX round trip its own timeout on slower CI runners.
it.each(['strike', 'dstrike'].flatMap(tag => [null, 'on', 'off', 'true', 'false', '1', '0'].map(value => [tag, value])))('preserves legal %s boolean %s through editing and reopening', async (tag, value) => {
  const pkg = await DocxPackage.open(revise('word/document.xml', xml => { const n = xml.getElementsByTagNameNS(W, tag)[0]; if (value === null) n.removeAttributeNS(W, 'val'); else n.setAttributeNS(W, 'w:val', value); })), doc = model(pkg);
  doc.select(0); doc.replace('Edited ');
  const out = await DocxPackage.open(await save(pkg, doc)); expect(out.paragraphs[0].runs[0].text).toContain('Edited ');
  expectBodyEditParts(unzipSync(await save(pkg, doc)), pkg.parts);
});

const invalidStrikeDeclarations = [
  ['invalid boolean', n => n.setAttributeNS(W, 'w:val', 'yes')],
  ['duplicate declaration', n => n.after(n.cloneNode(true))],
  ['nested content', n => n.append(node(n.ownerDocument, 'b'))],
  ['unknown attribute', n => n.setAttributeNS(W, 'w:other', '1')],
  // Both forms on would need a choice of form; an off declaration beside an on one does not (tests/strike-pairs.test.js).
  ['conflicting form', n => n.after(node(n.ownerDocument, n.localName === 'strike' ? 'dstrike' : 'strike', '1'))],
];
it.each(['strike', 'dstrike'].flatMap(tag => invalidStrikeDeclarations.map(([label, change]) => [tag, label, change])))('rejects %s with %s', async (tag, label, change) => {
  await expect(DocxPackage.open(revise('word/document.xml', xml => change(xml.getElementsByTagNameNS(W, tag)[0])))).rejects.toMatchObject({ name: 'UnsupportedDocumentError' });
});

it('preserves unused invalid styles and rejects exposing them or invalid mutations atomically', async () => {
  const pkg = await DocxPackage.open(revise('word/styles.xml', xml => { const n = style(xml, 'StrikeSingle').cloneNode(true); n.setAttributeNS(W, 'w:styleId', 'InvalidStrike'); n.getElementsByTagNameNS(W, 'strike')[0].setAttributeNS(W, 'w:val', 'bad'); xml.documentElement.append(n); })), doc = model(pkg), before = doc.snapshot();
  expect(() => doc.setParagraphStyle('InvalidStrike')).toThrow(/strike/); expect(() => doc.setRunFormat({ strikethrough: 'singleOff' })).toThrow(/strikethrough/); expect(() => doc.editParagraphStyle('StrikeSingle', { run: { strikethrough: 'triple' } })).toThrow(/strikethrough/); expect(doc.snapshot()).toEqual(before); sameParts(unzipSync(await save(pkg, doc)), pkg.parts);
});

it('keeps the other inherited form when a basedOn child explicitly disables only one form', async () => {
  for (const [base, value, expected] of [['StrikeSingle', 'doubleOff', 'single'], ['StrikeDouble', 'singleOff', 'double']]) {
    const doc = model(await DocxPackage.open(source)); select(doc, 'Child off'); doc.editParagraphStyle('StrikeOff', { basedOn: base, run: { strikethrough: value } }); expect(mode(doc, 'Child off')).toBe(expected);
  }
});

it('derives single-stroke placement from the independent OS/2 tables of both bundled faces', () => {
  for (const name of ['NotoSans.ttf', 'NotoSans-Italic.ttf']) {
    const bytes = readFileSync('public/fonts/' + name), count = bytes.readUInt16BE(4); let offset;
    for (let i = 0; i < count; i++) if (bytes.toString('ascii', 12 + i * 16, 16 + i * 16) === 'OS/2') offset = bytes.readUInt32BE(20 + i * 16);
    expect(offset).toBeDefined(); const m = fontMetrics({ fontSize: 12 }); expect(m.strikeThickness).toBe(16 * bytes.readInt16BE(offset + 26) / 1000); expect(m.strikeOffset).toBe(-16 * bytes.readInt16BE(offset + 28) / 1000);
  }
});

it('rejects ambiguous or invalid generated declarations before producing an export with different semantics', async () => {
  for (const invalid of ['none', 'triple', false]) {
    const pkg = createDocx([paragraph('Generated')]), doc = model(pkg); doc.createParagraphStyle('Generated strike'); const definition = doc.styles.definitions[doc.paragraphStyle]; definition.run.strikethrough = invalid;
    expect(() => pkg.export(doc.paragraphs, doc.pageSettings, doc.numbering, doc.styles)).toThrow(/strikethrough/);
    const listPkg = createDocx([paragraph('List')]), list = model(listPkg); list.toggleList('number'); Object.values(list.numbering.abstracts)[0].levels[0].markerStyle.strikethrough = invalid;
    expect(() => layout(list)).toThrow(/strikethrough/); expect(() => listPkg.export(list.paragraphs, list.pageSettings, list.numbering, list.styles)).toThrow(/strikethrough/);
  }
});

it('matches bold strike position to independently decoded fvar, avar and MVAR data', () => {
  // Test-only reader for the formats present in the bundled fonts, derived from
  // OpenType table definitions. Runtime metrics use fixed 400/700 constants.
  for (const name of ['NotoSans.ttf', 'NotoSans-Italic.ttf']) {
    const b = readFileSync('public/fonts/' + name), u16 = at => b.readUInt16BE(at), u32 = at => b.readUInt32BE(at), f2 = at => b.readInt16BE(at) / 16384;
    const tables = {};
    for (let i = 0; i < u16(4); i++) tables[b.toString('ascii', 12 + i * 16, 16 + i * 16)] = u32(20 + i * 16);
    const axes = [], fv = tables.fvar;
    for (let i = 0; i < u16(fv + 8); i++) {
      const a = fv + u16(fv + 4) + i * u16(fv + 10), tag = b.toString('ascii', a, a + 4), min = b.readInt32BE(a + 4) / 65536, def = b.readInt32BE(a + 8) / 65536, max = b.readInt32BE(a + 12) / 65536, value = tag === 'wght' ? 700 : def;
      axes.push(value === def ? 0 : value < def ? (value - def) / (def - min) : (value - def) / (max - def));
    }
    let av = tables.avar + 8;
    for (let axis = 0; axis < axes.length; axis++) {
      const pairs = []; for (let i = 0, count = u16(av); i < count; i++) pairs.push([f2(av + 2 + i * 4), f2(av + 4 + i * 4)]); av += 2 + pairs.length * 4;
      const value = axes[axis], right = pairs.findIndex(p => p[0] >= value);
      if (pairs[right][0] === value) axes[axis] = pairs[right][1];
      else { const [a,c] = pairs[right - 1], [d,e] = pairs[right]; axes[axis] = c + (value - a) * (e - c) / (d - a); }
    }
    const mv = tables.MVAR, store = mv + u16(mv + 10), regions = store + u32(store + 2); let delta = 0, found = false;
    expect(u16(store)).toBe(1); expect(u16(regions)).toBe(axes.length);
    for (let r = 0; r < u16(mv + 8); r++) {
      const record = mv + 12 + r * u16(mv + 6); if (b.toString('ascii', record, record + 4) !== 'stro') continue;
      found = true; const outer = u16(record + 4), inner = u16(record + 6), data = store + u32(store + 8 + outer * 4), shorts = u16(data + 2), count = u16(data + 4), row = data + 6 + count * 2 + inner * (count + shorts);
      expect(shorts).toBeLessThanOrEqual(count);
      for (let i = 0; i < count; i++) {
        const region = regions + 4 + u16(data + 6 + i * 2) * axes.length * 6;
        let scalar = 1;
        axes.forEach((value, a) => { const at = region + a * 6, start = f2(at), peak = f2(at + 2), end = f2(at + 4); if (!peak) return; scalar *= value < start || value > end ? 0 : value === peak ? 1 : value < peak ? (value - start) / (peak - start) : (end - value) / (end - peak); });
        delta += scalar * (i < shorts ? b.readInt16BE(row + i * 2) : b.readInt8(row + shorts + i));
      }
    }
    expect(found).toBe(true); expect(delta).toBeGreaterThan(6); expect(delta).toBeLessThan(7);
    const expected = -16 * (b.readInt16BE(tables['OS/2'] + 28) + delta) / 1000;
    expect(fontMetrics({ fontSize: 12, bold: true, italic: name.includes('Italic') }).strikeOffset).toBeCloseTo(expected, 12);
  }
});
