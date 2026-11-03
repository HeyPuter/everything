import { it, expect } from 'vitest';
import { measureTextGeometry } from '../src/engine/text-geometry.js';
import { paragraph } from '../src/engine/model.js';
import { RUN_FORMAT } from '../src/engine/formatting.js';
import { layoutDocument, caretRect } from '../src/engine/layout.js';
import { pageGeometry } from '../src/engine/page-settings.js';

// A measurer that, like the browser's (shaped-carets.js), can only place carets inside the text it is
// given: a caret offset past its end is an IndexSizeError from Range.setStart.
const strict = (text, style) => {
  if (style.caretOffsets?.some(offset => offset > text.length)) throw new Error(`caret offset past "${text}"`);
  // Leading spaces get no word spacing of their own, as some native shapers do.
  const spaces = [...text.trimStart()].filter(c => c === ' ').length;
  const width = [...text].length * 6 + spaces * (style.justificationSpacing || 0);
  return { width, ascent: 10, descent: 3, ...(style.caretOffsets ? { caretAdvances: style.caretOffsets.map(offset => offset * width / text.length) } : {}) };
};

it('measures a justified fragment that starts with a space without reusing its caret offsets for the space', () => {
  const style = { ...RUN_FORMAT, fontFamily: 'Arial', fontSize: 12, justificationSpacing: 2, bidiDirection: 'rtl', caretOffsets: [0, 1, 3, 6] };
  const metrics = measureTextGeometry(' مرحبا', style, strict);
  expect(metrics.textOffsetX).toBe(2);
  expect(metrics.width).toBe(38);
  expect(metrics.caretAdvances).toHaveLength(4);
});

// Justified lines that mix Arabic, Latin and numbers reorder fragments that start with a space (the
// space before a number that ends a right-to-left run). Laying such a paragraph out threw, so it could
// be neither opened nor typed.
it('lays out a justified paragraph that mixes Arabic, Latin and numbers', () => {
  const text = ('في عام 2024 قمنا بإطلاق version 3.5 من البرنامج الجديد (beta) بنسبة 45% وهي خطوة مهمة. ').repeat(4);
  for (const rtl of [false, true]) {
    const p = paragraph(''); p.runs = [{ ...RUN_FORMAT, text, rtl }]; p.format = { ...p.format, alignment: 'both' };
    const layout = layoutDocument([p], strict, pageGeometry());
    expect(layout.lines.length).toBeGreaterThan(1);
    expect(layout.lines.at(-1).end).toBe(text.length);
  }
});

// A reordered line's last character is not its rightmost one, yet justification measured the room
// left on the line from it: right-to-left runs (w:rtl) were widened far past the right margin, off the
// page, with their carets pinned to the page edge.
it.each([
  ['Arabic', 'مرحبا بكم في هذا البرنامج الجديد الذي نقدمه اليوم لكل المستخدمين '.repeat(6)],
  ['Hebrew', 'שלום לכולם וברוכים הבאים לתוכנית החדשה שלנו שמוצגת היום לכל המשתמשים '.repeat(6)],
  ['Arabic with Latin and numbers', 'في عام 2024 قمنا بإطلاق version 3.5 من البرنامج الجديد (beta) بنسبة 45% وهي خطوة مهمة. '.repeat(4)],
])('justifies right-to-left runs to the margins (%s)', (_, text) => {
  for (const rtl of [false, true]) {
    const p = paragraph(''); p.runs = [{ ...RUN_FORMAT, text, rtl }]; p.format = { ...p.format, alignment: 'both' };
    const layout = layoutDocument([p], strict, pageGeometry()), right = 816 - 96;
    for (const line of layout.lines) {
      const end = Math.max(...line.fragments.filter(f => f.text.trim()).map(f => f.x + f.width));
      expect(end, `${rtl ? 'w:rtl' : 'unmarked'} line at ${line.start}`).toBeLessThanOrEqual(right + 1e-6);
      // Every line but the last fills the measure.
      if (line.end < text.length) expect(end, `${rtl ? 'w:rtl' : 'unmarked'} line at ${line.start}`).toBeGreaterThan(right - 1);
      for (let i = line.start; i <= line.end; i++) expect(caretRect(layout, i).x).toBeLessThanOrEqual(right + 1e-6);
    }
  }
});
