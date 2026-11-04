import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import { DocxPackage, W } from '../src/engine/docx.js';
import { TextDocument } from '../src/engine/model.js';
import { layoutDocument, font, caretRect, hitTest } from '../src/engine/layout.js';
import { pageGeometry } from '../src/engine/page-settings.js';
import { FONT_DEFAULTS, fontSlot, languageProperty, textLanguageProperty } from '../src/engine/font-families.js';
import { fontMetrics } from '../src/engine/font-metrics.js';
import { measureTextGeometry } from '../src/engine/text-geometry.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => { dom.window.close(); delete globalThis.DOMParser; delete globalThis.XMLSerializer; });
const source = readFileSync('public/fixtures/font-families.docx');
const model = p => new TextDocument(p.paragraphs, p.pageSettings, p.numbering, p.styles, p.tables, p.assets);
const save = async (p, d) => new Uint8Array(await p.export(d.paragraphs, d.pageSettings, d.numbering, d.styles, d.tables, d.assets).arrayBuffer());
const run = (d, prefix) => d.paragraphs.flatMap(p => p.runs).find(r => r.text.startsWith(prefix));
const select = (d, prefix) => { const r = run(d, prefix), at = d.text.indexOf(r.text); d.select(at, at + r.text.length); };
const formats = d => d.paragraphs.map(p => [p.markFormat, p.runs.map(r => [r.text, ...Object.keys(FONT_DEFAULTS).map(k => r[k])])]);
const sameParts = (bytes, parts, except = []) => { const out = unzipSync(bytes); expect(Object.keys(out).sort()).toEqual(Object.keys(parts).sort()); for (const [n,b] of Object.entries(parts)) if (!except.includes(n)) expect(Buffer.from(out[n]).equals(Buffer.from(b)), n).toBe(true); };
function revise(path, fn) {
  const parts = unzipSync(source), doc = new DOMParser().parseFromString(strFromU8(parts[path]), 'application/xml');
  fn(doc); parts[path] = strToU8(new XMLSerializer().serializeToString(doc)); return zipSync(parts);
}
const nodes = (doc, tag) => [...doc.getElementsByTagNameNS(W, tag)];
const measure = (text, style) => ({ ...fontMetrics(style), width: [...new Intl.Segmenter().segment(text)].length * (style.fontFamily === 'Courier New' ? 9 : style.fontFamily === 'Times New Roman' ? 7 : 6) });
const layout = d => layoutDocument(d.paragraphs, measure, pageGeometry(d.pageSettings), d.numbering, d.tables);
const geometry = d => { const l = layout(d); return { lines: l.lines.map(n => [n.page, n.x, n.y, n.baseline, n.width, n.height, n.stops, n.fragments]), widths: Object.values(l.tableWidths) }; };

it('resolves document, paragraph, character, direct, mark and numbering fonts without rewriting their source', async () => {
  const pkg = await DocxPackage.open(source), doc = model(pkg);
  expect(run(doc, 'Theme default')).toMatchObject({ fontAscii: 'Arial', fontHAnsi: 'Arial', fontEastAsia: 'Noto Sans' });
  expect(run(doc, 'Paragraph theme')).toMatchObject({ fontAscii: 'Courier New', fontHAnsi: 'Courier New' });
  expect(run(doc, 'Partial override')).toMatchObject({ fontAscii: 'Courier New', fontHAnsi: 'Times New Roman' });
  expect(run(doc, 'Character override')).toMatchObject({ fontAscii: 'Arial', fontHAnsi: 'Times New Roman' });
  expect(run(doc, 'Direct override')).toMatchObject({ fontAscii: 'Times New Roman', fontHAnsi: 'Arial' });
  expect(run(doc, 'Same declaration')).toMatchObject({ fontAscii: 'Courier New', fontHAnsi: 'Courier New' });
  expect(doc.paragraphs.find(p => !p.runs.length).markFormat.fontAscii).toBe('Courier New');
  const result = layout(doc), marker = result.lines.find(l => l.marker).marker;
  expect(marker.textParts.map(p => [p.text, p.fontFamily])).toEqual([['§', 'Arial'], ['1.', 'Courier New']]);
  sameParts(await save(pkg, doc), pkg.parts);
});

it('edits font slots independently, restores inherited theme declarations and round trips all formats', async () => {
  const pkg = await DocxPackage.open(source), doc = model(pkg), before = formats(doc);
  select(doc, 'Same declaration'); doc.setRunFormat({ fontAscii: 'Times New Roman' });
  doc.editParagraphStyle('FamilyBase', { run: { fontAscii: 'Arial' } });
  doc.editParagraphStyle('FamilyChild', { run: { fontHAnsi: null } });
  expect(run(doc, 'Same declaration')).toMatchObject({ fontAscii: 'Times New Roman', fontHAnsi: 'Courier New' });
  expect(run(doc, 'Partial override')).toMatchObject({ fontAscii: 'Arial', fontHAnsi: 'Courier New' });
  const saved = await save(pkg, doc), reopened = model(await DocxPackage.open(saved));
  expect(formats(reopened)).toEqual(formats(doc)); expect(geometry(reopened)).toEqual(geometry(doc));
  const out = new DOMParser().parseFromString(strFromU8(unzipSync(saved)['word/document.xml']), 'application/xml');
  const direct = nodes(out, 'r').find(r => r.textContent.startsWith('Same declaration')).getElementsByTagNameNS(W, 'rFonts')[0];
  expect(direct.getAttributeNS(W, 'asciiTheme')).toBeNull(); expect(direct.getAttributeNS(W, 'hAnsiTheme')).toBe('majorHAnsi');
  sameParts(saved, pkg.parts, ['word/document.xml', 'word/styles.xml']);
  doc.undo(); doc.undo(); doc.undo(); expect(formats(doc)).toEqual(before); sameParts(await save(pkg, doc), pkg.parts);
});

