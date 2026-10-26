import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { unzipSync } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { paragraph, TextDocument } from '../src/engine/model.js';
import { layoutDocument } from '../src/engine/layout.js';
import { cellIntrinsicWidths } from '../src/engine/intrinsic-widths.js';
import { dictionaryBreaks } from '../src/engine/dictionary-breaks.js';
import { pageGeometry } from '../src/engine/page-settings.js';

let dom;
beforeAll(() => { dom = new JSDOM(''); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => { dom.window.close(); delete globalThis.DOMParser; delete globalThis.XMLSerializer; });
const graphemes = text => [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)];
const measure = text => ({ width: graphemes(text).length * 8, ascent: 15, descent: 5, underlineOffset: 2, underlineThickness: 1 });
// `width` is the writing width in graphemes; the page adds a 10 px margin on each side.
const layout = (runs, width) => layoutDocument([paragraph('', { format: { spaceAfter: 0 }, runs: runs.map(text => ({ text })) })], measure, { width: width * 8 + 20, height: 4000, margin: 10 });
const lines = (runs, width) => { const text = runs.join(''); return layout(runs, width).lines.map(l => text.slice(l.start, l.end)); };
const wordEnds = text => new Set([...new Intl.Segmenter(undefined, { granularity: 'word' }).segment(text)].map(s => s.index + s.segment.length));
const THAI = 'ฉันไปโรงเรียนทุกวันเพราะอยากเรียนรู้เรื่องใหม่ๆเสมอ ผมชอบกินข้าวผัดกะเพราไก่ไข่ดาวมากที่สุดในโลก';

it('breaks Thai lines between words rather than wherever the width runs out', () => {
  expect(lines([THAI], 10)).toEqual(['ฉันไป', 'โรงเรียนทุก', 'วันเพราะ', 'อยากเรียนรู้', 'เรื่องใหม่ๆ', 'เสมอ ผมชอบ', 'กินข้าวผัด', 'กะเพราไก่ไข่', 'ดาวมากที่สุด', 'ในโลก']);
});

it.each([
  ['Thai', THAI],
  ['Lao', 'ຂ້ອຍໄປໂຮງຮຽນທຸກມື້ເພາະຢາກຮຽນຮູ້ສິ່ງໃໝ່ໆສະເໝີ'],
  ['Khmer', 'ខ្ញុំទៅសាលារៀនរាល់ថ្ងៃព្រោះខ្ញុំចង់រៀនរបស់ថ្មីៗជានិច្ច'],
  ['Myanmar', 'ကျွန်တော်နေ့တိုင်းကျောင်းသွားပါတယ်'],
])('every %s line ends at a word boundary and the lines rebuild the source', (_, text) => {
  const ends = wordEnds(text);
  // Narrower lines force-split the longest word, which the next test covers.
  const longest = Math.max(...[...new Intl.Segmenter(undefined, { granularity: 'word' }).segment(text)].map(s => graphemes(s.segment).length));
  for (let width = longest; width <= 40; width++) {
    const result = lines([text], width);
    expect(result.join('')).toBe(text);
    let offset = 0;
    for (const line of result) { offset += line.length; expect(ends.has(offset), `${width}: ${line}`).toBe(true); }
    for (const line of result.slice(1)) expect(line, `${width}`).not.toMatch(/^[\p{M}ะาำๅະາຳ]/u);
    for (const line of result.slice(0, -1)) expect(line, `${width}`).not.toMatch(/[เ-ไເ-ໄ]$/u);
  }
});

it('treats a Thai word split across source runs as one word', () => {
  const runs = ['วันนี้ฉันไปโรงเ', 'รียนแต่เช้า'];
  for (let width = 6; width <= 20; width++) {
    const result = lines(runs, width);
    expect(result.join('')).toBe(runs.join(''));
    let offset = 0;
    for (const line of result.slice(0, -1)) { offset += line.length; expect(offset, `${width}`).not.toBe(runs[0].length); }
  }
});

it('adds no break beside punctuation, spaces or Latin text, nor in paragraphs without these scripts', () => {
  expect(dictionaryBreaks('The quick brown fox, jumps.')).toBeNull();
  expect(dictionaryBreaks('ไทย')).toBeNull();
  expect([...dictionaryBreaks('ไทย, ไทยไทย Python ภาษาไทย.')]).toEqual([8, 23]);
  expect(dictionaryBreaks('ใหม่ๆ ฯลฯ')).toBeNull();
  // "ไทย," keeps its comma; a line never begins with it.
  expect(lines(['ภาษาไทย, ภาษาไทย'], 5)).toEqual(['ภาษา', 'ไทย, ', 'ภาษา', 'ไทย']);
});

