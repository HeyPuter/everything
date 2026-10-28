import { beforeAll, describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import { DocxPackage, createDocx, W } from '../src/engine/docx.js';
import { TextDocument, paragraph, paragraphText, paragraphFormat } from '../src/engine/model.js';
import { layoutDocument, caretRect, hitTest } from '../src/engine/layout.js';
import { pageGeometry } from '../src/engine/page-settings.js';
import { listMarkers } from '../src/engine/numbering.js';

beforeAll(() => { const window = new JSDOM('').window; globalThis.DOMParser = window.DOMParser; globalThis.XMLSerializer = window.XMLSerializer; });
const fixture = () => DocxPackage.open(readFileSync('public/fixtures/styles.docx'));
const model = pkg => new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles);
const save = async (pkg, doc) => new Uint8Array(await pkg.export(doc.paragraphs, doc.pageSettings, doc.numbering, doc.styles).arrayBuffer());
const position = (doc, index) => doc.paragraphs.slice(0, index).reduce((n, p) => n + paragraphText(p).length + 1, 0);
const layout = doc => layoutDocument(doc.paragraphs, (text, style) => ({ width: text.length * style.fontSize * .6, ascent: style.fontSize, descent: style.fontSize / 4 }), pageGeometry(doc.pageSettings), doc.numbering);
const sameParts = (actual, expected) => { expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort()); for (const name of Object.keys(expected)) expect(Buffer.from(actual[name]).equals(Buffer.from(expected[name])), name).toBe(true); };
const docXml = pkg => new DOMParser().parseFromString(strFromU8(pkg.parts['word/document.xml']), 'application/xml');
const nodes = (xml, name) => [...xml.getElementsByTagNameNS(W, name)];

