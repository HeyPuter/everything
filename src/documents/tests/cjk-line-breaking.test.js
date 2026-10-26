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
// Characters a line may not start or end with under the default East Asian line rules.
const NO_START = /^[、。，．：；？！）」』】〕〉》”’ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶーゝゞヽヾ々…‥・]/u;
const NO_END = /[（「『【〔〈《“‘]$/u;

it('continues a line with Chinese after Latin words instead of moving all of it to the next line', () => {
  expect(lines(['Words then 这是一段很长的中文句子'], 14)).toEqual(['Words then 这是一', '段很长的中文句子']);
  // Before these breaks, the Chinese moved to the next line and was split wherever the width ran out.
  expect(lines(['中文English中文'], 7)).toEqual(['中文', 'English', '中文']);
});

it.each([
  ['Japanese', '日本語の文章です。「括弧」や、句読点。が行頭に来ないことを確認します。ひらがなとカタカナ、そしてチョコレートも。'],
  ['Chinese', '他说：“我们明天见。”然后走了——没有回头……《红楼梦》是一部小说，（括号）也一样。'],
])('%s lines never start with closing punctuation or small kana nor end with opening punctuation', (_, text) => {
  for (let width = 3; width <= 30; width++) {
    const result = lines([text], width);
    expect(result.join('')).toBe(text);
    for (const line of result) expect(graphemes(line).length, `${width}: ${line}`).toBeLessThanOrEqual(width);
    for (const line of result.slice(1)) expect(line, `${width}`).not.toMatch(NO_START);
    for (const line of result.slice(0, -1)) expect(line, `${width}`).not.toMatch(NO_END);
    // A doubled dash stays together.
    result.slice(1).forEach((line, i) => expect(result[i].endsWith('—') && line.startsWith('—'), `${width}: ${result[i]}|${line}`).toBe(false));
  }
});

it('breaks ideographs across source runs and leaves Korean and Latin text to the space rules', () => {
  expect(lines(['汉字可以', '在任何两个字之间'], 5)).toEqual(['汉字可以在', '任何两个字', '之间']);
  expect(lines(['한국어는 띄어쓰기를 하므로'], 8)).toEqual(['한국어는 ', '띄어쓰기를 ', '하므로']);
  expect(dictionaryBreaks('The quick brown fox, jumps.')).toBeNull();
  expect(dictionaryBreaks('한국어 문장')).toBeNull();
  expect([...dictionaryBreaks('「括弧」や、句読点。')]).toEqual([2, 4, 6, 7, 8]);
  expect([...dictionaryBreaks('中文abc')]).toEqual([1, 2]);
  // Spaces, inline objects, hyphens, straight quotes and a doubled dash keep their own rules.
  expect(dictionaryBreaks('中 文￼字')).toBeNull();
  expect([...dictionaryBreaks('中文-"字"——字')]).toEqual([1, 8]);
});

it('sizes AutoFit cells to the widest unbreakable Chinese character group', () => {
  const page = { width: 500, height: 500, left: 0, right: 0, top: 0, bottom: 0 };
  const metrics = text => cellIntrinsicWidths({ margins: { left: 0, right: 0 }, content: [{ paragraph: paragraph('', { format: { spaceAfter: 0 }, runs: [{ text }] }), index: 0 }] }, measure, page, undefined, []);
  expect(metrics('这是中文')).toMatchObject({ min: 8, max: 32 });
  // A full stop stays with the character before it.
  expect(metrics('中文。')).toMatchObject({ min: 16, max: 24 });
});

it('wraps the independent fixture under the East Asian line rules through editing, undo and export', async () => {
  const source = readFileSync('public/fixtures/cjk-wrap.docx');
  const cases = JSON.parse(readFileSync('tests/fixtures/cjk-wrap/cases.json', 'utf8'));
  const pkg = await DocxPackage.open(source), doc = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables);
  const render = () => layoutDocument(doc.paragraphs, measure, pageGeometry(doc.pageSettings), doc.numbering, doc.tables);
  const first = render();
  cases.forEach((c, i) => {
    const p = doc.paragraphs[i * 2 + 1], text = c.runs.join(''), start = first.lines.find(l => l.paragraphId === p.id).start;
    const shown = first.lines.filter(l => l.paragraphId === p.id).map(l => text.slice(l.start - start, l.end - start));
    expect(shown.length, c.name).toBeGreaterThan(1);
    expect(shown.join(''), c.name).toBe(text);
    for (const line of shown.slice(1)) expect(line, c.name).not.toMatch(NO_START);
    for (const line of shown.slice(0, -1)) expect(line, c.name).not.toMatch(NO_END);
    if (c.name === 'korean') for (const line of shown.slice(0, -1)) expect(line, c.name).toMatch(/ $/u);
    else for (const line of shown.slice(0, -1)) expect((c.width * 4 / 3 - graphemes(line).length * 8), `${c.name}: ${line}`).toBeLessThan(16);
  });
  const at = doc.text.indexOf('汉字之间');
  doc.select(at, at); doc.replace('中文');
  expect(render()).not.toEqual(first);
  doc.undo(); expect(render()).toEqual(first);
  const saved = unzipSync(new Uint8Array(await pkg.export(doc.paragraphs, doc.pageSettings, doc.numbering, doc.styles, doc.tables, doc.assets).arrayBuffer()));
  const original = unzipSync(source);
  for (const name of Object.keys(original)) expect(Buffer.from(saved[name]).equals(Buffer.from(original[name])), name).toBe(true);
});