it('keeps Thai vowels with their consonant when an overlong word must be split', () => {
  // A leading vowel stays at the start of its syllable; a following vowel does not start a line.
  expect(lines(['โรงเรียน'], 4)).toEqual(['โรง', 'เรียน']);
  expect(lines(['กะเพรา'], 3)).toEqual(['กะ', 'เพ', 'รา']);
  // Each line still makes progress when only one grapheme fits.
  expect(lines(['เเเ'], 1)).toEqual(['เ', 'เ', 'เ']);
  // A manual line break or tab after a leading vowel is not a forced break.
  expect(lines(['กเ\vข'], 4)).toEqual(['กเ', 'ข']);
  expect(lines(['กเ\tข'], 2)).toEqual(['กเ', '\t', 'ข']);
});

it('sizes AutoFit cells to the widest Thai word rather than the whole sentence', () => {
  const p = paragraph('', { format: { spaceAfter: 0 }, runs: [{ text: 'ฉันไปโรงเรียน' }] }), page = { width: 500, height: 500, left: 0, right: 0, top: 0, bottom: 0 };
  const metrics = cellIntrinsicWidths({ margins: { left: 0, right: 0 }, content: [{ paragraph: p, index: 0 }] }, measure, page, undefined, []);
  expect(metrics.min).toBe(7 * 8);
  expect(metrics.max).toBe(11 * 8);
});

it('wraps the independent fixture on word boundaries through editing, undo and export', async () => {
  const source = readFileSync('public/fixtures/thai-wrap.docx');
  const cases = JSON.parse(readFileSync('tests/fixtures/thai-wrap/cases.json', 'utf8'));
  const pkg = await DocxPackage.open(source), doc = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables);
  const render = () => layoutDocument(doc.paragraphs, measure, pageGeometry(doc.pageSettings), doc.numbering, doc.tables);
  const first = render();
  cases.forEach((c, i) => {
    const p = doc.paragraphs[i * 2 + 1], text = c.runs.join(''), ends = wordEnds(text);
    const offsets = first.lines.filter(l => l.paragraphId === p.id).map(l => l.end - l.start);
    expect(offsets.length, c.name).toBeGreaterThan(1);
    let offset = 0;
    for (const length of offsets) { offset += length; expect(ends.has(offset), `${c.name} ${offset}`).toBe(true); }
    expect(offset).toBe(text.length);
  });
  const at = doc.text.indexOf('ไปโรงเรียน');
  doc.select(at, at); doc.replace('ก็');
  expect(render()).not.toEqual(first);
  doc.undo(); expect(render()).toEqual(first);
  const saved = unzipSync(new Uint8Array(await pkg.export(doc.paragraphs, doc.pageSettings, doc.numbering, doc.styles, doc.tables, doc.assets).arrayBuffer()));
  const original = unzipSync(source);
  for (const name of Object.keys(original)) expect(Buffer.from(saved[name]).equals(Buffer.from(original[name])), name).toBe(true);
});

it('counts and proofs the fixture\'s Thai, Lao and mixed text by word, across runs', async () => {
  const { countWords } = await import('../src/core/text.js');
  const { proofingText, wordsToCheck } = await import('../src/lib/spelling.js');
  const pkg = await DocxPackage.open(readFileSync('public/fixtures/thai-wrap.docx'));
  const cases = JSON.parse(readFileSync('tests/fixtures/thai-wrap/cases.json', 'utf8'));
  const segmenterWords = text => [...new Intl.Segmenter(undefined, { granularity: 'word' }).segment(text)].filter(s => s.isWordLike).length;
  for (const c of cases) {
    const text = c.runs.join('');
    // Spaces still separate words; inside a run of these scripts the segmenter's words are counted.
    expect(countWords(text), c.name).toBe(text.split(/\s+/).filter(Boolean).reduce((n, token) => n + (/[\p{Script=Thai}\p{Script=Lao}]/u.test(token) ? Math.max(1, segmenterWords(token)) : 1), 0));
  }
  const split = cases.find(c => c.name === 'split-run');
  expect(countWords(split.runs.join(''))).toBe(segmenterWords(split.runs.join('')));
  const text = pkg.paragraphs.map(p => p.runs.map(r => r.text).join('')).join('\n');
  const checked = wordsToCheck(proofingText(text, pkg.paragraphs)).map(w => w.word);
  expect(checked.some(w => /[\p{Script=Thai}\p{Script=Lao}]/u.test(w))).toBe(false);
  expect(checked).toEqual(expect.arrayContaining(['Python', 'JavaScript']));
});