describe('paragraph styles across model, layout and DOCX', () => {
  it('imports independent style definitions and preserves every unedited part', async () => {
    const pkg = await fixture(), doc = model(pkg);
    expect(doc.paragraphStyle).toBe('CanvasHeading');
    expect(doc.paragraphs[0].runs[0]).toMatchObject({ fontSize: 20, bold: true });
    expect(doc.paragraphs[1].runs[3]).toMatchObject({ styleId: 'CanvasEmphasis', italic: true });
    expect(doc.paragraphs[2].runs[0].fontSize).toBe(24);
    sameParts(unzipSync(await save(pkg, doc)), pkg.parts);
  });
  it('applies paragraph styles without materializing inherited text properties and restores original bytes with undo', async () => {
    const pkg = await fixture(), doc = model(pkg), before = doc.snapshot();
    doc.select(2, position(doc, 1)); doc.setParagraphStyle('CanvasSubheading');
    expect(doc.paragraphs[0].runs[0].fontSize).toBe(16);
    expect(doc.paragraphs[1].styleId).toBe('CanvasBody');
    expect(doc.selection).toEqual({ anchor: 2, focus: position(doc, 1) });
    const out = await DocxPackage.open(await save(pkg, doc));
    expect(out.paragraphs[0].runs[0]).toMatchObject({ fontSize: 16, bold: true });
    expect(nodes(docXml(out), 'p')[0].getElementsByTagNameNS(W, 'sz')).toHaveLength(0);
    for (const name of Object.keys(pkg.parts)) if (name !== 'word/document.xml') expect(out.parts[name]).toEqual(pkg.parts[name]);
    doc.undo(); expect(doc.paragraphs).toEqual(before.paragraphs); sameParts(unzipSync(await save(pkg, doc)), pkg.parts);
    doc.redo(); expect(doc.paragraphs[0].runs[0].fontSize).toBe(16);
  });
  it('edits a shared base style, recomputes descendants and character toggles, and retains direct overrides', async () => {
    const pkg = await fixture(), doc = model(pkg); doc.select(position(doc, 1));
    const selection = { ...doc.selection };
    doc.editParagraphStyle('CanvasBody', { run: { fontSize: 14, italic: true }, paragraph: { spaceAfter: 8 } });
    expect(doc.paragraphs[0].runs[0]).toMatchObject({ fontSize: 20, italic: true });
    expect(doc.paragraphs[1].runs[0]).toMatchObject({ fontSize: 14, italic: true });
    expect(doc.paragraphs[1].runs[1].bold).toBe(true);
    expect(doc.paragraphs[1].runs[3].italic).toBe(false); // Character style toggles paragraph style once.
    expect(doc.paragraphs[2].runs[0].fontSize).toBe(24);
    expect(doc.paragraphs[2].format.spaceAfter).toBe(0);
    expect(doc.paragraphs[4].markFormat.fontSize).toBe(14);
    expect(doc.selection).toEqual(selection);
    const out = await DocxPackage.open(await save(pkg, doc)), reopened = model(out);
    expect(reopened.paragraphs.map(p => p.runs.map(r => [r.fontSize, r.bold, r.italic]))).toEqual(doc.paragraphs.map(p => p.runs.map(r => [r.fontSize, r.bold, r.italic])));
    expect(out.parts['word/numbering.xml']).toEqual(pkg.parts['word/numbering.xml']);
    doc.undo(); sameParts(unzipSync(await save(pkg, doc)), pkg.parts);
  });
  it('removes a style declaration to inherit its parent and retains unedited style metadata', async () => {
    const pkg = await fixture(), doc = model(pkg);
    doc.editParagraphStyle('CanvasSubheading', { run: { fontSize: null }, paragraph: { spaceAfter: null }, name: 'Renamed subheading' });
    doc.setParagraphStyle('CanvasSubheading');
    expect(doc.paragraphs[0].runs[0].fontSize).toBe(20);
    const out = await DocxPackage.open(await save(pkg, doc));
    expect(out.styles.definitions.CanvasSubheading).toMatchObject({ name: 'Renamed subheading', basedOn: 'CanvasHeading', next: 'CanvasBody' });
    expect(out.styles.definitions.CanvasSubheading.run.fontSize).toBeUndefined();
    expect(out.paragraphs[0].runs[0].fontSize).toBe(20);
    const before = new DOMParser().parseFromString(strFromU8(pkg.parts['word/styles.xml']), 'application/xml');
    const after = new DOMParser().parseFromString(strFromU8(out.parts['word/styles.xml']), 'application/xml');
    expect(new XMLSerializer().serializeToString(nodes(before, 'latentStyles')[0])).toBe(new XMLSerializer().serializeToString(nodes(after, 'latentStyles')[0]));
  });
  it('uses the next style only on Enter at a paragraph end and keeps mid-paragraph splits in the same style', async () => {
    const pkg = await fixture(), doc = model(pkg);
    doc.select(paragraphText(doc.paragraphs[0]).length); const before = doc.snapshot(); doc.insertParagraph();
    expect(doc.paragraphStyle).toBe('CanvasBody'); expect(doc.paragraphs[1].markFormat).toMatchObject({ fontSize: 11, bold: false });
    doc.replace('Body after heading'); expect(doc.paragraphs[1].runs[0]).toMatchObject({ fontSize: 11, bold: false });
    const out = model(await DocxPackage.open(await save(pkg, doc))); expect(out.paragraphs[1].runs[0]).toMatchObject({ fontSize: 11, bold: false });
    doc.undo(); doc.undo(); expect(doc.paragraphs).toEqual(before.paragraphs);
    doc.select(5); doc.insertParagraph(); expect(doc.paragraphStyle).toBe('CanvasHeading');
  });
  it('recomputes inherited list references on style changes, preserving explicit list removals and direct indents', async () => {
    const pkg = await fixture(), doc = model(pkg); doc.select(position(doc, 1));
    // ListBullet owns this fixture's bullet level; CanvasList is an unrelated
    // second reference and the engine does not activate it through inheritance.
    doc.setParagraphStyle('ListBullet'); expect(listMarkers(doc.paragraphs, doc.numbering)[1].text).toBe('•');
    doc.setParagraphFormat({ indentLeft: 2000 }); doc.setParagraphStyle('CanvasBody');
    expect(doc.paragraphs[1].list).toBeNull(); expect(doc.paragraphFormatting.indentLeft).toBe(2000);
    doc.setParagraphStyle('ListBullet'); doc.toggleList('bullet'); doc.setParagraphStyle('CanvasHeading'); doc.setParagraphStyle('ListBullet');
    expect(doc.paragraphs[1].list).toBeNull();
    const out = model(await DocxPackage.open(await save(pkg, doc))); expect(out.paragraphs[1].list).toBeNull(); expect(out.paragraphs[1].format.indentLeft).toBe(2000);
  });
  it('creates a custom style with a stable unused ID and preserves it through save/reopen and undo', async () => {
    const pkg = createDocx([paragraph('Custom heading')]), doc = model(pkg); doc.setParagraphStyle('Heading1');
    doc.createParagraphStyle('Review heading'); const id = doc.paragraphStyle;
    doc.editParagraphStyle(id, { run: { fontSize: 18, underline: true }, paragraph: { alignment: 'center' } });
    expect(doc.paragraphs[0].runs[0]).toMatchObject({ fontSize: 18, underline: true, bold: true });
    doc.select(doc.text.length); doc.insertParagraph();
    const out = model(await DocxPackage.open(await save(pkg, doc))); expect(out.styles.definitions[id]).toMatchObject({ name: 'Review heading', basedOn: 'Heading1' });
    expect(out.paragraphs[0].runs[0]).toMatchObject({ fontSize: 18, underline: true, bold: true });
    out.editParagraphStyle(id, { run: { fontSize: 22 } });
    expect(out.paragraphs[0].markFormat.fontSize).toBe(22);
    expect(out.paragraphs[1].runs).toHaveLength(0); expect(out.paragraphs[1].markFormat.fontSize).toBe(22);
    doc.undo(); doc.undo(); doc.undo(); expect(doc.paragraphStyle).toBe('Heading1'); expect(doc.styles.definitions[id]).toBeUndefined();
  });
  it('keeps selection and hit geometry when style size repaginates text, including backward mixed selections', async () => {
    const doc = model(await fixture()); const before = layout(doc), count = before.pageCount;
    doc.select(doc.text.length, position(doc, 1)); expect(doc.paragraphStyle).toBeNull();
    const range = { ...doc.selection }; doc.editParagraphStyle('CanvasBody', { run: { fontSize: 24 } });
    const result = layout(doc); expect(result.pageCount).toBeGreaterThan(count); expect(doc.selection).toEqual(range);
    for (const line of result.lines) { const caret = caretRect(result, line.start); expect(hitTest(result, caret.page, caret.x, caret.y + 2)).toBe(line.start); }
    doc.undo(); expect(layout(doc)).toEqual(before);
  });
  it('rejects cyclic style edits and invalid unused style application without changing history', async () => {
    const pkg = await fixture(), doc = model(pkg), before = doc.snapshot();
    expect(() => doc.editParagraphStyle('CanvasBody', { basedOn: 'CanvasSubheading' })).toThrow(/Cyclic/);
    expect(() => doc.editParagraphStyle('CanvasBody', { run: { fontSize: 1638.5 } })).toThrow(/font size/);
    doc.styles.definitions.Unsupported = { id: 'Unsupported', name: 'Unsupported', type: 'paragraph', basedOn: 'Normal', properties: { alignment: 'thaiDistribute' }, run: {} };
    expect(doc.paragraphStyles.find(s => s.id === 'Unsupported').error).toMatch(/alignment/);
    expect(() => doc.setParagraphStyle('Unsupported')).toThrow(/alignment/);
    expect(doc.paragraphs).toEqual(before.paragraphs); expect(doc.history).toHaveLength(0);
  });
  it('keeps direct run off overrides, new text, merged text and empty paragraph marks through later style edits', async () => {
    const pkg = await fixture(), doc = model(pkg); doc.select(0, 5); doc.setRunFormat({ bold: false });
    doc.select(5); doc.replace(' new'); doc.editParagraphStyle('CanvasHeading', { run: { fontSize: 18 } });
    expect(doc.paragraphs[0].runs[0].bold).toBe(false);
    doc.select(position(doc, 1)); doc.delete(-1); // Merge body text into heading.
    expect(doc.paragraphs[0].runs.some(r => r.text.includes('Body') && r.fontSize === 18)).toBe(true);
    const out = model(await DocxPackage.open(await save(pkg, doc)));
    expect(out.paragraphs[0].runs.map(r => [r.text, r.fontSize, r.bold])).toEqual(doc.paragraphs[0].runs.map(r => [r.text, r.fontSize, r.bold]));
  });
  it('adds a missing styles part with a collision-free relationship and preserves unrelated package data', async () => {
    const source = await fixture(), parts = { ...source.parts };
    delete parts['word/styles.xml'];
    parts['word/_rels/document.xml.rels'] = strToU8(strFromU8(parts['word/_rels/document.xml.rels']).replace(/<Relationship\b[^>]*Type="[^"]*\/styles"[^>]*\/>/, '<Relationship Id="rStyles" Type="urn:retained" Target="retained.xml"/>'));
    parts['[Content_Types].xml'] = strToU8(strFromU8(parts['[Content_Types].xml']).replace(/<Override\b[^>]*PartName="\/word\/styles.xml"[^>]*\/>/, ''));
    parts['word/retained.xml'] = strToU8('<retained/>');
    const pkg = await DocxPackage.open(zipSync(parts)), doc = model(pkg);
    doc.createParagraphStyle('Added style', ''); doc.editParagraphStyle(doc.paragraphStyle, { run: { fontSize: 18 } });
    const out = await DocxPackage.open(await save(pkg, doc));
    expect(out.paragraphs[0].runs[0].fontSize).toBe(18);
    expect(strFromU8(out.parts['word/_rels/document.xml.rels'])).toContain('Id="rStyles_"');
    expect(out.parts['word/retained.xml']).toEqual(parts['word/retained.xml']);
  });
  it('ignores mismatched basedOn types and missing explicit styles, and uses the last declared default', async () => {
    const pkg = await fixture(), parts = { ...pkg.parts };
    const xml = new DOMParser().parseFromString(strFromU8(parts['word/styles.xml']), 'application/xml');
    const definition = id => nodes(xml, 'style').find(s => s.getAttributeNS(W, 'styleId') === id);
    nodes(definition('CanvasBody'), 'basedOn')[0].setAttributeNS(W, 'w:val', 'CanvasEmphasis');
    definition('CanvasHeading').setAttributeNS(W, 'w:default', '1');
    definition('CanvasSubheading').setAttributeNS(W, 'w:default', 'on');
    parts['word/styles.xml'] = strToU8(new XMLSerializer().serializeToString(xml));
    const opened = await DocxPackage.open(zipSync(parts)), doc = model(opened);
    expect(doc.paragraphs[1].runs[0].italic).toBe(false);
    expect(doc.styles.defaultParagraph).toBe('CanvasSubheading');
    const missing = { ...parts, 'word/document.xml': strToU8(strFromU8(parts['word/document.xml']).replace('w:val="CanvasHeading"', 'w:val="MissingStyle"')) };
    const noStyle = await DocxPackage.open(zipSync(missing));
    expect(noStyle.paragraphs[0].runs[0].fontSize).toBe(noStyle.styles.defaults.run.fontSize);
    doc.setParagraphStyle(''); expect(doc.paragraphs[0].runs[0].fontSize).toBe(16);
    expect(model(await DocxPackage.open(await save(opened, doc))).paragraphs[0].runs[0].fontSize).toBe(16);
  });
  it('supports UTF-16 styles and exports edited definitions as valid UTF-8', async () => {
    const pkg = await fixture(), parts = { ...pkg.parts };
    const text = strFromU8(parts['word/styles.xml']).replace(/encoding=['"]UTF-8['"]/, 'encoding="UTF-16"');
    parts['word/styles.xml'] = new Uint8Array(Buffer.concat([Buffer.from([255, 254]), Buffer.from(text, 'utf16le')]));
    const opened = await DocxPackage.open(zipSync(parts)), doc = model(opened);
    doc.editParagraphStyle('CanvasHeading', { run: { fontSize: 18 }, name: 'Résumé heading' });
    const out = await DocxPackage.open(await save(opened, doc)); expect(out.paragraphs[0].runs[0].fontSize).toBe(18);
    expect(new TextDecoder('utf-8', { fatal: true }).decode(out.parts['word/styles.xml'])).toContain('Résumé heading');
    expect(strFromU8(out.parts['word/styles.xml'])).not.toMatch(/encoding=["']UTF-16["']/);
  });
  it('does not dirty or add history for an unchanged style dialog', async () => {
    const pkg = await fixture(), doc = model(pkg), before = doc.snapshot();
    expect(doc.editParagraphStyle('CanvasHeading', { run: {}, paragraph: {} })).toBe(false);
    expect(doc.snapshot()).toEqual(before); expect(doc.history).toHaveLength(0);
  });
});
