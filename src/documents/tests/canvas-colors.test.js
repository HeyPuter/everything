import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import { DocxPackage, createDocx } from '../src/engine/docx.js';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { layoutDocument, caretRect, selectionRects } from '../src/engine/layout.js';
import { pageGeometry } from '../src/engine/page-settings.js';
import { themeColorTransform, paintColor } from '../src/engine/colors.js';

let dom;
beforeAll(() => { dom = new JSDOM(''); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => { dom.window.close(); delete globalThis.DOMParser; delete globalThis.XMLSerializer; });
const source = readFileSync('public/fixtures/text-colors.docx');
const model = pkg => new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
const save = async (pkg, doc) => new Uint8Array(await pkg.export(doc.paragraphs, doc.pageSettings, doc.numbering, doc.styles, doc.tables, doc.assets).arrayBuffer());
const measure = (text, style) => ({ width: ([...text].length - (text.match(/AV/g)?.length || 0) / 3) * style.fontSize * 2 / 3, ascent: style.fontSize, descent: style.fontSize / 3, underlineOffset: 2, underlineThickness: 1 });
const layout = doc => layoutDocument(doc.paragraphs, measure, pageGeometry(doc.pageSettings), doc.numbering, doc.tables);
const select = (doc, text) => { const at = doc.text.indexOf(text); expect(at).toBeGreaterThanOrEqual(0); doc.select(at, at + text.length); };
const run = (doc, text) => doc.paragraphs.flatMap(p => p.runs).find(r => r.text === text);
function equalParts(actual, expected, except = []) {
  expect(Object.keys(actual)).toEqual(Object.keys(expected));
  for (const [name, bytes] of Object.entries(expected)) if (!except.includes(name)) expect(Buffer.from(actual[name]).equals(Buffer.from(bytes)), name).toBe(true);
}
const revise = (path, from, to) => { const parts = unzipSync(source); expect(strFromU8(parts[path])).toContain(from); parts[path] = strToU8(strFromU8(parts[path]).replace(from, to)); return zipSync(parts); };

it('resolves defaults, paragraph/character chains, mapped themes, tint precedence, automatic and marker colors', async () => {
  const pkg = await DocxPackage.open(source), doc = model(pkg);
  for (const [text, color] of [['Colors ', '445566'], ['red ', 'FF0000'], ['blue ', '0000FF'], ['Paragraph theme', 'C0504D'], ['Inherited theme', 'C0504D'], ['Character tint', '95B3D7'], [' shaded', '943634'], ['Automatic override', 'auto']]) expect(run(doc, text).color, text).toBe(color);
  expect(doc.paragraphs.find(p => !p.runs.length).markFormat.color).toBe('00AA00');
  const lines = layout(doc).lines; expect(lines.find(l => l.marker).marker.color).toBe('4F81BD');
  expect(lines.flatMap(l => l.underlines).map(u => u.color)).toEqual(expect.arrayContaining(['008800', '000000']));
  equalParts(unzipSync(await save(pkg, doc)), pkg.parts);
});

it('edits a selected RGB span and inherited style, retains raw theme declarations and undoes byte-exactly', async () => {
  const pkg = await DocxPackage.open(source), doc = model(pkg); select(doc, 'red '); const initial = doc.snapshot();
  doc.setRunFormat({ color: '663399' }); doc.editParagraphStyle('CanvasColorBase', { run: { color: '008844' } });
  expect(run(doc, 'Inherited theme').color).toBe('008844'); expect(run(doc, 'Automatic override').color).toBe('auto'); expect(run(doc, 'Character tint').color).toBe('95B3D7');
  const bytes = await save(pkg, doc), reopened = model(await DocxPackage.open(bytes));
  expect(reopened.paragraphs.map(p => p.runs.map(r => [r.text, r.color, r.underlineColor]))).toEqual(doc.paragraphs.map(p => p.runs.map(r => [r.text, r.color, r.underlineColor])));
  equalParts(unzipSync(bytes), pkg.parts, ['word/document.xml', 'word/styles.xml']);
  const xml = strFromU8(unzipSync(bytes)['word/styles.xml']); expect(xml).toContain('w:themeTint="99"'); expect(xml).toContain('w:themeShade="BF"');
  doc.undo(); doc.undo(); expect(doc.snapshot()).toEqual(initial); equalParts(unzipSync(await save(pkg, doc)), pkg.parts);
  doc.redo(); doc.redo(); expect(run(doc, 'red ').color).toBe('663399');
});

it('removes paragraph/character color declarations back to inheritance and preserves automatic overrides', async () => {
  const pkg = await DocxPackage.open(source), doc = model(pkg);
  doc.editCharacterStyle('CanvasColorTint', { run: { color: null } }); expect(run(doc, 'Character tint').color).toBe('445566');
  doc.editParagraphStyle('CanvasColorBase', { run: { color: null } }); expect(run(doc, 'Inherited theme').color).toBe('445566');
  const reopened = model(await DocxPackage.open(await save(pkg, doc))); expect(run(reopened, 'Character tint').color).toBe('445566'); expect(run(reopened, 'Automatic override').color).toBe('auto');
});

it('keeps shaping, pagination, caret positions, selection and repeated headers unchanged across color boundaries', async () => {
  const pkg = await DocxPackage.open(source), doc = model(pkg), original = layout(doc);
  const geometry = result => ({ pages: result.pageCount, lines: [...result.lines, ...result.repeatedLines].map(l => [l.start, l.end, l.page, l.y, l.height, l.baseline, l.stops, ...l.fragments.map(f => [f.text, f.x, f.width])]) });
  expect(original.repeatedLines.length).toBeGreaterThan(0); const at = doc.text.indexOf('Á😀');
  doc.select(1, doc.text.length - 3); doc.setRunFormat({ color: '330088' }); const after = layout(doc);
  expect(geometry(after)).toEqual(geometry(original)); expect(caretRect(after, at)).toEqual(caretRect(original, at)); expect(selectionRects(after, at, at + 4)).toEqual(selectionRects(original, at, at + 4));
  const pair = new TextDocument([paragraph('AVAV')]), before = layout(pair); pair.select(1, 3); pair.setRunFormat({ color: 'FF0000' }); const colored = layout(pair);
  expect(geometry(colored)).toEqual(geometry(before)); expect(colored.lines[0].fragments).toHaveLength(1); expect(colored.lines[0].fragments[0].colors.map(s => s.value)).toEqual(['auto', 'FF0000', 'auto']);
});

it('preserves color through Unicode typing, paragraph splitting, mixed selections and paragraph marks', async () => {
  const pkg = await DocxPackage.open(source), doc = model(pkg); select(doc, 'red '); doc.select(doc.range[1]);
  doc.setRunFormat({ color: 'abcdef' }); doc.replace('Á😀'); expect(run(doc, 'Á😀').color).toBe('ABCDEF');
  doc.insertParagraph(); doc.replace('New color'); expect(run(doc, 'New color').color).toBe('ABCDEF');
  doc.select(0, doc.text.indexOf('Paragraph theme')); expect(doc.runFormatting.color).toBeNull();
  const reopened = model(await DocxPackage.open(await save(pkg, doc))); expect(run(reopened, 'New color').color).toBe('ABCDEF');
  const empty = doc.paragraphs.find(p => !p.runs.length); let offset = 0; for (const p of doc.paragraphs) { if (p === empty) break; offset += p.runs.map(r => r.text).join('').length + 1; }
  doc.select(offset); doc.replace('Green mark'); expect(run(doc, 'Green mark').color).toBe('00AA00');
});

it('changes a themed run to an explicit RGB and a colored underline to automatic on re-enable', async () => {
  const pkg = await DocxPackage.open(source), doc = model(pkg); select(doc, ' shaded'); doc.setRunFormat({ color: '123456' });
  select(doc, ' black underline'); doc.setRunFormat({ underline: false }); doc.setRunFormat({ underline: true });
  const reopened = model(await DocxPackage.open(await save(pkg, doc))); expect(run(reopened, ' shaded').properties).not.toContain('themeShade'); expect(run(reopened, ' black underline').underlineColor).toBe('auto');
  const themed = await DocxPackage.open(revise('word/document.xml', 'w:color="000000"', 'w:color="000000" w:themeColor="accent3" w:themeTint="99"')), themedDoc = model(themed);
  expect(run(themedDoc, ' black underline').underlineColor).toBe('95B3D7'); select(themedDoc, ' black underline'); themedDoc.setRunFormat({ bold: true });
  const preserved = model(await DocxPackage.open(await save(themed, themedDoc))); expect(run(preserved, ' black underline')).toMatchObject({ bold: true, color: 'FF0000', underlineColor: '95B3D7' }); expect(run(preserved, ' black underline').properties).toContain('w:themeTint="99"');
});

it('resolves theme aliases, system lastClr, missing mapping defaults, ignored tint on RGB and none', async () => {
  for (const [attrs, expected] of [['w:val="FFFFFF" w:themeColor="text1"', '000000'], ['w:val="FFFFFF" w:themeColor="text2"', '1F497D'], ['w:val="112233" w:themeTint="00"', '112233'], ['w:val="112233" w:themeColor="none"', '112233']]) {
    const pkg = await DocxPackage.open(revise('word/document.xml', 'w:val="FF0000"', attrs)); expect(run(model(pkg), 'red ').color).toBe(expected);
  }
});

it.each(['w:val="red"', 'w:val="123"', 'w:val="auto" w:themeColor="unknown"', 'w:val="112233" w:themeTint="FFF"', 'w:val="112233" w:themeShade="-1"', 'w:themeColor="none"', 'w:themeColor="accent2"', 'w:val="112233" w:unexpected="1"'])('rejects invalid active colors before enabling editing: %s', async attrs => {
  await expect(DocxPackage.open(revise('word/document.xml', 'w:val="FF0000"', attrs))).rejects.toMatchObject({ name: 'UnsupportedDocumentError' });
});

it('rejects unresolved/external themes and unsupported active theme color spaces', async () => {
  for (const [path, from, to] of [['word/_rels/document.xml.rels', 'Target="theme/theme1.xml"', 'Target="theme/missing.xml"'], ['word/_rels/document.xml.rels', 'Target="theme/theme1.xml"', 'Target="https://invalid/theme.xml" TargetMode="External"'], ['word/theme/theme1.xml', '<a:srgbClr val="C0504D"/>', '<a:prstClr val="red"/>'], ['word/document.xml', '<w:color w:val="FF0000"/>', '<w:color w:val="FF0000"/><w:color w:val="000000"/>']]) await expect(DocxPackage.open(revise(path, from, to))).rejects.toMatchObject({ name: 'UnsupportedDocumentError' });
});

it('validates edits atomically and supports standalone authored colors', async () => {
  const pkg = createDocx([paragraph('Fresh')]), doc = model(pkg); select(doc, 'Fresh'); const initial = doc.snapshot();
  for (const color of [null, true, '#123456', 'black', '12345', 123456]) expect(() => doc.setRunFormat({ color })).toThrow();
  expect(doc.snapshot()).toEqual(initial); doc.setRunFormat({ color: 'ABCDEF', underline: true, underlineColor: 'FF0000' });
  const reopened = model(await DocxPackage.open(await save(pkg, doc))); expect(run(reopened, 'Fresh')).toMatchObject({ color: 'ABCDEF', underline: true, underlineColor: 'FF0000' });
});

it('applies lightness endpoints, tint precedence, and automatic contrast against white/dark cell backgrounds', () => {
  // Native shade-sweep C447 independently records RGB (148,54,52), not rounded HSL.
  expect(themeColorTransform('4F81BD', .6)).toBe('95B3D7'); expect(themeColorTransform('C0504D', undefined, 191 / 255)).toBe('943634');
  for (const rgb of ['000000', 'FFFFFF', '112233', '808080']) { expect(themeColorTransform(rgb, 0, .5)).toBe('FFFFFF'); expect(themeColorTransform(rgb, 1)).toBe(rgb); expect(themeColorTransform(rgb, undefined, 0)).toBe('000000'); expect(themeColorTransform(rgb, undefined, 1)).toBe(rgb); }
  expect(paintColor('auto')).toBe('#000000'); expect(paintColor('auto', '#202020')).toBe('#FFFFFF'); expect(paintColor('112233', '#202020')).toBe('#112233');
});

it('round-trips sequential style underline color edits and clearing without reviving an earlier color', async () => {
  const pkg = await DocxPackage.open(source), doc = model(pkg);
  doc.editCharacterStyle('CanvasColorTint', { run: { underline: true, underlineColor: 'ff0000' } });
  expect(run(doc, 'Character tint').underlineColor).toBe('FF0000');
  doc.editCharacterStyle('CanvasColorTint', { run: { underline: false } }); doc.editCharacterStyle('CanvasColorTint', { run: { underline: true } });
  expect(run(doc, 'Character tint').underlineColor).toBe('auto');
  let reopened = model(await DocxPackage.open(await save(pkg, doc))); expect(run(reopened, 'Character tint')).toMatchObject({ underline: true, underlineColor: 'auto' });
  doc.editCharacterStyle('CanvasColorTint', { run: { underline: null } }); reopened = model(await DocxPackage.open(await save(pkg, doc))); expect(run(reopened, 'Character tint')).toMatchObject({ underline: false, underlineColor: 'auto' });
  doc.editCharacterStyle('CanvasColorTint', { run: { underlineColor: 'FF0000' } });
  expect(run(model(await DocxPackage.open(await save(pkg, doc))), 'Character tint')).toMatchObject({ underline: false, underlineColor: 'FF0000' });
});

it('does not cache a failed mapping read across unused styles, and preserves unsupported unused colors', async () => {
  const parts = unzipSync(source), settings = strFromU8(parts['word/settings.xml']);
  parts['word/settings.xml'] = strToU8(settings.replace('</w:settings>', '<w:clrSchemeMapping w:accent1="accent3"/></w:settings>'));
  await expect(DocxPackage.open(zipSync(parts))).rejects.toMatchObject({ name: 'UnsupportedDocumentError' });
  const unused = await DocxPackage.open(revise('word/styles.xml', '</w:styles>', '<w:style w:type="character" w:styleId="UnusedColor"><w:name w:val="Unused Color"/><w:rPr><w:color w:val="auto" w:themeColor="invalid"/></w:rPr></w:style></w:styles>'));
  const doc = model(unused); select(doc, 'red '); doc.setRunFormat({ color: '112233' }); equalParts(unzipSync(await save(unused, doc)), unused.parts, ['word/document.xml']);
});

it('supports normalized theme targets, retains foreground under supported fills, and rejects gradients', async () => {
  const pkg = await DocxPackage.open(revise('word/_rels/document.xml.rels', 'Target="theme/theme1.xml"', 'Target="/word/theme/../theme/theme1.xml"')); expect(run(model(pkg), 'Paragraph theme').color).toBe('C0504D');
  const filled = await DocxPackage.open(revise('word/document.xml', '<w:color w:val="FF0000"/>', '<w:color w:val="FF0000"/><w14:textFill/>')), doc = model(filled);
  expect(run(doc, 'red ').color).toBe('FF0000'); expect(run(doc, 'red ').textFill).toBe('empty');
  equalParts(unzipSync(await save(filled, doc)), filled.parts);
  await expect(DocxPackage.open(revise('word/document.xml', '<w:color w:val="FF0000"/>', '<w:color w:val="FF0000"/><w14:textFill><w14:gradFill/></w14:textFill>'))).rejects.toMatchObject({ name: 'UnsupportedDocumentError' });
});

it('opens theme-colored and theme-font text in a package without a theme part, showing the stored values', async () => {
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  // Independently written: Word-style declarations that name both a theme slot and its resolved value.
  const docx = (run, defaults = '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:asciiTheme="minorHAnsi" w:hAnsiTheme="minorHAnsi"/>') => zipSync(Object.fromEntries(Object.entries({
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
    '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/_rels/document.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    'word/styles.xml': `<w:styles xmlns:w="${W}"><w:docDefaults><w:rPrDefault><w:rPr>${defaults}<w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>`,
    'word/document.xml': `<w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t xml:space="preserve">Plain </w:t></w:r><w:r><w:rPr>${run}</w:rPr><w:t>themed</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`,
  }).map(([k, v]) => [k, strToU8(v)])));
  const themed = '<w:rFonts w:ascii="Calibri Light" w:hAnsi="Calibri Light" w:asciiTheme="majorHAnsi" w:hAnsiTheme="majorHAnsi"/><w:color w:val="2F5496" w:themeColor="accent1" w:themeShade="BF"/>';
  const pkg = await DocxPackage.open(docx(themed), { bestEffort: true });
  expect(pkg.readOnly).not.toBe(true);
  const doc = model(pkg);
  expect(run(doc, 'themed')).toMatchObject({ color: '2F5496', fontAscii: 'Calibri Light' });
  expect(run(doc, 'Plain ').fontAscii).toBe('Calibri');
  select(doc, 'themed'); doc.setRunFormat({ bold: true });
  const reopened = model(await DocxPackage.open(await save(pkg, doc)));
  expect(run(reopened, 'themed')).toMatchObject({ bold: true, color: '2F5496', fontAscii: 'Calibri Light' });
  expect(run(reopened, 'themed').properties).toContain('w:themeColor="accent1"');
  expect(run(reopened, 'themed').properties).toContain('w:asciiTheme="majorHAnsi"');
  // A theme reference with no stored value still needs the theme.
  for (const bytes of [docx('<w:color w:themeColor="accent1"/>'), docx('', '<w:rFonts w:asciiTheme="minorHAnsi"/>')]) await expect(DocxPackage.open(bytes)).rejects.toMatchObject({ name: 'UnsupportedDocumentError' });
});
