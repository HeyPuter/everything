import { it, expect } from 'vitest';
import { paragraph } from '../src/engine/model.js';
import { layoutDocument, caretRect, hitTest, selectionRects } from '../src/engine/layout.js';

const measure = text => ({ width: [...text].length * 10, ascent: 12, descent: 3 });
const page = { width: 1000, height: 400, margin: 20 };

// Hebrew typed into an ordinary run carries no w:rtl. It is still right-to-left text: its words and
// letters run from right to left, and carets and selections must follow them.
it('orders unmarked Hebrew right to left, with carets and selection on its glyphs', () => {
  const text = 'abc שלום עולם def';
  const result = layoutDocument([paragraph(text)], measure, page), line = result.lines[0];
  // abc(20-50) space(50-60), then the Hebrew words in visual order: the second word first.
  const word = (start, end) => selectionRects(result, start, end)[0];
  const first = word(4, 8), second = word(9, 13);
  expect(second.x).toBeLessThan(first.x);
  expect(first.x).toBe(110); expect(first.width).toBe(40);
  expect(second.x).toBe(60);
  // A caret after the first Hebrew letter sits at that letter's left edge, at the right of the word.
  expect(caretRect(result, 5).x).toBe(140);
  expect(hitTest(result, 0, 141, line.y + line.height / 2)).toBe(5);
  // The Latin text keeps its places on both sides.
  expect(caretRect(result, 1).x).toBe(30);
  expect(caretRect(result, 15).x).toBe(170);
  expect(line.fragments.find(f => f.text.includes('ש')).bidiDirection).toBe('rtl');
});

it('leaves paragraphs without right-to-left letters on the left-to-right path', () => {
  const line = layoutDocument([paragraph('plain text 123')], measure, page).lines[0];
  expect(line.bidi).toBeUndefined();
  expect(line.fragments.every(f => f.bidiLevel === undefined)).toBe(true);
});
