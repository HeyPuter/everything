import { it, expect } from 'vitest';
import { TextDocument, paragraph, paragraphFormat } from '../src/engine/model.js';
import { setCellAlignment } from '../src/engine/table-editing.js';
import { directedRuns } from '../src/engine/script-input.js';
import { layoutDocument, hitTest, hitTestStop, selectionRects } from '../src/engine/layout.js';

// Right-to-left paragraphs (ECMA-376 Part 1 §17.3.1.6 bidi) where other commands meet them.

// §17.3.1.13 jc is read from the paragraph's leading edge: the alignment grid names sides of the cell.
it('aligns right-to-left cell text to the side of the cell the alignment grid names', () => {
  const doc = new TextDocument([paragraph('x')]);
  doc.insertTable(1, 2, 600);
  doc.setParagraphDirection(true);
  const cell = () => paragraphFormat(doc.selectedParagraphs[0], doc.numbering);
  expect(setCellAlignment(doc, { horizontal: 'right', vertical: 'top' })).toBe(true);
  // The leading edge of a right-to-left paragraph is its right one: stored as w:jc left.
  expect(cell()).toMatchObject({ bidi: true, alignment: 'left' });
  expect(doc.paragraphFormatting.alignmentSide).toBe('right');
  setCellAlignment(doc, { horizontal: 'left' });
  expect(cell().alignment).toBe('right');
  expect(doc.paragraphFormatting.alignmentSide).toBe('left');
  setCellAlignment(doc, { horizontal: 'center' });
  expect(cell().alignment).toBe('center');
  // A left-to-right cell stores the side as it is.
  doc.setParagraphDirection(false);
  setCellAlignment(doc, { horizontal: 'right' });
  expect(cell()).toMatchObject({ bidi: false, alignment: 'right' });
});

// A click on a letter puts the caret beside that letter. Where a word changes direction, the letter's
// edge is also the edge of the run beyond it, and the click put the caret there instead: clicking the
// end of "abc" in a right-to-left paragraph and typing wrote before "abc" (Unicode UAX #9 reordering).
it('a click on a letter at a direction change puts the caret beside that letter', () => {
  const measure = text => ({ width: [...text].length * 10, ascent: 12, descent: 3 });
  const texts = ['שלום abc', 'abc שלום def', 'مرحبا 123 hello world.', 'שלום (עולם) 3.14% abc-def, שלום!'];
  for (const bidi of [true, false]) for (const text of texts) {
    const p = paragraph(text, { format: { bidi } }); p.runs = directedRuns(p.runs, 0, text.length);
    const layout = layoutDocument([p], measure, { width: 1000, height: 400, margin: 20 });
    for (let i = 0; i < text.length; i++) {
      const [box] = selectionRects(layout, i, i + 1);
      for (const share of [.25, .75]) {
        const hit = hitTest(layout, box.page, box.x + box.width * share, box.y + box.height / 2);
        expect([i, i + 1], `${bidi ? 'rtl' : 'ltr'} "${text}" letter ${i} at ${share}`).toContain(hit);
      }
    }
  }
  // Typing there continues the word clicked.
  const p = paragraph('שלום abc', { format: { bidi: true } }); p.runs = directedRuns(p.runs, 0, 8);
  const layout = layoutDocument([p], measure, { width: 1000, height: 400, margin: 20 }), [c] = selectionRects(layout, 7, 8);
  expect(hitTestStop(layout, 0, c.x + c.width * .75, c.y + 5)).toMatchObject({ offset: 8, x: c.x + c.width });
});
