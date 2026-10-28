import { it, expect } from 'vitest';
import { paragraph } from '../src/engine/model.js';
import { layoutDocument, caretRect, hitTest } from '../src/engine/layout.js';
import { canvasWordSpacing, canvasLetterSpacing } from '../src/engine/canvas-text.js';

// Canvas metrics: letter spacing follows every character, word spacing every space.
const measure = (text, style) => ({
  width: [...text].length * (16 + canvasLetterSpacing(style)) + (text.match(/[  ]/g)?.length || 0) * canvasWordSpacing(style),
  ascent: 16, descent: 4,
});
// A writing width of 200 px: twelve and a half 16 px characters.
const layout = (text, format = {}) => layoutDocument([paragraph(text, { format: { spaceAfter: 0, alignment: 'both', ...format } })], measure, { width: 220, height: 2000, margin: 10 });
const lineText = (text, line) => text.slice(line.start, line.end);
const edge = line => line.stops.at(-1).x - (line.hangingRight ? 0 : line.ignoredTrailingWidth);

it('fills justified Chinese and Japanese lines to the margin between characters', () => {
  const text = '这是一段很长的中文句子用来测试两端对齐是否正确并且每一行都应该到达右边距。';
  const result = layout(text), lines = result.lines;
  expect(lines.length).toBeGreaterThan(2);
  // Before, a line without spaces stayed ragged: twelve characters ended 8 px short of the margin.
  for (const line of lines.slice(0, -1)) expect(edge(line)).toBeCloseTo(210, 5);
  expect(edge(lines.at(-1))).toBeLessThan(210);
  // The gaps are even, and carets follow the widened characters.
  const first = lines[0], xs = first.stops.map(s => s.x), steps = xs.slice(1).map((x, i) => x - xs[i]);
  // The last character keeps its advance: nothing follows it on the line.
  for (const step of steps.slice(0, -1)) expect(step).toBeCloseTo(steps[0], 5);
  expect(steps[0]).toBeGreaterThan(16);
  const caret = caretRect(result, 5);
  expect(caret.x).toBeCloseTo(xs[5], 5);
  expect(hitTest(result, caret.page, caret.x + 1, caret.y + caret.height / 2)).toBe(5);
  const japanese = '日本語の文章です。「括弧」や、句読点が行頭に来ないことを確認します。';
  for (const line of layout(japanese).lines.slice(0, -1)) expect(edge(line), lineText(japanese, line)).toBeCloseTo(210, 5);
});

it('widens spaces and the gaps beside ideographs evenly on a mixed line, and leaves Latin words intact', () => {
  const text = 'Hi \u8fd9\u662f\u4e00\u6bb5\u5f88\u957f\u7684\u4e2d\u6587\u53e5\u5b50';
  const line = layout(text).lines[0];
  expect(lineText(text, line)).toBe(text.slice(0, 12));
  expect(edge(line)).toBeCloseTo(210, 5);
  const x = offset => line.stops.find(s => s.offset === offset).x;
  // Letters of a Latin word keep their advance; the space and each ideographic gap grow alike.
  expect(x(1) - x(0)).toBeCloseTo(16, 5);
  const space = x(3) - x(2) - 16, ideograph = x(5) - x(4) - 16;
  expect(space).toBeGreaterThan(0);
  expect(ideograph).toBeCloseTo(space, 5);
});

it('keeps final lines, left-aligned paragraphs and characters held together by the line rules natural', () => {
  const text = '这是一段很长的中文句子用来测试两端对齐';
  expect(layout(text, { alignment: 'left' }).lines.every(l => l.justificationSpacing === undefined)).toBe(true);
  const short = layout('中文。');
  expect(short.lines).toHaveLength(1);
  expect(short.lines[0].justificationSpacing).toBeUndefined();
  // A full stop stays with the character before it: no gap is widened between them.
  const stops = layout('\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341\u3002\u4e00\u4e8c\u4e09\u56db').lines[0].stops;
  const at = offset => stops.find(s => s.offset === offset).x;
  expect(at(1) - at(0)).toBeGreaterThan(16);
  expect(at(10) - at(9)).toBeCloseTo(16, 5);
});