it('retains font declarations while typing, splitting, clearing direct formatting and undoing', async () => {
  const pkg = await DocxPackage.open(source), doc = model(pkg);
  select(doc, 'Direct override'); doc.select(doc.range[0] + 7); doc.replace('Inserted '); doc.insertParagraph();
  expect(formats(model(await DocxPackage.open(await save(pkg, doc))))).toEqual(formats(doc));
  while (doc.history.length) doc.undo();
  select(doc, 'Direct override'); doc.clearDirectTextFormatting();
  expect(run(doc, 'Direct override')).toMatchObject({ fontAscii: 'Courier New', fontHAnsi: 'Courier New' });
  expect(formats(model(await DocxPackage.open(await save(pkg, doc))))).toEqual(formats(doc));
  doc.undo(); sameParts(await save(pkg, doc), pkg.parts);
});

it('uses the same family boundaries for wrapping, intrinsic table widths and caret geometry', async () => {
  const doc = model(await DocxPackage.open(source)), result = layout(doc);
  const line = result.lines.find(l => l.fragments.some(f => f.text.startsWith('Partial override')));
  expect(line.fragments.map(f => [f.text, f.fontFamily])).toEqual([['Partial override A', 'Courier New'], ['éΩ', 'Times New Roman'], [' Á', 'Courier New'], ['😀', 'Noto Sans']]);
  for (const stop of line.stops) {
    const caret = caretRect(result, stop.offset);
    expect(hitTest(result, caret.page, caret.x, caret.y + caret.height / 2)).toBe(stop.offset);
  }
  expect(result.lines.filter(l => l.cellId).flatMap(l => l.fragments).map(f => f.fontFamily)).toContain('Courier New');
});

it('keeps graphemes intact across font and capitalization boundaries, including mixed numbering', () => {
  const style = { ...FONT_DEFAULTS, fontAscii: 'Courier New', fontHAnsi: 'Arial', fontEastAsia: 'Times New Roman', fontSize: 14, capitalization: 'smallCaps' };
  const measured = measureTextGeometry('aéÁ😀', style, measure);
  expect(measured.textParts.map(p => [p.text, p.fontFamily, p.fontSize])).toEqual([['A', 'Courier New', 11], ['É', 'Arial', 11], ['Á', 'Courier New', 14], ['😀', 'Times New Roman', 14]]);
});

it.each([['A','fontAscii'], ['é','fontHAnsi'], ['Ω','fontHAnsi'], ['漢','fontEastAsia'], ['한','fontEastAsia'], ['😀','fontEastAsia'], ['א','fontAscii'], ['ﻷ','fontAscii'], ['\ufb00','fontHAnsi']])('classifies %s using the published font-slot ranges', (text, slot) => {
  expect(fontSlot(text, FONT_DEFAULTS)).toBe(slot);
  expect(fontSlot(text, { ...FONT_DEFAULTS, cs: true })).toBe('fontCs');
});

it('honors East Asian hints, languages, charsets and the Times New Roman compatibility rule', () => {
  const s = { ...FONT_DEFAULTS, fontHint: 'eastAsia' };
  expect(fontSlot('Ω', s)).toBe('fontEastAsia'); expect(fontSlot('é', s)).toBe('fontHAnsi');
  expect(fontSlot('é', { ...s, fontEastAsiaLanguage: 'zh-TW' })).toBe('fontEastAsia');
  expect(fontSlot('Ā', { ...s, fontEastAsiaCharset: '86' })).toBe('fontEastAsia');
  expect(fontSlot('漢', { ...s, fontEastAsia: 'Times New Roman' })).toBe('fontAscii');
});

it('uses the theme relationship location and theme language, not a fixed theme path or slot name', async () => {
  const parts = unzipSync(source); parts['word/custom-font-theme.xml'] = parts['word/theme/theme1.xml']; delete parts['word/theme/theme1.xml'];
  parts['word/_rels/document.xml.rels'] = strToU8(strFromU8(parts['word/_rels/document.xml.rels']).replace('theme/theme1.xml', 'custom-font-theme.xml'));
  parts['word/settings.xml'] = strToU8(strFromU8(parts['word/settings.xml']).replace('w:val="en-US"', 'w:val="ja-JP"'));
  expect(run(await DocxPackage.open(zipSync(parts)), 'Theme default').fontAscii).toBe('Noto Sans');
});

