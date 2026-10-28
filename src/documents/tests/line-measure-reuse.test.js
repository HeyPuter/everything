// @vitest-environment jsdom
import { it, expect } from 'vitest';
import { TextDocument, paragraph, runFormat } from '../src/engine/model.js';
import { RUN_FORMAT } from '../src/engine/formatting.js';
import { underlinePattern } from '../src/engine/underlines.js';
import { layoutDocument } from '../src/engine/layout.js';
import { pageGeometry } from '../src/engine/page-settings.js';
import { LineBuilder } from '../src/engine/line-builder.js';
import { textFontStyle } from '../src/engine/font-families.js';
import { inlineSegments } from '../src/engine/images.js';
import { createCanvasMeasurer } from '../src/engine/canvas-measurer.js';

// Opening a long document measures every line: work repeated per character there is felt as a slow open.
const fixed = (text, style) => ({ width: [...text].length * (style.fontSize ?? 12) * .5, ascent: 10, descent: 3 });
const recording = () => {
  const calls = [];
  const measure = (text, style) => { calls.push([text, style]); return fixed(text, style); };
  return { calls, measure };
};
const lay = (doc, measure) => layoutDocument(doc.paragraphs, measure, pageGeometry(doc.pageSettings), doc.numbering, doc.tables);

it("builds a paragraph's last line once: fitting it already measured each of its texts", () => {
  const words = 'A short line of words.';
  const { calls, measure } = recording();
  lay(new TextDocument([paragraph(words)]), measure);
  // Every prefix of the single line is measured exactly once, in the run's one style.
  const texts = calls.filter(([text]) => text);
  expect(new Set(texts.map(([, style]) => style)).size).toBe(1);
  expect(texts.map(([text]) => text)).toEqual([...words].map((_, i) => words.slice(0, i + 1)));
  // Wrapped and edited paragraphs lay out as with a measurer that remembers nothing.
  const doc = new TextDocument([paragraph(words), paragraph('Another paragraph, wrapping onto a second line: '.repeat(6))]);
  const layout = lay(doc, measure);
  expect(layout.lines.length).toBeGreaterThan(3);
  doc.select(3); doc.replace('very ');
  const context = { fontKerning: 'auto', measureText: text => ({ width: text.length * 8 }), save() {}, restore() {} };
  const canvas = createCanvasMeasurer(context);
  expect(JSON.parse(JSON.stringify(lay(doc, canvas).lines))).toEqual(JSON.parse(JSON.stringify(lay(doc, (text, style) => createCanvasMeasurer(context)(text, style)).lines)));
});

it('measures a group of characters as the style object it copies, and keeps every span of a run', () => {
  const page = { left: 0, defaultTabStop: 720 }, format = { tabs: [], indentLeft: 0, firstLine: 0 };
  const red = textFontStyle('a', runFormat({ color: 'FF0000' }));
  const blue = textFontStyle('a', runFormat({ color: '0000FF', underline: true }));
  const sameAsRed = { ...red };
  const { calls, measure } = recording();
  const builder = new LineBuilder(0, 1000, format, page, measure, 0);
  const text = 'abcdefgh', styles = [red, red, blue, blue, sameAsRed, red, blue, red];
  [...text].forEach((c, i) => builder.add({ text: c, start: i, end: i + 1, style: styles[i] }));
  const line = builder.finish(null, true);
  // One shaping group (equal shape, different colors), measured as the first character's own style.
  expect(line.fragments.map(f => f.text)).toEqual([text]);
  expect(calls.filter(([t]) => t).every(([, style]) => style === red)).toBe(true);
  // Color changes follow the characters, whatever style object carries them.
  expect(line.fragments[0].colors.map(c => [c.value, c.x, c.width])).toEqual([['FF0000', 0, 12], ['0000FF', 12, 12], ['FF0000', 24, 12], ['0000FF', 36, 6], ['FF0000', 42, 6]]);
  expect(line.underlines.map(u => [u.x, u.width])).toEqual([[12, 12], [36, 6]]);
  expect(line.stops.map(s => s.x)).toEqual([0, 6, 12, 18, 24, 30, 36, 42, 48]);
});

it('a new shape still starts a new group after characters of an equal shape', () => {
  const page = { left: 0, defaultTabStop: 720 }, format = { tabs: [], indentLeft: 0, firstLine: 0 };
  const plain = textFontStyle('a', runFormat({})), bold = textFontStyle('a', runFormat({ bold: true }));
  const builder = new LineBuilder(0, 1000, format, page, fixed, 0);
  [plain, { ...plain }, bold, plain].forEach((style, i) => builder.add({ text: 'x', start: i, end: i + 1, style }));
  expect(builder.finish(null, true).fragments.map(f => [f.text, f.bold])).toEqual([['xx', false], ['x', true], ['x', false]]);
});

it("a canvas measurer's shared measurement is its remembered one; callers otherwise get copies", () => {
  const context = { fontKerning: 'auto', measureText: text => ({ width: text.length * 8 }), save() {}, restore() {} };
  const measure = createCanvasMeasurer(context), style = textFontStyle('a', runFormat({}));
  const shared = measure.shared('word', style);
  expect(measure.shared('word', style)).toBe(shared);
  const copy = measure('word', style);
  expect(copy).not.toBe(shared);
  expect(copy).toEqual(shared);
  copy.width = 1;
  expect(measure('word', style).width).toBe(shared.width);
});

it('segments ASCII text into the graphemes Intl.Segmenter finds', () => {
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const ascii = Array.from({ length: 128 }, (_, i) => String.fromCharCode(i)).join('');
  for (const text of [ascii, [...ascii].reverse().join(''), 'a\r\nb', '\r\r\n\n\r', 'tab\there \v page\f', '', 'one word']) {
    expect([...inlineSegments(text)]).toEqual([...segmenter.segment(text)].map(s => ({ segment: s.segment, index: s.index })));
  }
  // An object placeholder and non-ASCII text keep the full segmenter.
  expect([...inlineSegments('é￼x')].map(s => s.segment)).toEqual(['é', '￼', 'x']);
});

it('normalizes a run format in the declared property order', () => {
  const reference = run => { const result = Object.fromEntries(Object.entries(RUN_FORMAT).map(([k, v]) => [k, run?.[k] ?? v])); result.underlineStyle = underlinePattern(run); result.underline = result.underlineStyle !== 'none'; if (run?.legacyKerning !== undefined) result.legacyKerning = run.legacyKerning; return result; };
  for (const run of [undefined, {}, { bold: true, fontSize: 9, color: null, underlineStyle: 'double' }, { legacyKerning: true, kerning: 8, text: 'ignored' }]) {
    expect(JSON.stringify(runFormat(run))).toBe(JSON.stringify(reference(run)));
  }
});