it('quotes a family as one CSS string rather than accepting a font list or CSS syntax', () => {
  expect(font({ fontFamily: 'A", serif; "B\\C' })).toContain('"A\\", serif; \\"B\\\\C", "Canvas Noto Sans"');
});

it('round trips language edits and rejects edits to derived charsets or ambiguous empty languages', async () => {
  const pkg = await DocxPackage.open(source), doc = model(pkg);
  select(doc, 'Theme default');
  doc.setRunFormat({ fontEastAsiaLanguage: 'zh-TW', fontHint: 'eastAsia' });
  expect(formats(model(await DocxPackage.open(await save(pkg, doc))))).toEqual(formats(doc));
  const before = formats(doc), history = doc.history.length;
  expect(() => doc.setRunFormat({ fontLanguage: '' })).toThrow(/language/);
  expect(() => doc.setRunFormat({ fontEastAsiaCharset: '86' })).toThrow(/font table/);
  expect(() => doc.editParagraphStyle('FamilyBase', { run: { fontEastAsiaCharset: null } })).toThrow(/font table/);
  expect(formats(doc)).toEqual(before); expect(doc.history.length).toBe(history);
});

it('derives character sets only from owned font-table entries after a family changes', async () => {
  const pkg = await DocxPackage.open(source), doc = model(pkg);
  select(doc, 'Theme default');
  doc.setRunFormat({ fontEastAsia: 'toString' });
  expect(run(doc, 'Theme default').fontEastAsiaCharset).toBe('');
  expect(formats(model(await DocxPackage.open(await save(pkg, doc))))).toEqual(formats(doc));
  doc.undo(); sameParts(await save(pkg, doc), pkg.parts);
});

it('rejects ambiguous font markup and invalid active themes while preserving unused invalid styles', async () => {
  await expect(DocxPackage.open(revise('word/document.xml', d => { const n = nodes(d, 'rFonts')[0]; n.parentNode.append(n.cloneNode(true)); }))).rejects.toThrow(/duplicate rFonts/);
  await expect(DocxPackage.open(revise('word/document.xml', d => nodes(d, 'rFonts')[0].setAttributeNS(W, 'w:asciiTheme', 'unknown')))).rejects.toThrow(/unknown theme font/);
  const bytes = revise('word/styles.xml', d => { const s = d.createElementNS(W,'w:style'); s.setAttributeNS(W,'w:styleId','Unused'); s.setAttributeNS(W,'w:type','paragraph'); const r = d.createElementNS(W,'w:rPr'), f = d.createElementNS(W,'w:rFonts'); f.setAttributeNS(W,'w:asciiTheme','invalid'); r.append(f); s.append(r); d.documentElement.append(s); });
  const pkg = await DocxPackage.open(bytes), doc = model(pkg); sameParts(await save(pkg, doc), pkg.parts);
  expect(() => doc.setParagraphStyle('Unused')).toThrow(/unknown theme font/);
});

it('preserves whitespace font declarations through editing, reopening and exact undo',async()=>{
 const bytes=readFileSync('public/fixtures/font-name-spaces.docx');
 const pkg=await DocxPackage.open(bytes),doc=model(pkg);
 const names=p=>p.paragraphs.map(p=>p.runs.find(r=>r.text)?.fontAscii);
 const before=names(pkg);
 expect(before).toEqual(['Arial','Arial ',' Arial','  Arial  ','Times New Roman','Times New Roman ','Courier New','Courier New ','Arial  ','Arial\u00a0','Arial','Arial ']);
 doc.select(0);doc.replace('EDIT ');
 expect(names(await DocxPackage.open(await save(pkg,doc)))).toEqual(before);
 sameParts(await save(pkg,doc),pkg.parts,['word/document.xml']);
 doc.undo();sameParts(await save(pkg,doc),pkg.parts);
});

it('names the w:lang attribute for each kind of language and text (§17.3.2.20)', () => {
  for (const tag of ['ja-JP', 'zh-CN', 'zh-TW', 'ko-KR', 'yue-HK']) expect(languageProperty(tag), tag).toBe('fontEastAsiaLanguage');
  for (const tag of ['ar-SA', 'he-IL', 'fa-IR', 'ur-PK', 'th-TH', 'hi-IN', 'bn-IN', 'ta-IN']) expect(languageProperty(tag), tag).toBe('fontBidiLanguage');
  for (const tag of ['en-US', 'fr-FR', 'vi-VN', 'ru-RU', 'el-GR', 'tr-TR', '']) expect(languageProperty(tag), tag).toBe('fontLanguage');
  expect(textLanguageProperty('  日本語')).toBe('fontEastAsiaLanguage');
  expect(textLanguageProperty('「한국어」')).toBe('fontEastAsiaLanguage');
  expect(textLanguageProperty('مرحبا')).toBe('fontBidiLanguage');
  expect(textLanguageProperty('ภาษาไทย')).toBe('fontBidiLanguage');
  expect(textLanguageProperty('Привет')).toBe('fontLanguage');
  expect(textLanguageProperty('123 ')).toBe('fontLanguage');
});
